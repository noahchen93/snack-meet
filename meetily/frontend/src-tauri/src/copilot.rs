//! AI Copilot — an experimental live "co-pilot" for meetings.
//!
//! While a meeting is being recorded and transcribed, the copilot window can:
//!   * continuously summarize / remind the user of what's been discussed
//!     (automatic reminders), and
//!   * answer the user's typed questions based on the ongoing transcript plus an
//!     optional user-provided context document.
//!
//! It reuses the same LLM provider configuration (provider / model / api key /
//! endpoints) as meeting summaries, so no separate setup is needed.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{command, AppHandle, Manager, Runtime, State};
use tracing::info;

use crate::database::repositories::setting::SettingsRepository;
use crate::state::AppState;
use crate::summary::llm_client::{generate_summary, LLMProvider};
use crate::summary::CustomOpenAIConfig;

/// Maximum transcript context characters sent to the LLM in one call. This keeps
/// requests fast and cheap while still covering several minutes of speech.
const MAX_CONTEXT_CHARS: usize = 8_000;
/// Maximum characters from the user's context document.
const MAX_CONTEXT_DOC_CHARS: usize = 12_000;
/// When a document is imported it is stored under this name in the app data dir.
const CONTEXT_DOC_FILENAME: &str = "copilot_context.md";
/// Optional dedicated cloud config for the copilot (OpenAI-compatible endpoint).
/// When set it takes priority over the meeting-summary LLM config, giving the
/// user a faster cloud model without disturbing their summary provider.
const CLOUD_CONFIG_FILENAME: &str = "copilot_cloud.json";

/// Optional cloud (OpenAI-compatible) configuration for the copilot. All fields
/// are optional; missing ones fall back to the meeting-summary LLM config.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CopilotCloudConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(rename = "apiKey", default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

fn cloud_config_path(app_data_dir: &PathBuf) -> PathBuf {
    app_data_dir.join(CLOUD_CONFIG_FILENAME)
}

