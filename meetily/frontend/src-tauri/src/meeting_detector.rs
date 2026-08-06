//! Meeting-window auto-detection — a port of Snack Record's `MeetingReminderMonitor`
//! (snack-record/Sources/main.m) into meetily's Rust backend.
//!
//! This module detects meetings by combining meeting-app window transitions with a scoped
//! ScreenCaptureKit audio-activity probe. It does NOT persist probe audio — meetily's own
//! capture pipeline handles recording. When a meeting starts (or ends), it emits Tauri
//! events and lets the frontend drive `start_recording` / `stop_recording` and summarization.
//!
//! Key porting decisions vs the original Objective-C:
//!   * A candidate-window-scoped SCStream probe can confirm a meeting after sustained audio.
//!     A delayed window-only fallback still supports silent, muted, and one-person meetings.
//!   * `isOnScreen` is intentionally ignored for dedicated meeting apps (the 腾讯会议 fix):
//!     SCShareableContent reports isOnScreen=0 mid-meeting for some apps. Home/launcher
//!     windows are rejected by title + size instead.
//!   * Confirmation dialogs are shown by the frontend (native Tauri dialog, visible above a
//!     fullscreen meeting). Cooldowns (10 min after a start prompt, 120 s after a recording
//!     ends) and the once-per-recording stop-prompt de-dupe are kept here, in the detector.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cidre::{core_audio as ca, ns, sc};
use serde::Serialize;
use tauri::{async_runtime::Mutex, AppHandle, Emitter, Manager, Runtime, State};
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::meeting_audio_probe::{self, AudioProbeHandle};

