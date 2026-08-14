//! Meeting-window auto-detection — a port of Snack Record's `MeetingReminderMonitor`
//! from the retired capture prototype into Snack Meet's Rust backend.
//!
//! This module detects meetings by combining meeting-app window transitions with a scoped
//! ScreenCaptureKit audio-activity probe. It does NOT persist probe audio — Snack Meet's own
//! capture pipeline handles recording. When a meeting starts (or ends), it emits Tauri
//! events and lets the frontend drive `start_recording` / `stop_recording` and summarization.
//!
//! Key porting decisions vs the original Objective-C:
//!   * A candidate-window-scoped SCStream probe can confirm a meeting after sustained audio.
//!     A delayed window-only fallback still supports silent, muted, and one-person meetings.
//!   * `isOnScreen` is intentionally ignored for dedicated meeting apps (the 腾讯会议 fix):
//!     SCShareableContent reports isOnScreen=0 mid-meeting for some apps. Home/launcher
//!     windows are rejected by title + size instead.
//!   * Confirmation dialogs are shown by the frontend for starts. When an active
//!     meeting window remains absent for several polls, recording stops automatically.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cidre::{core_audio as ca, ns, os, sc};
use serde::Serialize;
use tauri::{async_runtime::Mutex, AppHandle, Emitter, Manager, Runtime, State};
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::meeting_audio_probe::{self, AudioProbeHandle};

// Detector polling must never keep a microphone input stream open. Idle
// detection only queries process/window metadata; once a candidate or active
// recording exists we temporarily use the faster cadence needed for prompt/stop
// responsiveness.
const ACTIVE_POLL_INTERVAL: Duration = Duration::from_millis(800);
const EVENT_DRIVEN_IDLE_INTERVAL: Duration = Duration::from_secs(30);
const POLLING_FALLBACK_INTERVAL: Duration = Duration::from_millis(2_500);
const START_COOLDOWN: Duration = Duration::from_secs(600); // 10 min after a declined start prompt
const STOP_COOLDOWN: Duration = Duration::from_secs(10); // short gap after a recording ends
const MICROPHONE_END_STABLE_POLLS: u8 = 8; // ~6.4s; protects muted meetings without window access
const GENERIC_MICROPHONE_END_STABLE_POLLS: u8 = 5; // ~4s for sessions with no meeting window
const MEETING_WINDOW_END_STABLE_POLLS: u8 = 4; // ~3.2s; a missing meeting window is high confidence
const CANDIDATE_STABLE_POLLS: u8 = 1;
// A known meeting app may confirm quickly, but a generic microphone client
// needs to stay active long enough to rule out permission checks, camera setup,
// push-to-talk, and other short-lived input sessions.
const MEETING_APP_MICROPHONE_POLLS: u8 = 2;
const GENERIC_MICROPHONE_POLLS: u8 = 8;
const AUDIO_TRIGGER_MS: u64 = 1_000;
const SILENT_FALLBACK_POLLS: u8 = 8;
// Voice input methods are not meetings. Typeless and WeChat Input Method must
// never become microphone-triggered recording candidates. The WeChat bundle
// spelling differs by distribution/version, so use the stable Tencent input
// method prefixes rather than one exact bundle id.
const MICROPHONE_WHITELIST_PREFIXES: &[&str] = &[
    "now.typeless",
    "com.tencent.inputmethod.wetype",
    "com.tencent.WeChatInputMethod",
    "com.tencent.WXInputMethod",
    "com.tencent.weixin.inputmethod",
];
const MICROPHONE_INFRASTRUCTURE_PREFIXES: &[&str] = &[
    "com.apple.CoreSpeech",
    "com.apple.SpeechRecognitionCore",
    "com.apple.speechrecognitiond",
    "com.apple.assistant",
    "com.apple.avconferenced",
    "com.apple.audio.AudioComponentRegistrar",
];
const SELF_BUNDLE_ROOTS: &[&str] = &["com.meetily.ai"];
// Voice-messaging apps use the microphone both for live calls AND for short,
// hold-to-talk voice messages. Requiring sustained mic use (~5 s) lets us detect
// the former while ignoring the latter. Each poll is ~0.8 s apart.
const VOICE_CALL_MIN_POLLS: u8 = 6;

/// Apps the detector watches, with their display names (main.m:2018).
const MONITORED: &[(&str, &str)] = &[
    ("com.tencent.wwmapp", "企业微信"),
    ("com.electron.lark", "飞书"),
    ("com.bytedance.ee.lark", "飞书"),
    ("com.tencent.meeting", "腾讯会议"),
    ("com.tencent.wemeet", "腾讯会议"),
    ("us.zoom.xos", "Zoom"),
    ("com.apple.Safari", "浏览器会议"),
    ("com.google.Chrome", "浏览器会议"),
    ("com.microsoft.edgemac", "浏览器会议"),
    ("org.mozilla.firefox", "浏览器会议"),
    // Voice-calling apps: mic use alone also covers hold-to-talk voice messages,
    // so they are gated on sustained mic usage (VOICE_CALL_MIN_POLLS), not just any
    // mic grab. There is no dedicated in-call window to watch, so stop is signalled
    // by mic release.
    ("com.tencent.xinWeChat", "微信语音"),
    ("net.whatsapp.WhatsApp", "WhatsApp 语音"),
];

/// Apps that are watched via sustained microphone use rather than a meeting window.
/// For these the detector does not look for a window or audio-probe the window; a
/// call is confirmed only after the mic has been held for VOICE_CALL_MIN_POLLS, and
/// the recording ends when the mic is released.
const VOICE_CALL_APPS: &[&str] = &["com.tencent.xinWeChat", "net.whatsapp.WhatsApp"];

