// External trigger module - allows other apps to trigger an audio import
// by launching Meetily with `--import <path> [--title <title>] [--language <xx>] [--model <id>] [--provider whisper|parakeet]`.

use log::{error as log_error, info as log_info};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, Runtime};

const TRACE_FILE: &str = "/tmp/meetily-trigger.log";

fn trace(msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(TRACE_FILE) {
        let _ = writeln!(f, "[{}] {}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0), msg);
    }
}

const IMPORT_FLAG: &str = "--import";
const TITLE_FLAG: &str = "--title";
const LANGUAGE_FLAG: &str = "--language";
const MODEL_FLAG: &str = "--model";
const PROVIDER_FLAG: &str = "--provider";

/// Parse args for an `--import` flag and kick off the import pipeline in the background.
/// Safe to call on a fresh launch (via `std::env::args`) or from the single-instance
/// callback (second instance args forwarded to the running process).
pub fn trigger_import_from_args<R: Runtime>(app: &AppHandle<R>, args: &[String]) {
    let Some(source_path) = flag_value(args, IMPORT_FLAG) else {
        return;
    };

    let title = flag_value(args, TITLE_FLAG).unwrap_or_else(|| default_title_from_path(&source_path));
    let language = flag_value(args, LANGUAGE_FLAG);
    let model = flag_value(args, MODEL_FLAG);
    let provider = flag_value(args, PROVIDER_FLAG);

    if !PathBuf::from(&source_path).exists() {
        log_error!("External import: source file not found: {}", source_path);
        return;
    }

    log_info!(
        "External import triggered: path={} title={} language={:?} model={:?} provider={:?}",
        source_path,
        title,
        language,
        model,
        provider
    );

    let app_handle = app.clone();
    let is_parakeet = provider.as_deref() == Some("parakeet");
    trace(&format!("trigger_import_from_args: spawn task path={} model={:?} provider={:?}", source_path, model, provider));
    tauri::async_runtime::spawn(async move {
        if !is_parakeet {
            let mut waited_ms = 0;
            while waited_ms < 60_000 {
                let engine_ready = {
                    let guard = crate::whisper_engine::commands::WHISPER_ENGINE
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    guard.is_some()
                };
                if engine_ready {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                waited_ms += 500;
            }
            trace(&format!("engine wait finished, waited_ms={}", waited_ms));
        }
        trace("calling start_import...");
        match crate::audio::import::start_import(
            app_handle.clone(),
            source_path,
            title,
            language,
            model,
            provider,
        )
        .await
        {
            Ok(result) => {
                trace(&format!("import complete: meeting_id={} title={} segments={}", result.meeting_id, result.title, result.segments_count));
                log_info!(
                    "External import complete: meeting_id={} title={} segments={} duration={:.0}s",
                    result.meeting_id,
                    result.title,
                    result.segments_count,
                    result.duration_seconds
                );
                auto_summarize_meeting(app_handle.clone(), result.meeting_id.clone()).await;
                let _ = app_handle.emit("external-import-complete", ());
            }
            Err(e) => {
                trace(&format!("import failed: {}", e));
                log_error!("External import failed: {}", e);
            }
        }
    });
}

/// Auto-generate a summary for an externally imported meeting, so a smart title
/// can be extracted and applied (folder + DB). Mirrors what the UI's
/// `api_process_transcript` command does, but runs fully headless.
pub async fn auto_summarize_meeting<R: Runtime>(app: AppHandle<R>, meeting_id: String) {
    trace(&format!("auto_summarize_meeting: meeting_id={}", meeting_id));
    let pool = app.state::<crate::state::AppState>().db_manager.pool().clone();

    // Read the summary model config (provider + model) from the settings table.
    let Some(config) =
        crate::database::repositories::setting::SettingsRepository::get_model_config(&pool)
            .await
            .unwrap_or(None)
    else {
        trace("auto_summarize_meeting: no model config found, skipping");
        log_error!("Auto-summary skipped: no model config in settings");
        return;
    };
    let model_provider = config.provider.clone();
    let model_name = config.model.clone();
    if model_provider.is_empty() || model_name.is_empty() {
        trace("auto_summarize_meeting: empty provider/model, skipping");
        return;
    }

    // Reconstruct the full transcript text from the transcripts table.
    let segments: Vec<String> = match sqlx::query_scalar(
        "SELECT transcript FROM transcripts WHERE meeting_id = ? ORDER BY timestamp ASC",
    )
    .bind(&meeting_id)
    .fetch_all(&pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            trace(&format!("auto_summarize_meeting: read transcripts failed: {}", e));
            log_error!("Auto-summary skipped: failed to read transcripts: {}", e);
            return;
        }
    };
    let text = segments.join("\n");
    if text.trim().is_empty() {
        trace("auto_summarize_meeting: empty transcript, skipping");
        return;
    }
    trace(&format!("auto_summarize_meeting: transcript chars={}", text.chars().count()));

    // Create/reset the summary process entry, save chunk metadata, then spawn.
    if let Err(e) = crate::database::repositories::summary::SummaryProcessesRepository::create_or_reset_process(&pool, &meeting_id).await {
        trace(&format!("auto_summarize_meeting: create_or_reset_process failed: {}", e));
        return;
    }
    if let Err(e) = crate::database::repositories::transcript_chunk::TranscriptChunksRepository::save_transcript_data(
        &pool, &meeting_id, &text, &model_provider, &model_name, 40000, 1000,
    ).await {
        trace(&format!("auto_summarize_meeting: save_transcript_data failed: {}", e));
        return;
    }

    let pool2 = pool.clone();
    let mid = meeting_id.clone();
    tauri::async_runtime::spawn(async move {
        trace(&format!("auto_summarize_meeting: spawning process_transcript_background"));
        crate::summary::service::SummaryService::process_transcript_background(
            app,
            pool2,
            mid.clone(),
            text,
            model_provider,
            model_name,
            String::new(),
            "standard_meeting".to_string(),
            None,
        )
        .await;
    });
    log_info!("Auto-summary background task spawned for meeting_id: {}", meeting_id);
}

/// Tauri command wrapper so the frontend can trigger background summarize + smart rename
/// after a meeting-window-detector-triggered recording stops (the standalone recording path
/// does not auto-summarize on its own; the import path does).
#[tauri::command]
pub async fn auto_summarize_meeting_command<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
) -> Result<(), String> {
    auto_summarize_meeting(app, meeting_id).await;
    Ok(())
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    let mut iter = args.iter().peekable();
    while let Some(arg) = iter.next() {
        if arg == flag {
            return iter.next().cloned();
        }
    }
    None
}

fn default_title_from_path(path: &str) -> String {
    PathBuf::from(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Imported Meeting".to_string())
}
