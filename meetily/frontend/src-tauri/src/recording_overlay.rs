use tauri::{AppHandle, Manager, Runtime};

const RECORDING_OVERLAY_LABEL: &str = "recording-overlay";
const RECORDING_PROMPT_LABEL: &str = "recording-prompt";

/// Reassert the recording overlay's native window properties before it is
/// shown. macOS can rebuild ordering when displays or fullscreen Spaces change,
/// so applying this only once in tauri.conf.json is not reliable enough.
#[tauri::command]
pub async fn recording_overlay_ensure_frontmost<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), String> {
    let window = app
        .get_webview_window(RECORDING_OVERLAY_LABEL)
        .ok_or_else(|| "Recording overlay window is unavailable".to_string())?;

    #[cfg(target_os = "macos")]
    {
        let main_thread_window = window.clone();
        let (result_sender, result_receiver) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let _ = result_sender.send(configure_macos_window(&main_thread_window, false));
            })
            .map_err(|error| format!("Failed to schedule recording overlay update: {error}"))?;
        result_receiver
            .await
            .map_err(|_| "Recording overlay update was cancelled".to_string())??;
    }

    #[cfg(not(target_os = "macos"))]
    {
        window
            .set_always_on_top(true)
            .map_err(|error| format!("Failed to raise recording overlay: {error}"))?;
    }

    Ok(())
}

/// Raise the pre-recording confirmation above all desktop/fullscreen windows
/// and make it key so the user can answer without first opening the main UI.
#[tauri::command]
pub async fn recording_prompt_ensure_frontmost<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), String> {
    let window = app
        .get_webview_window(RECORDING_PROMPT_LABEL)
        .ok_or_else(|| "Recording prompt window is unavailable".to_string())?;

    #[cfg(target_os = "macos")]
    {
        let main_thread_window = window.clone();
        let (result_sender, result_receiver) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let _ = result_sender.send(configure_macos_window(&main_thread_window, true));
            })
            .map_err(|error| format!("Failed to schedule recording prompt update: {error}"))?;
        result_receiver
            .await
            .map_err(|_| "Recording prompt update was cancelled".to_string())??;
    }

    #[cfg(not(target_os = "macos"))]
    {
        window
            .set_always_on_top(true)
            .map_err(|error| format!("Failed to raise recording prompt: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("Failed to focus recording prompt: {error}"))?;
    }

    Ok(())
}

/// Startup setup already runs on AppKit's main thread, so it can configure the
/// hidden window synchronously without scheduling another event-loop task.
pub(crate) fn configure_recording_overlay_at_startup<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(), String> {
    let window = app
        .get_webview_window(RECORDING_OVERLAY_LABEL)
        .ok_or_else(|| "Recording overlay window is unavailable".to_string())?;

    #[cfg(target_os = "macos")]
    configure_macos_window(&window, false)?;

    #[cfg(not(target_os = "macos"))]
    window
        .set_always_on_top(true)
        .map_err(|error| format!("Failed to raise recording overlay: {error}"))?;

    Ok(())
}

pub(crate) fn configure_recording_prompt_at_startup<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(), String> {
    let window = app
        .get_webview_window(RECORDING_PROMPT_LABEL)
        .ok_or_else(|| "Recording prompt window is unavailable".to_string())?;

    #[cfg(target_os = "macos")]
    configure_macos_window(&window, false)?;

    #[cfg(not(target_os = "macos"))]
    window
        .set_always_on_top(true)
        .map_err(|error| format!("Failed to raise recording prompt: {error}"))?;

    Ok(())
}

#[cfg(target_os = "macos")]
fn configure_macos_window<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    make_key: bool,
) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior};

    if MainThreadMarker::new().is_none() {
        return Err("Recording overlay must be configured on the macOS main thread".to_string());
    }

    let ns_window = window
        .ns_window()
        .map_err(|error| format!("Failed to access recording overlay NSWindow: {error}"))?
        .cast::<NSWindow>();
    if ns_window.is_null() {
        return Err("Recording overlay NSWindow pointer is null".to_string());
    }

    // SAFETY: `ns_window` is Tauri's live NSWindow pointer. A main-thread
    // marker was acquired above, and the window remains owned by the cloned
    // WebviewWindow for the duration of these AppKit calls.
    unsafe {
        let ns_window = &*ns_window;
        let overlay_behavior = ns_window.collectionBehavior()
            | NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle
            | NSWindowCollectionBehavior::FullScreenAuxiliary;
        ns_window.setCollectionBehavior(overlay_behavior);
        ns_window.setLevel(NSScreenSaverWindowLevel);
        ns_window.setHidesOnDeactivate(false);
        ns_window.setCanHide(false);
        if make_key {
            ns_window.orderFrontRegardless();
            ns_window.makeKeyAndOrderFront(None);
        }
    }

    log::debug!(
        "Recording overlay configured for all Spaces/fullscreen at NSWindow level {}",
        NSScreenSaverWindowLevel
    );
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn overlay_behavior_includes_all_spaces_and_fullscreen() {
        use objc2_app_kit::{NSScreenSaverWindowLevel, NSWindowCollectionBehavior};

        let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle
            | NSWindowCollectionBehavior::FullScreenAuxiliary;

        assert!(behavior.contains(NSWindowCollectionBehavior::CanJoinAllSpaces));
        assert!(behavior.contains(NSWindowCollectionBehavior::FullScreenAuxiliary));
        assert!(NSScreenSaverWindowLevel > 101);
    }
}