/// Browser processes use the microphone for many non-meeting features. A
/// browser is treated as a meeting app only when a meeting-like window from the
/// same browser is present at the same time.
const BROWSER_APPS: &[&str] = &[
    "com.apple.Safari",
    "com.google.Chrome",
    "com.microsoft.edgemac",
    "org.mozilla.firefox",
];

/// Dedicated meeting apps whose in-meeting window is identified by size, ignoring isOnScreen
/// (main.m:2044).
const DEDICATED: &[&str] = &["us.zoom.xos", "com.tencent.meeting", "com.tencent.wemeet"];

/// Title keywords that strongly indicate a meeting window (main.m:2289).
const KEYWORDS: &[&str] = &[
    "会议",
    "通话",
    "meeting",
    "call",
    "conference",
    "zoom",
    "teams",
    "meet",
    "钉钉",
    "webinar",
];

/// Punctuation/whitespace stripped before comparing window titles to home-title candidates
/// (main.m:2321 `normalizeTitleForComparison:`).
const TITLE_STRIP: &str = " -_·。:：.,|()[]【】（）";

#[derive(Serialize, Clone)]
pub struct MeetingDetected {
    pub bundle_id: String,
    pub app_name: String,
    pub window_title: String,
    pub trigger: String,
}

#[derive(Serialize, Clone)]
pub struct MeetingEnded {
    /// "app-exit" or "window-gone"; both stop and save automatically.
    pub reason: String,
    pub bundle_id: Option<String>,
}

#[derive(Default)]
pub struct MeetingDetector {
    pub enabled: bool,
    /// Prevents startup detections from being emitted before the webview has
    /// installed its `meeting-detected` listener (Tauri events are not queued).
    pub ui_ready: bool,
    pub recording_active: bool,
    pub recorded_bundle: Option<String>,
    pub stop_prompted_for_bundle: Option<String>,
    meeting_end_polls: u8,
    meeting_window_end_polls: u8,
    pub cooldown_until: Option<Instant>,
    candidate_signature: Option<String>,
    candidate_stable_polls: u8,
    microphone_active_polls: u8,
    cooldown_signature: Option<String>,
    audio_probe: Option<AudioProbeHandle>,
    cancel: Option<CancellationToken>,
}

impl MeetingDetector {
    fn next_poll_interval(&self, now: Instant, microphone_watcher_available: bool) -> Duration {
        let cooldown_active = self.cooldown_until.is_some_and(|until| now < until);
        if self.recording_active || (self.candidate_signature.is_some() && !cooldown_active) {
            ACTIVE_POLL_INTERVAL
        } else if microphone_watcher_available {
            EVENT_DRIVEN_IDLE_INTERVAL
        } else {
            POLLING_FALLBACK_INTERVAL
        }
    }
}

extern "C-unwind" fn microphone_activity_listener(
    _obj_id: ca::Obj,
    _number_addresses: u32,
    _addresses: *const ca::PropAddr,
    client_data: *mut (),
) -> os::Status {
    // SAFETY: `client_data` points to the boxed sender owned by
    // `MicrophoneActivityWatcher`; listeners are removed before the box is
    // reclaimed in Drop.
    let sender = unsafe { &*(client_data as *const tokio::sync::mpsc::Sender<ca::Obj>) };
    // Coalesce bursts (for example, an app creating several input streams) into
    // one detector pass. The callback must never block CoreAudio's IO thread.
    let _ = sender.try_send(_obj_id);
    os::Status::NO_ERR
}

struct MicrophoneActivityWatcher {
    receiver: tokio::sync::mpsc::Receiver<ca::Obj>,
    sender_ptr: usize,
    process_objects: Vec<ca::Obj>,
    process_states: HashMap<u32, (Option<String>, Option<u32>, bool)>,
}

impl MicrophoneActivityWatcher {
    fn new() -> Result<Self, String> {
        let (sender, receiver) = tokio::sync::mpsc::channel(64);
        let sender_ptr = Box::into_raw(Box::new(sender)) as usize;
        let client_data = sender_ptr as *mut ();
        let process_list_addr = ca::PropSelector::HW_PROCESS_OBJ_LIST.global_addr();

        if let Err(error) = ca::System::OBJ.add_prop_listener(
            &process_list_addr,
            microphone_activity_listener,
            client_data,
        ) {
            // SAFETY: registration failed, so CoreAudio cannot retain this pointer.
            unsafe {
                drop(Box::from_raw(
                    sender_ptr as *mut tokio::sync::mpsc::Sender<ca::Obj>,
                ))
            };
            return Err(format!("could not watch CoreAudio process list: {error}"));
        }

        let mut watcher = Self {
            receiver,
            sender_ptr,
            process_objects: Vec::new(),
            process_states: HashMap::new(),
        };
        watcher.refresh_process_list();
        Ok(watcher)
    }

    fn refresh_process_list(&mut self) {
        let input_addr = ca::PropSelector::PROCESS_IS_RUNNING_INPUT.global_addr();
        let client_data = self.sender_ptr as *mut ();

        for object in self.process_objects.drain(..) {
            let _ = ca::Process(object).remove_prop_listener(
                &input_addr,
                microphone_activity_listener,
                client_data,
            );
        }
        self.process_states.clear();

        for process in ca::Process::list().unwrap_or_default() {
            let object = process.0;
            if process
                .add_prop_listener(&input_addr, microphone_activity_listener, client_data)
                .is_ok()
            {
                self.process_objects.push(object);
                self.update_process_state(object);
            }
        }
    }

