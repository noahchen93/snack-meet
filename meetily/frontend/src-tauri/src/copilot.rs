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
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Maximum transcript context characters sent to the LLM in one call. This keeps
/// requests fast and cheap while still covering several minutes of speech.
const MAX_CONTEXT_CHARS: usize = 8_000;

/// Resolve the configured LLM provider, its key, and endpoints from the database,
/// mirroring summary/service.rs. Returns (provider, model, api_key,
/// ollama_endpoint, custom_openai_config).
async fn resolve_llm_config(
    pool: &sqlx::SqlitePool,
) -> Result<
    (
        LLMProvider,
        String,
        String,
        Option<String>,
        Option<CustomOpenAIConfig>,
    ),
    String,
> {
    let model_config = SettingsRepository::get_model_config(pool)
        .await
        .map_err(|e| format!("Failed to read LLM config: {e}"))?
        .ok_or_else(|| {
            "No LLM provider configured. Please configure one in Settings.".to_string()
        })?;

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
    Ok((
        provider,
        model,
        api_key,
        ollama_endpoint,
        custom_openai_config,
    ))
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

async fn resolve_llm_connection<R: Runtime>(app: &AppHandle<R>) -> Result<LlmConnection, String> {
    let app_state = app.state::<AppState>();
    let pool = app_state.db_manager.pool();

    let (provider, model, api_key, ollama_endpoint, custom_openai_config) =
        resolve_llm_config(pool).await?;

    let (custom_endpoint, temperature, top_p) = match &custom_openai_config {
        Some(cfg) => (Some(cfg.endpoint.clone()), cfg.temperature, cfg.top_p),
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
                cleaned.split_once(':').map(|(prefix, rest)| {
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
    let segments: Vec<String> = sqlx::query_scalar(
        "SELECT transcript FROM transcripts WHERE meeting_id = ? ORDER BY timestamp ASC",
    )
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
    if let Err(e) = crate::database::repositories::meeting::MeetingsRepository::update_meeting_name(
        &pool,
        &meeting_id,
        &title,
    )
    .await
    {
        info!(
            "Smart rename: failed to update meeting name for {}: {}",
            meeting_id, e
        );
        return Err(format!("Failed to update meeting name: {e}"));
    }

    // Rename the recording folder on disk.
    if let Err(e) =
        crate::summary::service::SummaryService::rename_meeting_folder(&pool, &meeting_id, &title)
            .await
    {
        info!(
            "Smart rename: folder rename for {} failed: {}",
            meeting_id, e
        );
    }

    info!("✅ Smart-renamed meeting {} → '{}'", meeting_id, title);
    Ok(Some(title))
}

/// A single message in the AI Copilot conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CopilotMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug)]
struct CopilotContextCandidate {
    id: String,
    title: String,
    created_at: String,
    transcript: String,
    summary: String,
    score: usize,
}

fn is_loopback_ollama_endpoint(endpoint: Option<&str>) -> bool {
    let Some(endpoint) = endpoint.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    let lower = endpoint.to_lowercase();
    lower.starts_with("http://localhost")
        || lower.starts_with("https://localhost")
        || lower.starts_with("http://127.0.0.1")
        || lower.starts_with("https://127.0.0.1")
        || lower.starts_with("http://[::1]")
        || lower.starts_with("https://[::1]")
}

fn is_local_connection(connection: &LlmConnection) -> bool {
    match connection.provider {
        LLMProvider::BuiltInAI => true,
        LLMProvider::Ollama => {
            !connection.model.to_lowercase().contains(":cloud")
                && is_loopback_ollama_endpoint(connection.ollama_endpoint.as_deref())
        }
        _ => false,
    }
}

pub(crate) async fn configured_llm_status<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(String, String, bool), String> {
    let connection = resolve_llm_connection(app).await?;
    let is_local = is_local_connection(&connection);
    Ok((
        format!("{:?}", connection.provider),
        connection.model,
        is_local,
    ))
}

/// Run corpus refinement through the configured summary model. The caller must
/// explicitly choose whether a local provider is required, and cloud providers
/// are hard-blocked unless the UI passes a fresh, action-specific consent flag.
pub(crate) async fn refine_corpus_with_configured_llm<R: Runtime>(
    app: &AppHandle<R>,
    require_local: bool,
    cloud_consent: bool,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<(String, String, bool), String> {
    let connection = resolve_llm_connection(app).await?;
    let local = is_local_connection(&connection);
    if require_local && !local {
        return Err(
            "当前总结模型是云端模型。请选择内置模型或 Ollama 后再使用“本地 AI”，或改选“总结模型/API”。"
                .to_string(),
        );
    }
    if !local && !cloud_consent {
        return Err("使用云端总结模型分析多条会议前，需要单独确认发送范围。".to_string());
    }

    let client = reqwest::Client::new();
    let app_data_dir = app_data_dir_path(app).await.ok();
    let provider_name = format!("{:?}", connection.provider);
    let output = generate_summary(
        &client,
        &connection.provider,
        &connection.model,
        &connection.api_key,
        system_prompt,
        user_prompt,
        connection.ollama_endpoint.as_deref(),
        connection.custom_endpoint.as_deref(),
        Some(1_200),
        connection.temperature.or(Some(0.1)),
        connection.top_p,
        app_data_dir.as_ref(),
        None,
    )
    .await
    .map_err(|error| format!("AI 语料精炼失败：{error}"))?;
    Ok((output, provider_name, local))
}

fn visible_summary(raw: Option<String>) -> String {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return String::new();
    };
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
        if let Some(markdown) = value
            .get("markdown")
            .and_then(|item| item.as_str())
            .or_else(|| {
                value
                    .get("data")
                    .and_then(|data| data.get("markdown"))
                    .and_then(|item| item.as_str())
            })
        {
            return markdown.to_string();
        }
    }
    raw
}

fn retrieval_terms(question: &str) -> Vec<String> {
    const STOP_TERMS: &[&str] = &[
        "什么", "怎么", "哪些", "是否", "可以", "会议", "内容", "关于", "这个", "那个", "请问",
        "帮我", "总结", "please", "what", "which", "about", "meeting", "meetings",
    ];
    let stop_terms: HashSet<&str> = STOP_TERMS.iter().copied().collect();
    let mut seen = HashSet::new();
    let mut terms = Vec::new();

    for word in question
        .to_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| word.len() >= 2 && !stop_terms.contains(*word))
    {
        if seen.insert(word.to_string()) {
            terms.push(word.to_string());
        }
    }

    let chinese: Vec<char> = question
        .chars()
        .filter(|character| ('\u{4e00}'..='\u{9fff}').contains(character))
        .collect();
    for width in [4usize, 3usize, 2usize] {
        if chinese.len() < width {
            continue;
        }
        for start in 0..=chinese.len() - width {
            let term: String = chinese[start..start + width].iter().collect();
            if !stop_terms.contains(term.as_str()) && seen.insert(term.clone()) {
                terms.push(term);
            }
            if terms.len() >= 64 {
                return terms;
            }
        }
    }
    terms
}

fn term_score(text: &str, terms: &[String], weight: usize) -> usize {
    let lower = text.to_lowercase();
    terms
        .iter()
        .map(|term| lower.matches(term).count().min(5) * weight * term.chars().count())
        .sum()
}

fn relevant_snippet(text: &str, terms: &[String], max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max_chars {
        return text.to_string();
    }
    let lower = text.to_lowercase();
    let match_index = terms
        .iter()
        .filter_map(|term| lower.find(term))
        .map(|byte_index| lower[..byte_index].chars().count())
        .min()
        .unwrap_or(0);
    let start = match_index.saturating_sub(max_chars / 3);
    let end = (start + max_chars).min(chars.len());
    let mut snippet: String = chars[start..end].iter().collect();
    if start > 0 {
        snippet.insert_str(0, "…");
    }
    if end < chars.len() {
        snippet.push('…');
    }
    snippet
}

async fn load_copilot_candidates(
    pool: &sqlx::SqlitePool,
    scope: &str,
    meeting_id: Option<&str>,
    collection_id: Option<&str>,
) -> Result<Vec<CopilotContextCandidate>, String> {
    let (condition, scope_id) = match scope {
        "meeting" => (
            "m.id = ?",
            meeting_id.ok_or_else(|| "请选择要问答的会议。".to_string())?,
        ),
        "collection" => (
            "m.collection_id = ? AND m.is_archived = 0",
            collection_id.ok_or_else(|| "请选择要问答的文件夹。".to_string())?,
        ),
        "all" => ("? = '' AND m.is_archived = 0", ""),
        _ => return Err("不支持的 AI 问答范围。".to_string()),
    };
    let query = format!(
        r#"
        SELECT m.id, m.title, m.created_at,
               COALESCE(tc.transcript_text, (
                   SELECT GROUP_CONCAT(t.transcript, CHAR(10))
                   FROM transcripts t WHERE t.meeting_id = m.id
               ), '') AS transcript,
               sp.result AS summary
        FROM meetings m
        LEFT JOIN transcript_chunks tc ON tc.meeting_id = m.id
        LEFT JOIN summary_processes sp ON sp.meeting_id = m.id AND sp.result IS NOT NULL
        WHERE {condition}
        ORDER BY m.created_at DESC
        "#
    );
    let rows = sqlx::query_as::<_, (String, String, String, String, Option<String>)>(&query)
        .bind(scope_id)
        .fetch_all(pool)
        .await
        .map_err(|error| format!("读取 AI 问答资料失败：{error}"))?;

    Ok(rows
        .into_iter()
        .map(
            |(id, title, created_at, transcript, summary)| CopilotContextCandidate {
                id,
                title,
                created_at,
                transcript,
                summary: visible_summary(summary),
                score: 0,
            },
        )
        .filter(|candidate| {
            !candidate.transcript.trim().is_empty() || !candidate.summary.trim().is_empty()
        })
        .collect())
}

fn select_copilot_context(
    mut candidates: Vec<CopilotContextCandidate>,
    question: &str,
) -> (String, usize) {
    let terms = retrieval_terms(question);
    for candidate in &mut candidates {
        candidate.score = term_score(&candidate.title, &terms, 12)
            + term_score(&candidate.summary, &terms, 5)
            + term_score(&candidate.transcript, &terms, 1);
    }
    candidates.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| right.created_at.cmp(&left.created_at))
    });

    let selected: Vec<_> = candidates.into_iter().take(8).collect();
    let selected_count = selected.len();
    let mut context = String::new();
    for candidate in selected {
        context.push_str(&format!(
            "\n<meeting id=\"{}\">\n【会议：{}｜{}】\n",
            candidate.id, candidate.title, candidate.created_at
        ));
        if !candidate.summary.trim().is_empty() {
            context.push_str("【总结】\n");
            context.push_str(&candidate.summary.chars().take(3_000).collect::<String>());
            context.push('\n');
        }
        if !candidate.transcript.trim().is_empty() {
            context.push_str("【相关转写片段】\n");
            context.push_str(&relevant_snippet(&candidate.transcript, &terms, 3_000));
            context.push('\n');
        }
        context.push_str("</meeting>\n");
    }
    (context.chars().take(42_000).collect(), selected_count)
}

