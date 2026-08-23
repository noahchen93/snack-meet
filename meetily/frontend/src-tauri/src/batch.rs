// Batch processing module - queue multiple meetings for transcription or
// summarization. Jobs run sequentially so the single-instance Whisper engine
// and the single retranscription guard are respected.

use crate::state::AppState;
use log::{error, info};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Runtime};

/// Global flag to ensure only one batch runs at a time
static BATCH_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Global flag to signal batch cancellation
static BATCH_CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchStarted {
    pub batch_id: String,
    pub mode: String,
    pub total: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchProgress {
    pub mode: String,
    pub index: usize,
    pub total: usize,
    pub meeting_id: String,
    pub title: String,
    pub status: String, // "started" | "done" | "failed" | "skipped"
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchComplete {
    pub mode: String,
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub cancelled: bool,
}

/// Start a batch job. `mode` is "transcribe" or "summarize".
#[tauri::command]
pub async fn api_batch_process<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    mode: String,
    meeting_ids: Vec<String>,
) -> Result<BatchStarted, String> {
    if mode != "transcribe" && mode != "summarize" {
        return Err(format!("Invalid batch mode: {}", mode));
    }
    if meeting_ids.is_empty() {
        return Err("No meetings selected".to_string());
    }
    if BATCH_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("已有批量任务正在进行，请等待完成".to_string());
    }

    BATCH_CANCELLED.store(false, Ordering::SeqCst);
    let batch_id = format!("batch-{}", chrono::Utc::now().timestamp_millis());
    let pool = state.db_manager.pool().clone();
    let total = meeting_ids.len();

    let app_handle = app.clone();
    let mode_for_task = mode.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_batch(app_handle.clone(), pool, &mode_for_task, &meeting_ids).await;
        BATCH_IN_PROGRESS.store(false, Ordering::SeqCst);
        let _ = app_handle.emit(
            "batch-complete",
            serde_json::json!({
                "mode": mode_for_task,
                "total": total,
                "succeeded": result.0,
                "failed": result.1,
                "cancelled": result.2,
            }),
        );
    });

    Ok(BatchStarted {
        batch_id,
        mode,
        total,
        message: "Batch processing started".to_string(),
    })
}