    fn update_process_state(&mut self, object: ca::Obj) {
        let process = ca::Process(object);
        let bundle = process.bundle_id().ok().map(|id| id.to_string());
        let pid = process.pid().ok().map(|pid| pid as u32);
        let active = process.is_running_input().unwrap_or(false);
        self.process_states.insert(object.0, (bundle, pid, active));
    }

    fn active_non_whitelisted_bundles(&self) -> Vec<String> {
        let mut active = filter_active_input_bundles(
            self.process_states
                .values()
                .filter(|(_, _, is_active)| *is_active)
                .filter(|(bundle, pid, _)| {
                    !is_self_audio_identity(bundle.as_deref(), *pid, std::process::id())
                })
                .filter_map(|(bundle, _, _)| bundle.clone())
                .collect(),
        );
        active.sort_unstable();
        active
    }

    async fn changed(&mut self) {
        let Some(first_object) = self.receiver.recv().await else {
            return;
        };
        let mut changed_objects = HashSet::from([first_object.0]);
        while let Ok(object) = self.receiver.try_recv() {
            changed_objects.insert(object.0);
        }

        // A process-list notification may introduce a new CoreAudio process.
        // Rebuild listeners and the state cache in that case. Ordinary input
        // transitions update only the process that changed, avoiding an
        // expensive query across every CoreAudio client.
        if changed_objects.contains(&ca::System::OBJ.0) {
            self.refresh_process_list();
            return;
        }
        for object_id in changed_objects {
            self.update_process_state(ca::Obj(object_id));
        }
    }
}

impl Drop for MicrophoneActivityWatcher {
    fn drop(&mut self) {
        let input_addr = ca::PropSelector::PROCESS_IS_RUNNING_INPUT.global_addr();
        let client_data = self.sender_ptr as *mut ();
        for object in self.process_objects.drain(..) {
            let _ = ca::Process(object).remove_prop_listener(
                &input_addr,
                microphone_activity_listener,
                client_data,
            );
        }
        let _ = ca::System::OBJ.remove_prop_listener(
            &ca::PropSelector::HW_PROCESS_OBJ_LIST.global_addr(),
            microphone_activity_listener,
            client_data,
        );
        // SAFETY: every listener using this pointer has been removed above.
        unsafe {
            drop(Box::from_raw(
                self.sender_ptr as *mut tokio::sync::mpsc::Sender<ca::Obj>,
            ));
        }
    }
}

#[derive(Clone, Debug)]
struct WindowInfo {
    id: u32,
    bundle: String,
    title: String,
    width: f64,
    height: f64,
}

struct DetectionCandidate {
    signature: String,
    bundle: String,
    title: String,
    window_id: Option<u32>,
    microphone_trigger: bool,
}

impl WindowInfo {
    fn signature(&self) -> String {
        format!(
            "{}:{}:{}:{:.0}x{:.0}",
            self.bundle,
            self.id,
            self.title.trim().to_lowercase(),
            self.width,
            self.height
        )
    }
}

pub type DetectorState = Arc<Mutex<MeetingDetector>>;

// ---------------------------------------------------------------------------
// Classification (pure ports of main.m helpers)
// ---------------------------------------------------------------------------

fn is_dedicated(bundle: &str) -> bool {
    DEDICATED.contains(&bundle)
}

fn is_browser(bundle: &str) -> bool {
    BROWSER_APPS.contains(&bundle)
}

fn is_monitored(bundle: &str) -> bool {
    MONITORED.iter().any(|(id, _)| *id == bundle)
}

fn is_self_bundle(bundle: &str) -> bool {
    SELF_BUNDLE_ROOTS.iter().any(|root| {
        bundle == *root
            || bundle
                .strip_prefix(root)
                .is_some_and(|suffix| suffix.starts_with('.'))
    })
}

fn is_self_audio_identity(bundle: Option<&str>, pid: Option<u32>, current_pid: u32) -> bool {
    pid == Some(current_pid) || bundle.is_some_and(is_self_bundle)
}

fn is_product_window_title(title: &str) -> bool {
    let title = title.trim().to_lowercase();
    title == "snack meet"
        || title.starts_with("snack meet ")
        || title.starts_with("snack meet-")
        || title == "meetily"
        || title.starts_with("meetily ")
        || title.starts_with("meetily-")
}

fn microphone_confirmation_polls(bundle: &str, has_meeting_window: bool) -> u8 {
    if VOICE_CALL_APPS.contains(&bundle) {
        VOICE_CALL_MIN_POLLS
    } else if is_monitored(bundle) && (!is_browser(bundle) || has_meeting_window) {
        MEETING_APP_MICROPHONE_POLLS
    } else {
        GENERIC_MICROPHONE_POLLS
    }
}

fn app_name_for(bundle: &str) -> &'static str {
    MONITORED
        .iter()
        .find(|(id, _)| *id == bundle)
        .map(|(_, name)| *name)
        .unwrap_or("会议应用")
}

fn display_name_for(bundle: &str) -> String {
    let known = app_name_for(bundle);
    if known != "会议应用" {
        return known.to_string();
    }
    if bundle == "com.apple.CoreSpeech" {
        return "系统语音输入".to_string();
    }
    ns::Workspace::shared()
        .running_apps()
        .iter()
        .find(|app| app.bundle_id().is_some_and(|id| id.to_string() == bundle))
        .and_then(|app| app.localized_name().map(|name| name.to_string()))
        .unwrap_or_else(|| "麦克风应用".to_string())
}

fn normalize_title(s: &str) -> String {
    s.chars()
        .filter(|c| !TITLE_STRIP.contains(*c))
        .collect::<String>()
        .to_lowercase()
}

