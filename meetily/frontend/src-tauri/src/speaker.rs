// Speaker management module - extract distinct speakers, AI-name them, and
// allow per-segment speaker reassignment.

use crate::state::AppState;
use log::{error as log_error, info as log_info};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistinctSpeaker {
    pub speaker: String,
    pub count: i64,
    pub sample_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuggestedSpeakerName {
    pub speaker: String,
    pub suggested_name: String,
    pub reason: String,
}

/// Returns the distinct speakers for a meeting with their segment counts and a
/// sample utterance each.
#[tauri::command]
pub async fn api_get_distinct_speakers(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<Vec<DistinctSpeaker>, String> {
    let pool = state.db_manager.pool();
    let rows = sqlx::query_as::<_, (String, i64, String)>(
        "SELECT speaker, COUNT(*) AS cnt, COALESCE(MAX(transcript), '') AS sample \
         FROM transcripts \
         WHERE meeting_id = ? AND speaker IS NOT NULL AND TRIM(speaker) != '' \
         GROUP BY speaker ORDER BY cnt DESC",
    )
    .bind(&meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to list speakers: {}", e))?;

    Ok(rows
        .into_iter()
        .map(|(speaker, count, sample_text)| DistinctSpeaker {
            speaker,
            count,
            sample_text: sample_text.chars().take(120).collect(),
        })
        .collect())
}

/// Reassigns a single transcript segment to another speaker.
#[tauri::command]
pub async fn api_update_transcript_speaker(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    transcript_id: String,
    speaker: String,
) -> Result<(), String> {
    let pool = state.db_manager.pool();
    let speaker = speaker.trim().to_string();
    if speaker.is_empty() {
        return Err("Speaker name cannot be empty".to_string());
    }
    sqlx::query("UPDATE transcripts SET speaker = ? WHERE id = ? AND meeting_id = ?")
        .bind(&speaker)
        .bind(&transcript_id)
        .bind(&meeting_id)
        .execute(pool)
        .await
        .map_err(|e| format!("Failed to update speaker: {}", e))?;
    Ok(())
}

/// Renames a speaker label across the whole meeting (all segments with `from`).
#[tauri::command]
pub async fn api_rename_speaker(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    from_speaker: String,
    to_speaker: String,
) -> Result<i64, String> {
    let pool = state.db_manager.pool();
    let to = to_speaker.trim().to_string();
    if to.is_empty() {
        return Err("Speaker name cannot be empty".to_string());
    }
    let result =
        sqlx::query("UPDATE transcripts SET speaker = ? WHERE meeting_id = ? AND speaker = ?")
            .bind(&to)
            .bind(&meeting_id)
            .bind(&from_speaker)
            .execute(pool)
            .await
            .map_err(|e| format!("Failed to rename speaker: {}", e))?;
    Ok(result.rows_affected() as i64)
}

/// Uses the configured summary LLM to suggest real names for each distinct
/// speaker label based on the meeting's utterances.
#[tauri::command]
pub async fn api_suggest_speaker_names<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<Vec<SuggestedSpeakerName>, String> {
    use crate::database::repositories::setting::SettingsRepository;
    use crate::summary::llm_client::{generate_summary, LLMProvider};

    let pool = state.db_manager.pool();

    // Resolve provider / model / endpoint / api key (mirrors summary service).
    let config = SettingsRepository::get_model_config(pool)
        .await
        .map_err(|e| format!("Failed to read model config: {}", e))?
        .ok_or_else(|| "未配置总结模型".to_string())?;
    if config.provider.is_empty() || config.model.is_empty() {
        return Err("总结模型未配置".to_string());
    }
    let provider = LLMProvider::from_str(&config.provider).map_err(|e| e)?;
    let api_key = if provider == LLMProvider::Ollama
        || provider == LLMProvider::BuiltInAI
        || provider == LLMProvider::CustomOpenAI
    {
        String::new()
    } else {
        SettingsRepository::get_api_key(pool, &config.provider)
            .await
            .map_err(|e| format!("Failed to read API key: {}", e))?
            .ok_or_else(|| "未找到该模型的 API Key".to_string())?
    };
    let ollama_endpoint = if provider == LLMProvider::Ollama {
        config.ollama_endpoint.clone()
    } else {
        None
    };
    let custom_openai = if provider == LLMProvider::CustomOpenAI {
        SettingsRepository::get_custom_openai_config(pool)
            .await
            .map_err(|e| format!("Failed to read custom OpenAI config: {}", e))?
    } else {
        None
    };
    let custom_openai_endpoint = custom_openai.as_ref().map(|c| c.endpoint.clone());
    let custom_openai_api_key = custom_openai.as_ref().and_then(|c| c.api_key.clone());
    let final_api_key = if provider == LLMProvider::CustomOpenAI {
        custom_openai_api_key.unwrap_or_default()
    } else {
        api_key
    };

    // Build a compact per-speaker digest to feed the model.
    let segments: Vec<(String, String)> = sqlx::query_as(
        "SELECT speaker, transcript FROM transcripts \
         WHERE meeting_id = ? AND speaker IS NOT NULL AND TRIM(speaker) != '' \
         ORDER BY timestamp ASC",
    )
    .bind(&meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to read transcripts: {}", e))?;

    // Group utterances per speaker, keep a few short samples each.
    let mut by_speaker: std::collections::BTreeMap<String, Vec<String>> =
        std::collections::BTreeMap::new();
    for (speaker, text) in &segments {
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let bucket = by_speaker.entry(speaker.clone()).or_default();
        if bucket.len() < 4 {
            let short: String = text.chars().take(100).collect();
            if !bucket.contains(&short) {
                bucket.push(short);
            }
        }
    }
    if by_speaker.is_empty() {
        return Ok(Vec::new());
    }

    let mut digest = String::new();
    for (speaker, samples) in &by_speaker {
        digest.push_str(&format!(
            "## 说话人标签: {}\n{}\n",
            speaker,
            samples
                .iter()
                .map(|s| format!("- \"{s}\""))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }

    let system_prompt = "你是一名会议说话人识别助手。根据说话内容推断每位说话人的身份与称呼，\
        用会议使用的语言命名（中文会议用中文名，如“张三”或“产品经理”）。\
        只输出 JSON 数组，不要任何其他文字或代码块围栏。数组元素格式：\
        [{\"speaker\":\"原标签\",\"suggested_name\":\"建议称呼\",\"reason\":\"一句依据\"}]";

    let user_prompt = format!(
        "<speaker_utterances>\n{digest}\n</speaker_utterances>\n\n请为每位说话人生成 JSON 数组。"
    );

    let client = reqwest::Client::new();
    let raw = generate_summary(
        &client,
        &provider,
        &config.model,
        &final_api_key,
        system_prompt,
        &user_prompt,
        ollama_endpoint.as_deref(),
        custom_openai_endpoint.as_deref(),
        None,
        None,
        None,
        app.path().app_data_dir().ok().as_ref(),
        None,
    )
    .await
    .map_err(|e| format!("AI 说话人命名失败：{}", e))?;

    // Strip code fences if the model wrapped the JSON.
    let cleaned = raw
        .trim()
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let array_start = cleaned.find('[');
    let array_end = cleaned.rfind(']');
    let json_slice = match (array_start, array_end) {
        (Some(a), Some(b)) if b > a => &cleaned[a..=b],
        _ => cleaned,
    };

    let parsed: Vec<SuggestedSpeakerName> = serde_json::from_str(json_slice).map_err(|e| {
        log_error!("Failed to parse suggested speaker names: {} raw={}", e, raw);
        format!("AI 返回的说话人命名无法解析：{}", e)
    })?;

    // Only keep suggestions that map to real labels and have non-empty names.
    let valid: Vec<SuggestedSpeakerName> = parsed
        .into_iter()
        .filter(|s| !s.speaker.trim().is_empty() && !s.suggested_name.trim().is_empty())
        .collect();
    log_info!(
        "AI speaker naming returned {} suggestions for meeting {}",
        valid.len(),
        meeting_id
    );
    Ok(valid)
}