fn read_cloud_config(app_data_dir: &PathBuf) -> Option<CopilotCloudConfig> {
    let path = cloud_config_path(app_data_dir);
    let raw = std::fs::read_to_string(&path).ok()?;
    let cfg: CopilotCloudConfig = serde_json::from_str(&raw).ok()?;
    // Only treat it as "configured" if it has enough to be useful.
    if cfg.endpoint.is_none() && cfg.api_key.is_none() && cfg.model.is_none() {
        None
    } else {
        Some(cfg)
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CopilotAskRequest {
    /// Accumulated transcript text so far.
    pub context: String,
    /// The user's question. Empty → automatic reminder mode.
    pub question: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CopilotAskResponse {
    pub answer: String,
    /// True when this was an automatic reminder (question was empty).
    pub is_reminder: bool,
}

/// Resolve the configured LLM provider, its key, and endpoints from the database,
/// mirroring summary/service.rs. Returns (provider, model, api_key,
/// ollama_endpoint, custom_openai_config).
async fn resolve_llm_config(
    pool: &sqlx::SqlitePool,
) -> Result<(LLMProvider, String, String, Option<String>, Option<CustomOpenAIConfig>), String> {
    let model_config = SettingsRepository::get_model_config(pool)
        .await
        .map_err(|e| format!("Failed to read LLM config: {e}"))?
        .ok_or_else(|| "No LLM provider configured. Please configure one in Settings.".to_string())?;

    let provider = LLMProvider::from_str(&model_config.provider)
        .map_err(|e| format!("Unsupported LLM provider: {e}"))?;

    // API key (Ollama / BuiltInAI / CustomOpenAI don't require the standard key).
    let api_key = if provider == LLMProvider::Ollama
        || provider == LLMProvider::BuiltInAI
        || provider == LLMProvider::CustomOpenAI
    {
        String::new()
    } else {
        SettingsRepository::get_api_key(pool, &model_config.provider)
            .await
            .map_err(|e| format!("Failed to read API key: {e}"))?
            .filter(|k| !k.is_empty())
            .ok_or_else(|| "API key not configured for the selected LLM provider.".to_string())?
    };

    // Ollama endpoint.
    let ollama_endpoint = if provider == LLMProvider::Ollama {
        model_config.ollama_endpoint.clone()
    } else {
        None
    };

    // Custom OpenAI config.
    let custom_openai_config = if provider == LLMProvider::CustomOpenAI {
        Some(
            SettingsRepository::get_custom_openai_config(pool)
                .await
                .map_err(|e| format!("Failed to read custom OpenAI config: {e}"))?
                .ok_or_else(|| "Custom OpenAI provider selected but not configured.".to_string())?,
        )
    } else {
        None
    };

    let model = model_config.model;
    Ok((provider, model, api_key, ollama_endpoint, custom_openai_config))
}

/// Read the user's imported context document (if any) from the app data dir.
fn read_context_document(app_data_dir: &PathBuf) -> String {
    let path = app_data_dir.join(CONTEXT_DOC_FILENAME);
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let trimmed = text.trim().to_string();
            if trimmed.is_empty() {
                String::new()
            } else {
                trimmed
            }
        }
        Err(_) => String::new(),
    }
}

/// Build the system prompt. In answer mode we answer the user's question using the
/// ongoing transcript + context doc; in reminder mode we produce a concise,
/// actionable reminder of what has been discussed.
fn build_system_prompt(context_doc: &str, is_reminder: bool) -> String {
    let base = if is_reminder {
        "You are a meeting co-pilot. You receive the live transcript of an ongoing \
         meeting (possibly in Chinese). Produce a concise, actionable reminder of what \
         has been said so far: key decisions, action items, and any important points. \
         Use the user's language (Chinese unless the transcript is clearly another \
         language). Keep it under ~120 Chinese characters unless asked otherwise. \
         Prefer bullet points."
    } else {
        "You are a meeting co-pilot. You receive the live transcript of an ongoing \
         meeting plus the user's question. Answer the question accurately using ONLY \
         the transcript and the user's context document. If the transcript does not \
         contain the answer, say so briefly. Respond in the user's language (Chinese \
         unless the transcript is clearly another language). Be concise."
    };

    if context_doc.is_empty() {
        base.to_string()
    } else {
        format!(
            "{base}\n\n# User's context document (reference only)\n{context_doc}"
        )
    }
}

/// Resolved LLM connection parameters shared by the copilot, reminder, and
/// smart-rename paths. A dedicated cloud config wins; otherwise it falls back
/// to the meeting-summary LLM config.
struct LlmConnection {
    provider: LLMProvider,
    model: String,
    api_key: String,
    ollama_endpoint: Option<String>,
    custom_endpoint: Option<String>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    top_p: Option<f32>,
}

async fn resolve_llm_connection<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<LlmConnection, String> {
    let app_state = app.state::<AppState>();
    let pool = app_state.db_manager.pool();
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

    let cloud_config = read_cloud_config(&app_data_dir);

    let (provider, model, api_key, ollama_endpoint, custom_openai_config) =
        if let Some(cloud) = cloud_config {
            info!(
                "🤖 Copilot using dedicated cloud config (model={:?})",
                cloud.model
            );
            (
                LLMProvider::CustomOpenAI,
                cloud
                    .model
                    .clone()
                    .unwrap_or_else(|| "gpt-4o-mini".to_string()),
                cloud.api_key.clone().unwrap_or_default(),
                None,
                Some(CustomOpenAIConfig {
                    endpoint: cloud.endpoint.unwrap_or_else(|| {
                        "https://api.openai.com/v1".to_string()
                    }),
                    api_key: cloud.api_key.clone(),
                    model: cloud.model.unwrap_or_else(|| "gpt-4o-mini".to_string()),
                    max_tokens: None,
                    temperature: None,
                    top_p: None,
                }),
            )
        } else {
            resolve_llm_config(pool).await?
        };

    let (custom_endpoint, max_tokens, temperature, top_p) = match &custom_openai_config {
        Some(cfg) => (
            Some(cfg.endpoint.clone()),
            cfg.max_tokens.map(|t| t as u32),
            cfg.temperature,
            cfg.top_p,
        ),
        None => (None, None, None, None),
    };

    let final_api_key = if provider == LLMProvider::CustomOpenAI {
        custom_openai_config
            .as_ref()
            .and_then(|c| c.api_key.clone())
            .unwrap_or_default()
    } else {
        api_key
    };

    Ok(LlmConnection {
        provider,
        model,
        api_key: final_api_key,
        ollama_endpoint,
        custom_endpoint,
        max_tokens,
        temperature,
        top_p,
    })
}

/// Core ask logic, shared by the automatic reminder and the manual question path.
async fn copilot_ask_inner<R: Runtime>(
    app: &AppHandle<R>,
    context: &str,
    question: Option<&str>,
) -> Result<String, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;

    let context_doc = read_context_document(&app_data_dir);

    let is_reminder = question.map(|q| q.trim().is_empty()).unwrap_or(true);

    // Truncate context to the window we can afford.
    let context_trimmed: String = context
        .chars()
        .take(MAX_CONTEXT_CHARS)
        .collect();
    let context_doc_trimmed: String = context_doc.chars().take(MAX_CONTEXT_DOC_CHARS).collect();

    let system_prompt = build_system_prompt(&context_doc_trimmed, is_reminder);

    let user_prompt = if is_reminder {
        format!("Meeting transcript so far:\n\n{context_trimmed}")
    } else {
        format!(
            "Meeting transcript so far:\n\n{context_trimmed}\n\n---\nUser's question: {}",
            question.unwrap_or_default()
        )
    };

    let conn = resolve_llm_connection(app).await?;
    let client = reqwest::Client::new();

    info!(
        "🤖 Copilot ask: provider={:?} model={} reminder={} context_chars={}",
        conn.provider,
        conn.model,
        is_reminder,
        context_trimmed.chars().count()
    );

    let answer = generate_summary(
        &client,
        &conn.provider,
        &conn.model,
        &conn.api_key,
        &system_prompt,
        &user_prompt,
        conn.ollama_endpoint.as_deref(),
        conn.custom_endpoint.as_deref(),
        conn.max_tokens,
        conn.temperature,
        conn.top_p,
        Some(&app_data_dir),
        None,
    )
    .await?;

    Ok(answer)
}