fn home_titles_for(bundle: &str) -> &'static [&'static str] {
    match bundle {
        "com.tencent.wwmapp" => &["企业微信", "wechat work", "微信工作版"],
        "com.tencent.meeting" | "com.tencent.wemeet" => &["腾讯会议", "tencent meeting"],
        "us.zoom.xos" => &["zoom", "zoom meetings", "zoom workplace"],
        "com.electron.lark" | "com.bytedance.ee.lark" => &["飞书", "lark"],
        _ => &[],
    }
}

fn is_home_title(title_lower: &str, bundle: &str) -> bool {
    let trimmed = title_lower.trim();
    if trimmed.is_empty() {
        return false;
    }
    // Tencent Meeting uses the no-space Cocoa window title `TencentMeeting`
    // for its real 1280x720 in-meeting window. Do not collapse it into the
    // English launcher title `Tencent Meeting` during normalization.
    if matches!(bundle, "com.tencent.meeting" | "com.tencent.wemeet") && trimmed == "tencentmeeting"
    {
        return false;
    }
    let norm = normalize_title(trimmed);
    home_titles_for(bundle)
        .iter()
        .any(|h| normalize_title(h) == norm)
}

/// Port of `windowSuggestsMeeting:bundleIdentifier:` (main.m:2286).
fn window_suggests_meeting(bundle: &str, title: &str, width: f64, height: f64) -> bool {
    // Defense in depth: Snack Meet's main, overlay, and prompt windows must
    // never be considered meeting evidence, even if ScreenCaptureKit reports an
    // unexpected owner or the broad English `meet` keyword matches the title.
    if is_self_bundle(bundle) || is_product_window_title(title) {
        return false;
    }
    let title_lower = title.to_lowercase();
    if is_home_title(&title_lower, bundle) {
        return false;
    }
    if KEYWORDS.iter().any(|k| title_lower.contains(k)) {
        return true;
    }
    // Feishu only ever triggers via the keyword path — never via the size branch.
    let feishu = bundle == "com.electron.lark" || bundle == "com.bytedance.ee.lark";
    if feishu {
        return false;
    }
    // Tencent Meeting keeps a large desktop-sized launcher window alive after
    // a call ends. Its title can be empty or differ from the normal home title,
    // so treating every large Tencent window as a meeting prevents auto-stop.
    // The real in-meeting window is titled `TencentMeeting`; keyword titles are
    // also accepted for localized variants.
    if matches!(bundle, "com.tencent.meeting" | "com.tencent.wemeet") {
        return title_lower.trim() == "tencentmeeting";
    }
    if is_dedicated(bundle) {
        // isOnScreen deliberately ignored (腾讯会议 reports 0 mid-meeting).
        return width >= 800.0 && height >= 500.0;
    }
    false
}

// ---------------------------------------------------------------------------
// cidre: enumerate windows / running apps
// ---------------------------------------------------------------------------

/// Returns every window in the current shareable content. Empty on permission
/// error or fetch failure.
async fn fetch_windows() -> Option<Vec<WindowInfo>> {
    let content = match sc::ShareableContent::current().await {
        Ok(c) => c,
        Err(e) => {
            warn!(
                "SCShareableContent fetch failed (screen-recording permission?): {}",
                e
            );
            return None;
        }
    };
    let windows = content.windows();
    let mut out = Vec::with_capacity(windows.len());
    for win in windows.iter() {
        let title = win.title().map(|t| t.to_string()).unwrap_or_default();
        let size = win.frame().size;
        let bundle = win
            .owning_app()
            .map(|a| a.bundle_id().to_string())
            .unwrap_or_default();
        out.push(WindowInfo {
            id: win.id(),
            bundle,
            title,
            width: size.width as f64,
            height: size.height as f64,
        });
    }
    Some(out)
}

/// Bundle ids of monitored apps that are currently running (main.m:2175).
fn running_monitored_bundles() -> HashSet<String> {
    let monitored: HashSet<&str> = MONITORED.iter().map(|(id, _)| *id).collect();
    let apps = ns::Workspace::shared().running_apps();
    let mut set = HashSet::new();
    for app in apps.iter() {
        if let Some(b) = app.bundle_id() {
            let b = b.to_string();
            if monitored.contains(b.as_str()) {
                set.insert(b);
            }
        }
    }
    set
}

fn filter_active_input_bundles(active: Vec<String>) -> Vec<String> {
    active
        .into_iter()
        .filter(|bundle| {
            !is_self_bundle(bundle)
                && !MICROPHONE_WHITELIST_PREFIXES
                    .iter()
                    .any(|prefix| bundle.starts_with(prefix))
                && !MICROPHONE_INFRASTRUCTURE_PREFIXES
                    .iter()
                    .any(|prefix| bundle.starts_with(prefix))
        })
        .collect()
}

/// Bundle IDs of real applications with active input IO. Typeless is the user
/// whitelist; CoreSpeech is infrastructure rather than an attributable caller
/// and must be ignored to prevent Snack Meet's transcription from self-triggering.
fn active_non_whitelisted_input_bundles() -> Vec<String> {
    let active = ca::Process::list()
        .unwrap_or_default()
        .into_iter()
        .filter(|process| process.is_running_input().unwrap_or(false))
        .filter_map(|process| {
            let bundle = process.bundle_id().ok().map(|id| id.to_string());
            let pid = process.pid().ok().map(|pid| pid as u32);
            if is_self_audio_identity(bundle.as_deref(), pid, std::process::id()) {
                None
            } else {
                bundle
            }
        })
        .collect();
    filter_active_input_bundles(active)
}

