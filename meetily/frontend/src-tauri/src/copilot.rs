//! Smart meeting renaming — generate a concise, content-based Chinese title
//! from a meeting's transcript and apply it to the DB meeting name and the
//! recording folder. This runs right after a recording is saved, independent
//! of the AI summary flow, so it works even if summarization fails.
//!
//! It reuses the same LLM provider configuration (provider / model / api key /
//! endpoints) as meeting summaries, so no separate setup is needed.

use tauri::{command, AppHandle, Manager, Runtime};
use tracing::info;

use crate::database::repositories::setting::SettingsRepository;
use crate::state::AppState;
use crate::summary::llm_client::{generate_summary, LLMProvider};
use crate::summary::CustomOpenAIConfig;

/// Maximum transcript context characters sent to the LLM in one call. This keeps
/// requests fast and cheap while still covering several minutes of speech.
const MAX_CONTEXT_CHARS: usize = 8_000;

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

/// Resolved LLM connection parameters shared by the smart-rename path.
struct LlmConnection {
    provider: LLMProvider,
    model: String,
    api_key: String,
    ollama_endpoint: Option<String>,
    custom_endpoint: Option<String>,
    temperature: Option<f32>,
    top_p: Option<f32>,
}

async fn resolve_llm_connection<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<LlmConnection, String> {
    let app_state = app.state::<AppState>();
    let pool = app_state.db_manager.pool();

    let (provider, model, api_key, ollama_endpoint, custom_openai_config) =
        resolve_llm_config(pool).await?;

    let (custom_endpoint, temperature, top_p) = match &custom_openai_config {
        Some(cfg) => (
            Some(cfg.endpoint.clone()),
            cfg.temperature,
            cfg.top_p,
        ),
        None => (None, None, None),
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
        temperature,
        top_p,
    })
}

/// Generate a concise meeting title from a transcript using the summary LLM
/// config. Returns a short string safe for use as a folder/file name.
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
pub async fn smart_rename_meeting<R: Runtime>(
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