/// Generate a concise meeting title from a transcript using the copilot LLM
/// config (cloud-first, else summary config). Returns a short string safe for
/// use as a folder/file name.
pub(crate) async fn generate_meeting_title<R: Runtime>(
    app: &AppHandle<R>,
    transcript: &str,
) -> Result<String, String> {
    let trimmed: String = transcript.chars().take(MAX_CONTEXT_CHARS).collect();
    if trimmed.trim().is_empty() {
        return Err("Empty transcript".to_string());
    }

    let system_prompt = "You are a meeting titling assistant. Given the meeting \
        transcript, produce a concise, specific meeting title of 3 to 12 Chinese \
        characters that captures the meeting's purpose and main topic. \
        CRITICAL: Always output the title in CHINESE (中文), regardless of the \
        transcript language. Return ONLY the title text — no quotes, no markdown, \
        no extra explanation. Do not use generic words like '会议' or 'Meeting' \
        alone.";

    let user_prompt = format!("Meeting transcript:\n\n{trimmed}\n\n中文标题:");

    let conn = resolve_llm_connection(app).await?;
    let client = reqwest::Client::new();

    info!(
        "📛 Generating meeting title: provider={:?} model={}",
        conn.provider, conn.model
    );

    let raw = generate_summary(
        &client,
        &conn.provider,
        &conn.model,
        &conn.api_key,
        system_prompt,
        &user_prompt,
        conn.ollama_endpoint.as_deref(),
        conn.custom_endpoint.as_deref(),
        Some(40),
        conn.temperature,
        conn.top_p,
        Some(&app_data_dir_path(app).await?),
        None,
    )
    .await?;

    // Extract a clean title from the model output. Local (built-in) models may
    // emit a "thinking" preamble and a few candidate titles; take the last
    // plausible candidate line. Cloud models usually return a single title.
    let title = extract_title_from_output(&raw);

    if title.is_empty() {
        Err("Empty title generated".to_string())
    } else {
        Ok(title)
    }
}