async fn emit_meeting_ended<R: Runtime>(
    app: &AppHandle<R>,
    state: &DetectorState,
    bundle_id: &str,
    reason: &str,
) {
    let mut detector = state.lock().await;
    detector.recording_active = false;
    detector.recorded_bundle = None;
    detector.stop_prompted_for_bundle = None;
    detector.meeting_end_polls = 0;
    detector.meeting_window_end_polls = 0;
    detector.cooldown_until = Some(Instant::now() + STOP_COOLDOWN);
    drop(detector);

    info!(
        "meeting ended; emitting meeting-ended({}) bundle={}",
        reason, bundle_id
    );
    let _ = app.emit(
        "meeting-ended",
        MeetingEnded {
            reason: reason.to_string(),
            bundle_id: Some(bundle_id.to_string()),
        },
    );
}

// ---------------------------------------------------------------------------
// Poll loop + state machine
// ---------------------------------------------------------------------------

async fn poll_once<R: Runtime>(app: &AppHandle<R>, observed_input_bundles: Option<&[String]>) {
    let state = app.state::<DetectorState>();
    // Snapshot the fields we need, then release the lock before any .await.
    let (enabled, ui_ready, recording_active, recorded_bundle, cooldown) = {
        let det = state.lock().await;
        (
            det.enabled,
            det.ui_ready,
            det.recording_active,
            det.recorded_bundle.clone(),
            det.cooldown_until,
        )
    };
    if !enabled || !ui_ready {
        return;
    }

    // Without Screen Recording permission, enumerating windows via
    // SCShareableContent repeatedly triggers the system permission prompt.
    // Cache the permission once per poll and skip window enumeration when it's
    // missing, so we only do mic-based detection (which needs no permission).
    let has_screen_permission = preflight_screen_capture();

    let running = running_monitored_bundles();

    if recording_active {
        let Some(rb) = recorded_bundle.as_ref() else {
            return;
        };
        let monitored_recording = MONITORED.iter().any(|(bundle, _)| *bundle == rb);
        // Voice-calling apps have no dedicated in-call window; the call is "over"
        // when the mic is released. WeChat/WhatsApp run continuously, so "running"
        // alone cannot signal the end — we must watch mic use instead.
        let is_voice_call = VOICE_CALL_APPS.contains(&rb.as_str());
        let microphone_active = observed_input_bundles.map_or_else(
            || active_non_whitelisted_input_bundles().contains(rb),
            |bundles| bundles.iter().any(|bundle| bundle == rb),
        );

        if monitored_recording && !running.contains(rb) {
            emit_meeting_ended(app, state.inner(), rb, "app-exit").await;
            return;
        }

        // Voice calls and generic microphone-triggered sessions have no reliable
        // meeting window. Debounce microphone release instead of stopping on a
        // single CoreAudio poll.
        if is_voice_call || !monitored_recording {
            let mut detector = state.lock().await;
            detector.meeting_end_polls = if microphone_active {
                0
            } else {
                detector.meeting_end_polls.saturating_add(1)
            };
            detector.meeting_window_end_polls = 0;
            let should_stop = detector.meeting_end_polls >= GENERIC_MICROPHONE_END_STABLE_POLLS;
            drop(detector);
            if should_stop {
                emit_meeting_ended(app, state.inner(), rb, "microphone-released").await;
            }
            return;
        }

        // Keep the window and microphone debounce independent. A brief mic
        // release while muted must not accumulate with a transient window scan,
        // while a genuinely closed Tencent meeting window should stop quickly
        // even if Tencent keeps its CoreAudio input process alive.
        let meeting_window_present = if has_screen_permission {
            fetch_windows().await.map(|windows| {
                windows.iter().any(|window| {
                    &window.bundle == rb
                        && window_suggests_meeting(
                            &window.bundle,
                            &window.title,
                            window.width,
                            window.height,
                        )
                })
            })
        } else {
            None
        };
        let mut detector = state.lock().await;
        detector.meeting_end_polls = if microphone_active {
            0
        } else {
            detector.meeting_end_polls.saturating_add(1)
        };
        detector.meeting_window_end_polls = match meeting_window_present {
            Some(false) => detector.meeting_window_end_polls.saturating_add(1),
            Some(true) | None => 0,
        };
        let window_ended = detector.meeting_window_end_polls >= MEETING_WINDOW_END_STABLE_POLLS;
        // Only use microphone release by itself when window state is unavailable.
        // With a visible meeting window, mic release usually just means mute.
        let microphone_ended = meeting_window_present.is_none()
            && detector.meeting_end_polls >= MICROPHONE_END_STABLE_POLLS;
        drop(detector);
        if window_ended || microphone_ended {
            let reason = if window_ended {
                "window-gone"
            } else {
                "microphone-released"
            };
            emit_meeting_ended(app, state.inner(), rb, reason).await;
        }
        return;
    }

    // Microphone use is the primary global signal. Prefer a monitored meeting
    // app when several processes are using input; otherwise use the first
    // non-whitelisted input process (Typeless is excluded above).
    let active_input_bundles = observed_input_bundles
        .map(|bundles| bundles.to_vec())
        .unwrap_or_else(active_non_whitelisted_input_bundles);
    let microphone_bundle = active_input_bundles
        .iter()
        .find(|bundle| running.contains(bundle.as_str()))
        .or_else(|| active_input_bundles.first())
        .cloned();

    if running.is_empty() && microphone_bundle.is_none() {
        let mut det = state.lock().await;
        det.candidate_signature = None;
        det.candidate_stable_polls = 0;
        det.microphone_active_polls = 0;
        if let Some(probe) = det.audio_probe.take() {
            probe.cancel();
        }
        return;
    }
    let windows = if running.is_empty() || !has_screen_permission {
        Vec::new()
    } else {
        fetch_windows().await.unwrap_or_default()
    };
    let meeting_window = windows.iter().find(|w| {
        running.contains(&w.bundle)
            && window_suggests_meeting(&w.bundle, &w.title, w.width, w.height)
    });
    let candidate = if let Some(bundle) = microphone_bundle {
        // Do not reuse the first meeting-like window globally: when two meeting
        // apps are open, the window evidence must belong to the process that is
        // actually using the microphone.
        let scoped_window = windows.iter().find(|window| {
            window.bundle == bundle
                && window_suggests_meeting(
                    &window.bundle,
                    &window.title,
                    window.width,
                    window.height,
                )
        });
        DetectionCandidate {
            signature: format!("microphone:{bundle}"),
            title: scoped_window
                .map(|window| window.title.clone())
                .unwrap_or_default(),
            window_id: scoped_window.map(|window| window.id),
            bundle,
            microphone_trigger: true,
        }
    } else if let Some(window) = meeting_window.filter(|window| !is_browser(&window.bundle)) {
        // Browser titles are not trustworthy enough on their own: articles,
        // recordings, and ordinary pages often contain “meet” or “call”. A
        // browser candidate is therefore created only through microphone use.
        DetectionCandidate {
            signature: window.signature(),
            bundle: window.bundle.clone(),
            title: window.title.clone(),
            window_id: Some(window.id),
            microphone_trigger: false,
        }
    } else {
        let mut det = state.lock().await;
        det.candidate_signature = None;
        det.candidate_stable_polls = 0;
        det.microphone_active_polls = 0;
        if let Some(probe) = det.audio_probe.take() {
            probe.cancel();
        }
        return;
    };

    let signature = candidate.signature.clone();
    let mut det = state.lock().await;
    let candidate_changed = det.candidate_signature.as_deref() != Some(signature.as_str());
    if !candidate_changed {
        det.candidate_stable_polls = det.candidate_stable_polls.saturating_add(1);
    } else {
        if let Some(probe) = det.audio_probe.take() {
            probe.cancel();
        }
        det.candidate_signature = Some(signature.clone());
        det.candidate_stable_polls = 1;
        det.microphone_active_polls = 0;
    }
    det.microphone_active_polls = if candidate.microphone_trigger {
        det.microphone_active_polls.saturating_add(1)
    } else {
        0
    };

    // Start a fresh, window-scoped audio probe for a new candidate. The callback
    // only updates an in-memory RMS accumulator; it never stores audio samples.
    if candidate_changed {
        drop(det);
        let Some(window_id) = candidate.window_id else {
            return;
        };
        match meeting_audio_probe::start(window_id).await {
            Ok(probe) => {
                let mut det = state.lock().await;
                if det.candidate_signature.as_deref() == Some(signature.as_str()) {
                    det.audio_probe = Some(probe);
                } else {
                    probe.cancel();
                }
            }
            Err(e) => warn!("meeting audio probe unavailable; using silent fallback: {e}"),
        }
        return;
    }

    let active_audio_ms = det
        .audio_probe
        .as_ref()
        .map_or(0, AudioProbeHandle::active_ms);

    let cooldown_blocks_candidate = cooldown.is_some_and(|until| Instant::now() < until)
        && det
            .cooldown_signature
            .as_deref()
            .map_or(true, |previous| previous == signature);
    let audio_confirmed = active_audio_ms >= AUDIO_TRIGGER_MS;
    let mic_threshold =
        microphone_confirmation_polls(&candidate.bundle, candidate.window_id.is_some());
    let microphone_confirmed = det.microphone_active_polls >= mic_threshold;
    // Only dedicated clients have a reliable enough in-meeting window for a
    // silent fallback. Other apps need microphone or captured-audio evidence.
    let silent_fallback = !candidate.microphone_trigger
        && is_dedicated(&candidate.bundle)
        && det.candidate_stable_polls >= SILENT_FALLBACK_POLLS;

    if cooldown_blocks_candidate
        || det.candidate_stable_polls < CANDIDATE_STABLE_POLLS
        || (!microphone_confirmed && !audio_confirmed && !silent_fallback)
    {
        return;
    }

    det.cooldown_until = Some(Instant::now() + START_COOLDOWN);
    det.cooldown_signature = Some(signature);
    if let Some(probe) = det.audio_probe.take() {
        probe.cancel();
    }
    drop(det);

    let app_name = display_name_for(&candidate.bundle);
    info!(
        "meeting detected; emitting meeting-detected bundle={} title={} mic={} audio_ms={} fallback={}",
        candidate.bundle,
        candidate.title,
        microphone_confirmed,
        active_audio_ms,
        !microphone_confirmed && !audio_confirmed
    );
    let _ = app.emit(
        "meeting-detected",
        MeetingDetected {
            bundle_id: candidate.bundle,
            app_name,
            window_title: candidate.title,
            trigger: if microphone_confirmed {
                "microphone".to_string()
            } else {
                "meeting".to_string()
            },
        },
    );
}

