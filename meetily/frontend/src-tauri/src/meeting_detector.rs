//! Meeting-window auto-detection — a port of Snack Record's `MeetingReminderMonitor`
//! (snack-record/Sources/main.m) into meetily's Rust backend.
//!
//! This module only *detects* meetings by enumerating on-screen windows via ScreenCaptureKit
//! (`cidre::sc::ShareableContent`) and running apps via AppKit (`cidre::ns::Workspace`).
//! It does NOT record audio — meetily's own capture pipeline does that. When a meeting
//! window appears (or disappears), it emits Tauri events and lets the frontend drive
//! `start_recording` / `stop_recording` + the auto-summarize flow.
//!
//! Key porting decisions vs the original Objective-C:
//!   * The SCStream audio-gate probe is dropped. The original's `recordOnWindowPresence` path
//!     already fires on window presence alone (so it triggers even when the user is alone /
//!     mic-muted / there is no system audio) — that is the only path we keep.
//!   * `isOnScreen` is intentionally ignored for dedicated meeting apps (the 腾讯会议 fix):
//!     SCShareableContent reports isOnScreen=0 mid-meeting for some apps. Home/launcher
//!     windows are rejected by title + size instead.
//!   * Confirmation dialogs are shown by the frontend (native Tauri dialog, visible above a
//!     fullscreen meeting). Cooldowns (10 min after a start prompt, 120 s after a recording
//!     ends) and the once-per-recording stop-prompt de-dupe are kept here, in the detector.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cidre::{ns, sc};
use serde::Serialize;
use tauri::{async_runtime::Mutex, AppHandle, Emitter, Manager, Runtime, State};
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

const POLL_INTERVAL: Duration = Duration::from_secs(8);
const START_COOLDOWN: Duration = Duration::from_secs(600); // 10 min after a start prompt
const STOP_COOLDOWN: Duration = Duration::from_secs(120); // after a recording ends

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
];

/// Dedicated meeting apps whose in-meeting window is identified by size, ignoring isOnScreen
/// (main.m:2044).
const DEDICATED: &[&str] = &["us.zoom.xos", "com.tencent.meeting", "com.tencent.wemeet"];

/// Title keywords that strongly indicate a meeting window (main.m:2289).
const KEYWORDS: &[&str] = &[
    "会议", "通话", "meeting", "call", "conference", "zoom", "teams", "meet", "钉钉", "webinar",
];

/// Punctuation/whitespace stripped before comparing window titles to home-title candidates
/// (main.m:2321 `normalizeTitleForComparison:`).
const TITLE_STRIP: &str = " -_·。:：.,|()[]【】（）";

#[derive(Serialize, Clone)]
pub struct MeetingDetected {
    pub bundle_id: String,
    pub app_name: String,
    pub window_title: String,
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
    pub recording_active: bool,
    pub recorded_bundle: Option<String>,
    pub stop_prompted_for_bundle: Option<String>,
    pub cooldown_until: Option<Instant>,
    cancel: Option<CancellationToken>,
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

/// Returns `(bundle_id, title, width, height)` for every window in the current
/// shareable content. Empty on permission error or fetch failure.
async fn fetch_windows() -> Vec<(String, String, f64, f64)> {
    let content = match sc::ShareableContent::current().await {
        Ok(c) => c,
        Err(e) => {
            warn!("SCShareableContent fetch failed (screen-recording permission?): {}", e);
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
        out.push((bundle, title, size.width as f64, size.height as f64));
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

// ---------------------------------------------------------------------------
// Poll loop + state machine
// ---------------------------------------------------------------------------

async fn poll_once<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<DetectorState>();
    // Snapshot the fields we need, then release the lock before any .await.
    let (enabled, recording_active, recorded_bundle, cooldown) = {
        let det = state.lock().await;
        (
            det.enabled,
            det.recording_active,
            det.recorded_bundle.clone(),
            det.cooldown_until,
        )
    };
    if !enabled {
        return;
    }

    let running = running_monitored_bundles();

    if recording_active {
        let Some(rb) = recorded_bundle.as_ref() else { return };
        if !running.contains(rb) {
            // App exited → auto-stop (no dialog).
            let mut det = state.lock().await;
            det.recording_active = false;
            det.recorded_bundle = None;
            det.stop_prompted_for_bundle = None;
            det.cooldown_until = Some(Instant::now() + STOP_COOLDOWN);
            info!("meeting app exited; emitting meeting-ended(app-exit) bundle={}", rb);
            let _ = app.emit(
                "meeting-ended",
                MeetingEnded { reason: "app-exit".into(), bundle_id: Some(rb.clone()) },
            );
            return;
        }
        let windows = fetch_windows().await;
        let still_meeting = windows
            .iter()
            .any(|(b, t, w, h)| b == rb && window_suggests_meeting(b, t, *w, *h));
        let mut det = state.lock().await;
        if still_meeting {
            // Window came back; allow a future stop prompt.
            det.stop_prompted_for_bundle = None;
        } else if det.stop_prompted_for_bundle.as_deref() != Some(rb.as_str()) {
            // Window gone but app still running → ask once.
            det.stop_prompted_for_bundle = Some(rb.clone());
            info!("meeting window no longer visible; emitting meeting-ended(window-gone) bundle={}", rb);
            let _ = app.emit(
                "meeting-ended",
                MeetingEnded { reason: "window-gone".into(), bundle_id: Some(rb.clone()) },
            );
        }
        return;
    }

    // Idle detection.
    if let Some(until) = cooldown {
        if Instant::now() < until {
            return;
        }
    }
    if running.is_empty() {
        return;
    }
    let windows = fetch_windows().await;
    let found = windows
        .iter()
        .find(|(b, t, w, h)| running.contains(b) && window_suggests_meeting(b, t, *w, *h));
    if let Some((b, t, _, _)) = found {
        let app_name = app_name_for(b).to_string();
        let mut det = state.lock().await;
        det.cooldown_until = Some(Instant::now() + START_COOLDOWN);
        info!("meeting detected; emitting meeting-detected bundle={} title={}", b, t);
        let _ = app.emit(
            "meeting-detected",
            MeetingDetected { bundle_id: b.clone(), app_name, window_title: t.clone() },
        );
    }
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
        det.recorded_bundle = bundle_id;
        det.stop_prompted_for_bundle = None;
        det.cooldown_until = None;
    } else {
        det.recorded_bundle = None;
        det.stop_prompted_for_bundle = None;
        det.cooldown_until = Some(Instant::now() + STOP_COOLDOWN);
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
        assert!(window_suggests_meeting("com.tencent.meeting", "腾讯会议-张三的会议", 1280.0, 720.0));
        // home title rejected even at meeting size
        assert!(!window_suggests_meeting("com.tencent.meeting", "腾讯会议", 1280.0, 720.0));
        // too small
        assert!(!window_suggests_meeting("com.tencent.meeting", "some window", 700.0, 400.0));
    }

    #[test]
    fn keyword_match_in_browser() {
        assert!(window_suggests_meeting("com.google.Chrome", "Weekly Standup - Google Meet", 800.0, 600.0));
    }

    #[test]
    fn feishu_never_size_branch() {
        // Feishu only triggers via keyword; size alone must not.
        assert!(!window_suggests_meeting("com.electron.lark", "project chat", 1200.0, 800.0));
        assert!(window_suggests_meeting("com.electron.lark", "飞书会议 评审", 1200.0, 800.0));
    }

    #[test]
    fn normalize_strips_punct() {
        assert_eq!(normalize_title("Zoom Meetings"), "zoommeetings");
        assert_eq!(normalize_title("腾讯会议 "), "腾讯会议");
    }
}