/// Chat with an AI copilot that has access to a meeting's transcript and AI
/// summary. The full conversation is sent each turn; the backend attaches the
/// meeting context and answers using the configured summary LLM.
#[command]
pub async fn api_copilot_chat<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: Option<String>,
    collection_id: Option<String>,
    scope: Option<String>,
    messages: Vec<CopilotMessage>,
) -> Result<String, String> {
    let pool = app.state::<AppState>().db_manager.pool().clone();
    let scope = scope.as_deref().unwrap_or("meeting");
    let question = messages
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .map(|message| message.content.trim())
        .filter(|question| !question.is_empty())
        .ok_or_else(|| "请输入要询问的问题。".to_string())?;

    let conn = resolve_llm_connection(&app).await?;
    if scope != "meeting" && !is_local_connection(&conn) {
        return Err("为保护隐私，文件夹和全部会议问答目前仅支持内置模型或 Ollama；未经明确授权不会向云端发送多个会议的内容。".to_string());
    }

    let candidates = load_copilot_candidates(
        &pool,
        scope,
        meeting_id.as_deref(),
        collection_id.as_deref(),
    )
    .await?;
    if candidates.is_empty() {
        return Err("当前问答范围没有可用的转写或总结内容。".to_string());
    }
    let (meeting_context, selected_count) = select_copilot_context(candidates, question);

    let system_prompt =
        "你是 Snack Meet 的会议知识助手。你会拿到一个或多个会议的转写片段和 AI 总结。\
        只能根据提供的会议资料回答；没有依据时必须明确说明，不要编造。\
        跨会议回答应综合、比较和去重。提到某个结论、行动项或事实时，请使用《会议标题》标明来源。\
        使用与用户问题相同的语言，表达简洁、准确。";

    let mut user_prompt = String::new();
    user_prompt.push_str(&format!(
        "<meeting_context scope=\"{}\" selected_meetings=\"{}\">\n",
        scope, selected_count
    ));
    user_prompt.push_str(&meeting_context);
    user_prompt.push_str("</meeting_context>\n\n");
    user_prompt.push_str("【对话记录】\n");
    for m in &messages {
        let role_label = if m.role == "assistant" {
            "助手"
        } else {
            "用户"
        };
        user_prompt.push_str(&format!("{role_label}: {}\n", m.content));
    }
    user_prompt.push_str("\n请回答用户最新的问题。");

    let client = reqwest::Client::new();
    let app_data_dir = app_data_dir_path(&app).await.ok();

    generate_summary(
        &client,
        &conn.provider,
        &conn.model,
        &conn.api_key,
        system_prompt,
        &user_prompt,
        conn.ollama_endpoint.as_deref(),
        conn.custom_endpoint.as_deref(),
        None,
        conn.temperature,
        conn.top_p,
        app_data_dir.as_ref(),
        None,
    )
    .await
    .map_err(|e| format!("AI 问答失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::{
        extract_title_from_output, is_local_connection, relevant_snippet, retrieval_terms,
        term_score, LlmConnection,
    };
    use crate::summary::llm_client::LLMProvider;

    fn ollama_connection(model: &str, endpoint: Option<&str>) -> LlmConnection {
        LlmConnection {
            provider: LLMProvider::Ollama,
            model: model.to_string(),
            api_key: String::new(),
            ollama_endpoint: endpoint.map(str::to_string),
            custom_endpoint: None,
            temperature: None,
            top_p: None,
        }
    }

    #[test]
    fn ollama_cloud_models_are_not_classified_as_local() {
        assert!(!is_local_connection(&ollama_connection(
            "deepseek-v4-flash:cloud",
            None
        )));
        assert!(!is_local_connection(&ollama_connection(
            "qwen3:8b",
            Some("https://ollama.example.com")
        )));
        assert!(is_local_connection(&ollama_connection(
            "qwen3:8b",
            Some("http://127.0.0.1:11434")
        )));
    }

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
        assert_eq!(
            extract_title_from_output("\"产品发布计划\""),
            "产品发布计划"
        );
        assert_eq!(extract_title_from_output("# 项目进度同步"), "项目进度同步");
    }

    #[test]
    fn empty_input_returns_empty() {
        assert_eq!(extract_title_from_output(""), "");
    }

    #[test]
    fn chinese_question_produces_retrieval_terms() {
        let terms = retrieval_terms("关于火星计划的预算有什么决定？");
        assert!(terms.iter().any(|term| term.contains("火星计划")));
        assert!(terms.iter().any(|term| term == "预算"));
        assert!(!terms.iter().any(|term| term == "什么"));
    }

    #[test]
    fn title_match_ranks_above_incidental_transcript_match() {
        let terms = vec!["预算".to_string()];
        assert!(term_score("预算评审", &terms, 12) > term_score("提到了预算", &terms, 1));
    }

    #[test]
    fn relevant_snippet_keeps_match_context() {
        let text = format!("{}火星计划预算通过{}", "前".repeat(500), "后".repeat(500));
        let snippet = relevant_snippet(text.as_str(), &["火星计划".to_string()], 700);
        assert!(snippet.contains("火星计划预算通过"));
        assert!(snippet.chars().count() <= 702);
    }
}