async fn poll_loop<R: Runtime>(app: AppHandle<R>, cancel: CancellationToken) {
    let mut microphone_watcher = match MicrophoneActivityWatcher::new() {
        Ok(watcher) => {
            info!("meeting detector using event-driven microphone activity watcher");
            Some(watcher)
        }
        Err(error) => {
            warn!("microphone activity watcher unavailable; using polling fallback: {error}");
            None
        }
    };

    loop {
        let interval = {
            let state = app.state::<DetectorState>();
            let detector = state.lock().await;
            detector.next_poll_interval(Instant::now(), microphone_watcher.is_some())
        };
        let microphone_changed = async {
            if let Some(watcher) = microphone_watcher.as_mut() {
                watcher.changed().await;
            } else {
                std::future::pending::<()>().await;
            }
        };
        let fallback_refresh = tokio::select! {
            _ = cancel.cancelled() => break,
            _ = sleep(interval) => true,
            _ = microphone_changed => false,
        };
        if cancel.is_cancelled() {
            break;
        }
        if fallback_refresh && interval == EVENT_DRIVEN_IDLE_INTERVAL {
            if let Some(watcher) = microphone_watcher.as_mut() {
                watcher.refresh_process_list();
            }
        }
        let observed_input_bundles = microphone_watcher
            .as_ref()
            .map(MicrophoneActivityWatcher::active_non_whitelisted_bundles);
        poll_once(&app, observed_input_bundles.as_deref()).await;
    }
    info!("meeting detector poll loop stopped");
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

pub async fn start_detector<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    // Screen Recording permission is only needed for window-based detection
    // (SCShareableContent). Microphone-based detection (Core Audio process
    // enumeration) works without it, so we no longer block startup on it. When
    // the permission is missing, window enumeration simply returns empty and the
    // detector still catches meeting apps that grab the mic (腾讯会议 etc.).
    let has_screen = preflight_screen_capture();
    if !has_screen {
        warn!("meeting detector starting without Screen Recording permission (mic-only detection)");
    }

    let state = app.state::<DetectorState>();
    let mut det = state.lock().await;
    det.enabled = true;
    if det.cancel.is_none() {
        let token = CancellationToken::new();
        det.cancel = Some(token.clone());
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            poll_loop(app2, token).await;
        });
        info!("meeting detector started");
    }
    Ok(())
}