/// Cancel an ongoing batch job. The current item finishes; the rest are skipped.
#[tauri::command]
pub async fn api_cancel_batch() -> Result<(), String> {
    if !BATCH_IN_PROGRESS.load(Ordering::SeqCst) {
        return Err("No batch in progress".to_string());
    }
    BATCH_CANCELLED.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn is_batch_in_progress() -> bool {
    BATCH_IN_PROGRESS.load(Ordering::SeqCst)
}

/// Runs the batch queue sequentially. Returns (succeeded, failed, cancelled).
async fn run_batch<R: Runtime>(
    app: AppHandle<R>,
    pool: sqlx::SqlitePool,
    mode: &str,
    meeting_ids: &[String],
) -> (usize, usize, bool) {
    let total = meeting_ids.len();
    let mut succeeded = 0usize;
    let mut failed = 0usize;

    for (index, meeting_id) in meeting_ids.iter().enumerate() {
        if BATCH_CANCELLED.load(Ordering::SeqCst) {
            info!("Batch cancelled, remaining items skipped");
            return (succeeded, failed, true);
        }

        let title = get_meeting_title(&pool, meeting_id)
            .await
            .unwrap_or_default();
        emit_progress(
            &app, mode, index, total, meeting_id, &title, "started", None,
        );

        let outcome = if mode == "transcribe" {
            transcribe_one(&app, &pool, meeting_id).await
        } else {
            summarize_one(&app, &pool, meeting_id).await
        };

        match outcome {
            Ok(()) => {
                succeeded += 1;
                emit_progress(&app, mode, index, total, meeting_id, &title, "done", None);
            }
            Err(e) => {
                failed += 1;
                error!("Batch {} failed for {}: {}", mode, meeting_id, e);
                emit_progress(
                    &app,
                    mode,
                    index,
                    total,
                    meeting_id,
                    &title,
                    "failed",
                    Some(e),
                );
            }
        }
    }

    (succeeded, failed, false)
}

async fn get_meeting_title(pool: &sqlx::SqlitePool, meeting_id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT title FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

/// Transcribe one meeting's audio using the configured Whisper provider.
async fn transcribe_one<R: Runtime>(
    app: &AppHandle<R>,
    pool: &sqlx::SqlitePool,
    meeting_id: &str,
) -> Result<(), String> {
    // Idempotency guard: skip meetings that already have transcript segments.
    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcripts WHERE meeting_id = ?")
        .bind(meeting_id)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("Failed to check existing transcripts: {}", e))?;
    if existing > 0 {
        info!(
            "Batch transcribe: {} already transcribed, skipping",
            meeting_id
        );
        return Ok(());
    }

    let folder_path: Option<String> =
        sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id = ?")
            .bind(meeting_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("Failed to read meeting folder: {}", e))?
            .flatten();

    let Some(folder_path) = folder_path.filter(|f| !f.trim().is_empty()) else {
        return Err("该会议没有存储文件夹，无法转写".to_string());
    };

    // Use the configured Whisper settings (provider + model).
    let config =
        crate::database::repositories::setting::SettingsRepository::get_transcript_config(pool)
            .await
            .map_err(|e| format!("Failed to read transcription config: {}", e))?;
    let (provider, model) = match config {
        Some(c) if c.provider == "localWhisper" || c.provider == "whisper" => (c.provider, c.model),
        Some(c) if c.provider == "parakeet" => (c.provider, c.model),
        Some(c) => (c.provider, c.model),
        None => (
            "localWhisper".to_string(),
            crate::config::DEFAULT_WHISPER_MODEL.to_string(),
        ),
    };

    crate::audio::retranscription::start_retranscription(
        app.clone(),
        meeting_id.to_string(),
        folder_path,
        None,
        Some(model),
        Some(provider),
    )
    .await
    .map(|_| ())
    .map_err(|e| format!("转写失败：{}", e))
}

/// Summarize one meeting's transcript with the configured summary model.
async fn summarize_one<R: Runtime>(
    app: &AppHandle<R>,
    pool: &sqlx::SqlitePool,
    meeting_id: &str,
) -> Result<(), String> {
    use crate::database::repositories::setting::SettingsRepository;
    use crate::database::repositories::summary::SummaryProcessesRepository;
    use crate::database::repositories::transcript_chunk::TranscriptChunksRepository;
    use crate::summary::service::SummaryService;

    // Idempotency guard: skip meetings that already have a completed summary.
    let existing_summary: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM summary_processes WHERE meeting_id = ? AND status = 'completed' AND result IS NOT NULL",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Failed to check existing summary: {}", e))?;
    if existing_summary.is_some() {
        info!(
            "Batch summarize: {} already summarized, skipping",
            meeting_id
        );
        return Ok(());
    }

    let config = SettingsRepository::get_model_config(pool)
        .await
        .map_err(|e| format!("Failed to read summary model config: {}", e))?
        .ok_or_else(|| "未配置总结模型".to_string())?;
    if config.provider.is_empty() || config.model.is_empty() {
        return Err("总结模型未配置".to_string());
    }

    let segments: Vec<String> = sqlx::query_scalar(
        "SELECT transcript FROM transcripts WHERE meeting_id = ? ORDER BY timestamp ASC",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取转写失败：{}", e))?;
    let text = segments.join("\n");
    if text.trim().is_empty() {
        return Err("该会议没有转写内容".to_string());
    }

    SummaryProcessesRepository::create_or_reset_process(pool, meeting_id)
        .await
        .map_err(|e| format!("初始化总结失败：{}", e))?;
    TranscriptChunksRepository::save_transcript_data(
        pool,
        meeting_id,
        &text,
        &config.provider,
        &config.model,
        40000,
        1000,
    )
    .await
    .map_err(|e| format!("保存转写数据失败：{}", e))?;

    let pool2 = pool.clone();
    let mid = meeting_id.to_string();
    let provider = config.provider.clone();
    let model = config.model.clone();
    SummaryService::process_transcript_background(
        app.clone(),
        pool2,
        mid,
        text,
        provider,
        model,
        String::new(),
        "standard_meeting".to_string(),
        None,
    )
    .await;

    // Determine the final outcome from the process status.
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM summary_processes WHERE meeting_id = ?")
            .bind(meeting_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    match status.as_deref() {
        Some("completed") => Ok(()),
        Some(other) => Err(format!("总结失败（状态：{}）", other)),
        None => Err("总结状态未知".to_string()),
    }
}

fn emit_progress<R: Runtime>(
    app: &AppHandle<R>,
    mode: &str,
    index: usize,
    total: usize,
    meeting_id: &str,
    title: &str,
    status: &str,
    error: Option<String>,
) {
    let _ = app.emit(
        "batch-progress",
        BatchProgress {
            mode: mode.to_string(),
            index,
            total,
            meeting_id: meeting_id.to_string(),
            title: title.to_string(),
            status: status.to_string(),
            error,
        },
    );
}