/// Pull a concise title out of a possibly-verbose model reply.
fn extract_title_from_output(raw: &str) -> String {
    let mut candidates: Vec<String> = Vec::new();
    for line in raw.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        // Skip thinking/analysis markers and generic meta lines.
        let lower = l.to_lowercase();
        if lower.starts_with("thinking")
            || lower.starts_with("drafting")
            || lower.starts_with("analyze")
            || lower.starts_with("the user wants")
            || lower.starts_with("key topic")
            || l.starts_with("```")
        {
            continue;
        }
        // Strip markdown list markers, numbering, quotes, and heading.
        let cleaned = l
            .trim_start_matches(['-', '*', '+', '1', '2', '3', '4', '5', '6', '7', '8', '9'])
            .trim_start_matches(['.', ')', '>', ' ', '\t'])
            .trim()
            .trim_matches('"')
            .trim_start_matches("# ")
            .trim()
            .to_string();
        if cleaned.is_empty() {
            continue;
        }
        // Skip lines that are really a full sentence/analysis (too long to be a
        // title, or that clearly end with a colon introducing more text).
        let len = cleaned.chars().count();
        if len > 40 {
            continue;
        }
        // If a line looks like "最终标题：XXX" or "Title: XXX", keep only the
        // text after the colon.
        let after_colon = cleaned
            .split_once('：')
            .map(|(_, rest)| rest.trim().to_string())
            .or_else(|| {
                cleaned
                    .split_once(':')
                    .map(|(prefix, rest)| {
                        if prefix.len() <= 12 && !rest.contains(' ') {
                            rest.trim().to_string()
                        } else {
                            cleaned.clone()
                        }
                    })
            })
            .unwrap_or_else(|| cleaned.clone());
        let candidate = if !after_colon.is_empty() {
            after_colon
        } else {
            cleaned.clone()
        };
        if candidate.is_empty() {
            continue;
        }
        candidates.push(candidate);
    }
    // Prefer the last candidate (models often list options then conclude). Fall
    // back to the first non-empty line otherwise.
    candidates
        .pop()
        .or_else(|| {
            let first = raw.lines().find(|l| !l.trim().is_empty())?;
            Some(
                first
                    .trim()
                    .trim_matches('"')
                    .trim_start_matches("# ")
                    .to_string(),
            )
        })
        .map(|s| s.chars().take(40).collect())
        .unwrap_or_default()
}

async fn app_data_dir_path<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))
}

/// Smart-rename a meeting: generate a title from its transcript, update the DB
/// meeting name, and rename the recording folder. This is independent of the
/// AI summary flow, so it runs reliably right after a recording is saved.
/// Returns the new title, or None if there was nothing to rename.
#[command]
pub async fn copilot_smart_rename_meeting<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
) -> Result<Option<String>, String> {
    let pool = app.state::<AppState>().db_manager.pool().clone();

    // Read the transcript for this meeting.
    let segments: Vec<String> =
        sqlx::query_scalar("SELECT transcript FROM transcripts WHERE meeting_id = ? ORDER BY timestamp ASC")
            .bind(&meeting_id)
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("Failed to read transcripts: {e}"))?;
    let text = segments.join("\n");
    if text.trim().is_empty() {
        return Ok(None);
    }

    // Generate a concise title.
    let title = match generate_meeting_title(&app, &text).await {
        Ok(t) => t,
        Err(e) => {
            info!("Smart rename skipped for {}: {}", meeting_id, e);
            return Ok(None);
        }
    };

    // Update the DB meeting name.
    if let Err(e) =
        crate::database::repositories::meeting::MeetingsRepository::update_meeting_name(
            &pool, &meeting_id, &title,
        )
        .await
    {
        info!("Smart rename: failed to update meeting name for {}: {}", meeting_id, e);
        return Err(format!("Failed to update meeting name: {e}"));
    }

    // Rename the recording folder on disk.
    if let Err(e) =
        crate::summary::service::SummaryService::rename_meeting_folder(&pool, &meeting_id, &title)
            .await
    {
        info!("Smart rename: folder rename for {} failed: {}", meeting_id, e);
    }

    info!("✅ Smart-renamed meeting {} → '{}'", meeting_id, title);
    Ok(Some(title))
}