pub async fn stop_detector<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<DetectorState>();
    let mut det = state.lock().await;
    det.enabled = false;
    det.recording_active = false;
    det.recorded_bundle = None;
    det.stop_prompted_for_bundle = None;
    det.candidate_signature = None;
    det.candidate_stable_polls = 0;
    det.microphone_active_polls = 0;
    det.cooldown_signature = None;
    det.cooldown_until = None;
    if let Some(probe) = det.audio_probe.take() {
        probe.cancel();
    }
    if let Some(c) = det.cancel.take() {
        c.cancel();
    }
    info!("meeting detector stopped");
    Ok(())
}

#[tauri::command]
pub async fn meeting_detector_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DetectorState>,
) -> Result<(), String> {
    let _ = state;
    start_detector(&app).await
}

#[tauri::command]
pub async fn meeting_detector_stop<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DetectorState>,
) -> Result<(), String> {
    let _ = state;
    stop_detector(&app).await
}

/// Mirrors Snack Record's `setRecordingActive:`. On `active=true`, `bundle_id` is the
/// detected meeting app the detector should watch for stop. On `active=false`, clears
/// recording state and starts the post-recording cooldown.
pub async fn set_recording_active<R: Runtime>(
    app: &AppHandle<R>,
    active: bool,
    bundle_id: Option<String>,
) -> Result<(), String> {
    let state = app.state::<DetectorState>();
    let mut det = state.lock().await;
    det.recording_active = active;
    if active {
        if let Some(probe) = det.audio_probe.take() {
            probe.cancel();
        }
        det.recorded_bundle = bundle_id;
        det.stop_prompted_for_bundle = None;
        det.meeting_end_polls = 0;
        det.meeting_window_end_polls = 0;
        det.cooldown_until = None;
        det.cooldown_signature = None;
    } else {
        det.recorded_bundle = None;
        det.stop_prompted_for_bundle = None;
        det.meeting_end_polls = 0;
        det.meeting_window_end_polls = 0;
        det.candidate_signature = None;
        det.candidate_stable_polls = 0;
        det.microphone_active_polls = 0;
        det.cooldown_until = Some(Instant::now() + STOP_COOLDOWN);
        det.cooldown_signature = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn meeting_detector_set_recording_active<R: Runtime>(
    app: AppHandle<R>,
    active: bool,
    bundle_id: Option<String>,
    state: State<'_, DetectorState>,
) -> Result<(), String> {
    let _ = state;
    set_recording_active(&app, active, bundle_id).await
}

#[tauri::command]
pub async fn meeting_detector_is_enabled<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, DetectorState>,
) -> Result<bool, String> {
    Ok(state.lock().await.enabled)
}

/// Called by the frontend only after its event listeners are installed. Resetting
/// the candidate and cooldown guarantees that a meeting already in progress is
/// scanned again instead of losing the one-shot startup event.
#[tauri::command]
pub async fn meeting_detector_ui_ready<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, DetectorState>,
) -> Result<(), String> {
    let mut det = state.lock().await;
    det.ui_ready = true;
    det.candidate_signature = None;
    det.candidate_stable_polls = 0;
    det.microphone_active_polls = 0;
    det.cooldown_signature = None;
    det.cooldown_until = None;
    if let Some(probe) = det.audio_probe.take() {
        probe.cancel();
    }
    info!("meeting detector frontend ready; forcing a fresh scan");
    Ok(())
}

// ---------------------------------------------------------------------------
// Screen Recording (TCC) permission for SCShareableContent
// ---------------------------------------------------------------------------

extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// Returns true if Screen Recording permission is already granted.
#[tauri::command]
pub fn preflight_screen_capture() -> bool {
    // SAFETY: read-only CoreGraphics query.
    unsafe { CGPreflightScreenCaptureAccess() }
}