const POLL_INTERVAL: Duration = Duration::from_millis(800);
const START_COOLDOWN: Duration = Duration::from_secs(600); // 10 min after a start prompt
const STOP_COOLDOWN: Duration = Duration::from_secs(120); // after a recording ends
const CANDIDATE_STABLE_POLLS: u8 = 1;
const MICROPHONE_TRIGGER_POLLS: u8 = 1;
const AUDIO_TRIGGER_MS: u64 = 1_000;
const SILENT_FALLBACK_POLLS: u8 = 4;
const MICROPHONE_WHITELIST_PREFIXES: &[&str] = &["now.typeless"];
const MICROPHONE_INFRASTRUCTURE_BUNDLES: &[&str] = &["com.apple.CoreSpeech"];
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
    /// "app-exit" (auto-stop) or "window-gone" (ask before stopping)
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
    pub cooldown_until: Option<Instant>,
    candidate_signature: Option<String>,
    candidate_stable_polls: u8,
    microphone_active_polls: u8,
    cooldown_signature: Option<String>,
    audio_probe: Option<AudioProbeHandle>,
    cancel: Option<CancellationToken>,
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
async fn fetch_windows() -> Vec<WindowInfo> {
    let content = match sc::ShareableContent::current().await {
        Ok(c) => c,
        Err(e) => {
            warn!(
                "SCShareableContent fetch failed (screen-recording permission?): {}",
                e
            );
            return Vec::new();
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
    out
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
            bundle != "com.meetily.ai"
                && !MICROPHONE_WHITELIST_PREFIXES
                    .iter()
                    .any(|prefix| bundle.starts_with(prefix))
                && !MICROPHONE_INFRASTRUCTURE_BUNDLES.contains(&bundle.as_str())
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
        .filter_map(|process| process.bundle_id().ok().map(|id| id.to_string()))
        .collect();
    filter_active_input_bundles(active)
}

// ---------------------------------------------------------------------------
// Poll loop + state machine
// ---------------------------------------------------------------------------

async fn poll_once<R: Runtime>(app: &AppHandle<R>) {
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
        let source_still_active = if is_voice_call {
            active_non_whitelisted_input_bundles().contains(rb)
        } else if monitored_recording {
            running.contains(rb)
        } else {
            active_non_whitelisted_input_bundles().contains(rb)
        };
        if !source_still_active {
            // App exited or call mic released → auto-stop (no dialog).
            let mut det = state.lock().await;
            det.recording_active = false;
            det.recorded_bundle = None;
            det.stop_prompted_for_bundle = None;
            det.cooldown_until = Some(Instant::now() + STOP_COOLDOWN);
            info!(
                "meeting app exited; emitting meeting-ended(app-exit) bundle={}",
                rb
            );
            let _ = app.emit(
                "meeting-ended",
                MeetingEnded {
                    reason: "app-exit".into(),
                    bundle_id: Some(rb.clone()),
                },
            );
            return;
        }
        // For voice-calling apps, mic release is the natural end signal; there is
        // no meeting window to inspect.
        if is_voice_call {
            return;
        }
        // For a non-meeting voice-input app, microphone release is the natural
        // end signal; there is no meeting window to inspect.
        if !monitored_recording {
            return;
        }
        let windows = fetch_windows().await;
        let still_meeting = windows.iter().any(|w| {
            &w.bundle == rb && window_suggests_meeting(&w.bundle, &w.title, w.width, w.height)
        });
        let mut det = state.lock().await;
        if still_meeting {
            // Window came back; allow a future stop prompt.
            det.stop_prompted_for_bundle = None;
        } else if det.stop_prompted_for_bundle.as_deref() != Some(rb.as_str()) {
            // Window gone but app still running → ask once.
            det.stop_prompted_for_bundle = Some(rb.clone());
            info!(
                "meeting window no longer visible; emitting meeting-ended(window-gone) bundle={}",
                rb
            );
            let _ = app.emit(
                "meeting-ended",
                MeetingEnded {
                    reason: "window-gone".into(),
                    bundle_id: Some(rb.clone()),
                },
            );
        }
        return;
    }

    // Microphone use is the primary global signal. Prefer a monitored meeting
    // app when several processes are using input; otherwise use the first
    // non-whitelisted input process (Typeless is excluded above).
    let active_input_bundles = active_non_whitelisted_input_bundles();
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
    let windows = if running.is_empty() {
        Vec::new()
    } else {
        fetch_windows().await
    };
    let meeting_window = windows.iter().find(|w| {
        running.contains(&w.bundle)
            && window_suggests_meeting(&w.bundle, &w.title, w.width, w.height)
    });
    let candidate = if let Some(bundle) = microphone_bundle {
        let scoped_window = meeting_window.filter(|window| window.bundle == bundle);
        DetectionCandidate {
            signature: format!("microphone:{bundle}"),
            title: scoped_window
                .map(|window| window.title.clone())
                .unwrap_or_default(),
            window_id: scoped_window.map(|window| window.id),
            bundle,
            microphone_trigger: true,
        }
    } else if let Some(window) = meeting_window {
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
    // Voice-calling apps (WeChat / WhatsApp) use the mic for brief hold-to-talk
    // voice messages too, so require sustained mic use for them. Regular meeting
    // apps confirm after just MICROPHONE_TRIGGER_POLLS.
    let mic_threshold = if VOICE_CALL_APPS.contains(&candidate.bundle.as_str()) {
        VOICE_CALL_MIN_POLLS
    } else {
        MICROPHONE_TRIGGER_POLLS
    };
    let microphone_confirmed = det.microphone_active_polls >= mic_threshold;
    let silent_fallback = det.candidate_stable_polls >= SILENT_FALLBACK_POLLS;

    // Any monitored meeting app is a strong signal on its own — a meeting window
    // appearing (or the app grabbing the mic) is enough to prompt the user
    // immediately, even if the mic is silent. Only WeChat/WhatsApp voice-message
    // apps keep a sustained-use gate. This makes detection nearly instant.
    let is_fast_trigger = !VOICE_CALL_APPS.contains(&candidate.bundle.as_str())
        && det.candidate_stable_polls >= CANDIDATE_STABLE_POLLS;

    if cooldown_blocks_candidate
        || det.candidate_stable_polls < CANDIDATE_STABLE_POLLS
        || (!is_fast_trigger && !microphone_confirmed && !audio_confirmed && !silent_fallback)
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
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = sleep(POLL_INTERVAL) => {}
        }
        if cancel.is_cancelled() {
            break;
        }
        poll_once(&app).await;
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
        warn!(
            "meeting detector starting without Screen Recording permission (mic-only detection)"
        );
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
        det.cooldown_until = None;
        det.cooldown_signature = None;
    } else {
        det.recorded_bundle = None;
        det.stop_prompted_for_bundle = None;
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
            "com.meetily.ai".into(),
            "com.tencent.meeting".into(),
            "com.example.voice-input".into(),
        ]);
        assert_eq!(
            filtered,
            vec!["com.tencent.meeting", "com.example.voice-input"]
        );
    }
}