/// Ask the copilot. `question` empty/None → automatic reminder mode.
#[command]
pub async fn copilot_ask<R: Runtime>(
    app: AppHandle<R>,
    request: CopilotAskRequest,
    state: State<'_, AppState>,
) -> Result<CopilotAskResponse, String> {
    let _ = state;
    let is_reminder = request
        .question
        .as_deref()
        .map(|q| q.trim().is_empty())
        .unwrap_or(true);
    let answer = copilot_ask_inner(&app, &request.context, request.question.as_deref()).await?;
    Ok(CopilotAskResponse { answer, is_reminder })
}

/// Save the user's imported context document. Returns the stored character count.
#[command]
pub async fn copilot_save_context_document<R: Runtime>(
    app: AppHandle<R>,
    content: String,
) -> Result<usize, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&app_data_dir).map_err(|e| format!("Failed to create app data dir: {e}"))?;
    let path = app_data_dir.join(CONTEXT_DOC_FILENAME);
    std::fs::write(&path, content.as_bytes())
        .map_err(|e| format!("Failed to save context document: {e}"))?;
    Ok(content.chars().count())
}

/// Return the currently saved context document, if any.
#[command]
pub async fn copilot_get_context_document<R: Runtime>(
    app: AppHandle<R>,
) -> Result<String, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(read_context_document(&app_data_dir))
}

/// Return the currently saved copilot cloud config (without forcing one).
#[command]
pub async fn copilot_get_cloud_config<R: Runtime>(
    app: AppHandle<R>,
) -> Result<CopilotCloudConfig, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(read_cloud_config(&app_data_dir).unwrap_or_default())
}

/// Save the copilot cloud config (endpoint / api key / model). Pass empty fields
/// to clear the corresponding value. Saving an all-empty config removes the file.
#[command]
pub async fn copilot_save_cloud_config<R: Runtime>(
    app: AppHandle<R>,
    config: CopilotCloudConfig,
) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {e}"))?;

    // Normalise empty strings to None so an all-empty config is removed cleanly.
    let config = CopilotCloudConfig {
        endpoint: config.endpoint.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        api_key: config.api_key.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        model: config.model.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
    };

    let path = cloud_config_path(&app_data_dir);
    if config.endpoint.is_none() && config.api_key.is_none() && config.model.is_none() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    let raw = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialise cloud config: {e}"))?;
    std::fs::write(&path, raw).map_err(|e| format!("Failed to save cloud config: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::extract_title_from_output;

    #[test]
    fn cloud_single_title() {
        assert_eq!(extract_title_from_output("项目进度评审"), "项目进度评审");
    }

    #[test]
    fn builtin_thinking_block_uses_last_candidate() {
        let raw = "thinking\nDrafting titles:\n- 调整交通执法展台位置\n- 讨论展台布局调整\n最终标题：展台布局调整讨论";
        assert_eq!(extract_title_from_output(raw), "展台布局调整讨论");
    }

    #[test]
    fn strips_quotes_and_heading() {
        assert_eq!(extract_title_from_output("\"产品发布计划\""), "产品发布计划");
        assert_eq!(extract_title_from_output("# 项目进度同步"), "项目进度同步");
    }

    #[test]
    fn empty_input_returns_empty() {
        assert_eq!(extract_title_from_output(""), "");
    }
}