/// Triggers the macOS Screen Recording TCC prompt (returns true if already granted or just
/// granted). Note: on a first-time prompt, this returns false until the user grants and the
/// app is restarted; the frontend should re-check `preflight_screen_capture` after relaunch.
#[tauri::command]
pub fn request_screen_capture() -> bool {
    // SAFETY: triggers a system TCC prompt; no memory unsafety on our side.
    unsafe { CGRequestScreenCaptureAccess() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedicated_meeting_window_by_size() {
        assert!(window_suggests_meeting(
            "com.tencent.meeting",
            "腾讯会议-张三的会议",
            1280.0,
            720.0
        ));
        // Tencent's actual in-meeting Cocoa window title has no space. It must
        // not be normalized into the English launcher title `Tencent Meeting`.
        assert!(window_suggests_meeting(
            "com.tencent.meeting",
            "TencentMeeting",
            1280.0,
            720.0
        ));
        // home title rejected even at meeting size
        assert!(!window_suggests_meeting(
            "com.tencent.meeting",
            "腾讯会议",
            1280.0,
            720.0
        ));
        assert!(!window_suggests_meeting(
            "com.tencent.meeting",
            "Tencent Meeting",
            1280.0,
            720.0
        ));
        // too small
        assert!(!window_suggests_meeting(
            "com.tencent.meeting",
            "some window",
            700.0,
            400.0
        ));
    }

    #[test]
    fn snack_meet_can_never_be_window_evidence() {
        assert!(!window_suggests_meeting(
            "com.meetily.ai",
            "Snack Meet",
            1280.0,
            720.0
        ));
        assert!(!window_suggests_meeting(
            "com.google.Chrome",
            "Snack Meet Recording",
            1280.0,
            720.0
        ));
    }

    #[test]
    fn keyword_match_in_browser() {
        assert!(window_suggests_meeting(
            "com.google.Chrome",
            "Weekly Standup - Google Meet",
            800.0,
            600.0
        ));
    }

    #[test]
    fn feishu_never_size_branch() {
        // Feishu only triggers via keyword; size alone must not.
        assert!(!window_suggests_meeting(
            "com.electron.lark",
            "project chat",
            1200.0,
            800.0
        ));
        assert!(window_suggests_meeting(
            "com.electron.lark",
            "飞书会议 评审",
            1200.0,
            800.0
        ));
    }

    #[test]
    fn normalize_strips_punct() {
        assert_eq!(normalize_title("Zoom Meetings"), "zoommeetings");
        assert_eq!(normalize_title("腾讯会议 "), "腾讯会议");
    }

    #[test]
    fn microphone_process_filter_excludes_whitelist_and_infrastructure() {
        let filtered = filter_active_input_bundles(vec![
            "now.typeless.desktop".into(),
            "now.typeless.desktop.helper".into(),
            "com.apple.CoreSpeech".into(),
            "com.apple.SpeechRecognitionCore.speechrecognitiond".into(),
            "com.apple.avconferenced".into(),
            "com.meetily.ai".into(),
            "com.meetily.ai.helper".into(),
            "com.meetily.ai.webview.audio".into(),
            "com.tencent.meeting".into(),
            "com.example.voice-input".into(),
        ]);
        assert_eq!(
            filtered,
            vec!["com.tencent.meeting", "com.example.voice-input"]
        );
    }

    #[test]
    fn current_pid_and_self_bundle_tree_are_always_excluded() {
        assert!(is_self_audio_identity(
            Some("com.example.unknown-helper"),
            Some(42),
            42
        ));
        assert!(is_self_audio_identity(
            Some("com.meetily.ai.audio-helper"),
            Some(99),
            42
        ));
        assert!(!is_self_audio_identity(
            Some("com.tencent.meeting"),
            Some(99),
            42
        ));
    }

    #[test]
    fn microphone_confirmation_uses_evidence_tiers() {
        assert_eq!(
            microphone_confirmation_polls("com.tencent.meeting", false),
            MEETING_APP_MICROPHONE_POLLS
        );
        assert_eq!(
            microphone_confirmation_polls("com.google.Chrome", true),
            MEETING_APP_MICROPHONE_POLLS
        );
        assert_eq!(
            microphone_confirmation_polls("com.google.Chrome", false),
            GENERIC_MICROPHONE_POLLS
        );
        assert_eq!(
            microphone_confirmation_polls("com.example.camera-test", false),
            GENERIC_MICROPHONE_POLLS
        );
        assert_eq!(
            microphone_confirmation_polls("com.tencent.xinWeChat", false),
            VOICE_CALL_MIN_POLLS
        );
    }

    #[test]
    fn browser_windows_are_never_standalone_candidates() {
        assert!(is_browser("com.google.Chrome"));
        assert!(!is_browser("com.tencent.meeting"));
    }

    #[test]
    fn detector_uses_low_power_idle_polling() {
        let detector = MeetingDetector::default();
        assert_eq!(
            detector.next_poll_interval(Instant::now(), true),
            EVENT_DRIVEN_IDLE_INTERVAL
        );
        assert_eq!(
            detector.next_poll_interval(Instant::now(), false),
            POLLING_FALLBACK_INTERVAL
        );
    }

    #[test]
    fn detector_only_accelerates_for_candidate_or_active_recording() {
        let now = Instant::now();
        let mut detector = MeetingDetector {
            candidate_signature: Some("microphone:com.tencent.meeting".into()),
            ..MeetingDetector::default()
        };
        assert_eq!(detector.next_poll_interval(now, true), ACTIVE_POLL_INTERVAL);

        detector.cooldown_until = Some(now + Duration::from_secs(60));
        assert_eq!(
            detector.next_poll_interval(now, true),
            EVENT_DRIVEN_IDLE_INTERVAL
        );

        detector.recording_active = true;
        assert_eq!(detector.next_poll_interval(now, true), ACTIVE_POLL_INTERVAL);
    }

    #[test]
    fn microphone_activity_watcher_registers_and_releases_listeners() {
        let watcher = MicrophoneActivityWatcher::new()
            .expect("CoreAudio microphone activity listeners should register");
        assert!(!watcher.process_objects.is_empty());
        drop(watcher);
    }
}
