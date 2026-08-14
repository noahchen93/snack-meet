//! Local-first tag management and corpus analysis.
//!
//! No transcript text leaves the machine: callers must pass an explicit consent
//! flag and the command only returns aggregate statistics and short term labels.

use crate::state::AppState;
use chrono::{DateTime, Datelike, Timelike};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::collections::{BTreeMap, HashMap, HashSet};
use tauri::{AppHandle, Manager, Runtime};

const MAX_WORDS: usize = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagStat {
    pub name: String,
    pub meeting_count: usize,
    pub percentage: f64,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagDashboard {
    pub tags: Vec<TagStat>,
    pub tagged_meeting_count: usize,
    pub summarized_meeting_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordFrequency {
    pub word: String,
    pub count: usize,
    pub meeting_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartBucket {
    pub label: String,
    pub meeting_count: usize,
    pub character_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HabitMetric {
    pub label: String,
    pub count: usize,
    pub per_ten_thousand_chars: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusOverview {
    pub meeting_count: usize,
    pub character_count: usize,
    pub term_count: usize,
    pub unique_term_count: usize,
    pub average_characters_per_meeting: usize,
    pub question_count: usize,
    pub lexical_diversity: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusAnalysis {
    pub overview: CorpusOverview,
    pub words: Vec<WordFrequency>,
    pub monthly_activity: Vec<ChartBucket>,
    pub weekday_activity: Vec<ChartBucket>,
    pub time_of_day_activity: Vec<ChartBucket>,
    pub habits: Vec<HabitMetric>,
    pub analysis_engine: String,
    pub ai_refinement: Option<AiRefinement>,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusAiStatus {
    pub configured: bool,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub is_local: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRefinement {
    pub provider: String,
    pub is_local: bool,
    pub insights: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RawAiRefinement {
    #[serde(default, alias = "terms", alias = "selected_terms")]
    keywords: Vec<String>,
    #[serde(default)]
    insights: Vec<String>,
}

#[derive(Debug)]
struct CorpusDocument {
    created_at: String,
    text: String,
}

fn normalize_tag(value: &str) -> String {
    value.trim().to_lowercase()
}

fn keywords_from_result(raw: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| {
            value
                .get("keywords")
                .and_then(|items| items.as_array())
                .cloned()
        })
        .map(|items| {
            items
                .into_iter()
                .filter_map(|item| item.as_str().map(str::trim).map(str::to_string))
                .filter(|item| !item.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn api_get_tag_dashboard(
    state: tauri::State<'_, AppState>,
) -> Result<TagDashboard, String> {
    let rows = sqlx::query(
        "SELECT sp.meeting_id, sp.result, sp.updated_at \
         FROM summary_processes sp \
         JOIN meetings m ON m.id = sp.meeting_id \
         WHERE sp.status = 'completed' AND sp.result IS NOT NULL AND m.is_archived = 0",
    )
    .fetch_all(state.db_manager.pool())
    .await
    .map_err(|error| format!("读取标签失败：{error}"))?;

    let summarized_meeting_count = rows.len();
    let mut tagged_meetings = HashSet::new();
    let mut stats: HashMap<String, (String, HashSet<String>, Option<String>)> = HashMap::new();
    for row in rows {
        let meeting_id: String = row.try_get("meeting_id").unwrap_or_default();
        let raw: String = row.try_get("result").unwrap_or_default();
        let updated_at: Option<String> = row.try_get("updated_at").ok();
        let mut seen = HashSet::new();
        for keyword in keywords_from_result(&raw) {
            let normalized = normalize_tag(&keyword);
            if normalized.is_empty() || !seen.insert(normalized.clone()) {
                continue;
            }
            tagged_meetings.insert(meeting_id.clone());
            let entry = stats
                .entry(normalized)
                .or_insert_with(|| (keyword.clone(), HashSet::new(), updated_at.clone()));
            entry.1.insert(meeting_id.clone());
            if updated_at > entry.2 {
                entry.2 = updated_at.clone();
            }
        }
    }

    let denominator = tagged_meetings.len().max(1) as f64;
    let mut tags = stats
        .into_values()
        .map(|(name, meetings, last_used_at)| TagStat {
            name,
            meeting_count: meetings.len(),
            percentage: meetings.len() as f64 * 100.0 / denominator,
            last_used_at,
        })
        .collect::<Vec<_>>();
    tags.sort_by(|left, right| {
        right
            .meeting_count
            .cmp(&left.meeting_count)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Ok(TagDashboard {
        tags,
        tagged_meeting_count: tagged_meetings.len(),
        summarized_meeting_count,
    })
}

async fn rewrite_tag(
    pool: &sqlx::SqlitePool,
    old_name: &str,
    replacement: Option<&str>,
) -> Result<usize, String> {
    let old_normalized = normalize_tag(old_name);
    if old_normalized.is_empty() {
        return Err("标签不能为空".to_string());
    }
    let replacement = replacement.map(str::trim).filter(|value| !value.is_empty());
    if replacement.is_some_and(|value| value.chars().count() > 30) {
        return Err("标签最多 30 个字符".to_string());
    }

    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("无法开始标签更新：{error}"))?;
    let rows = sqlx::query(
        "SELECT meeting_id, result FROM summary_processes \
         WHERE status = 'completed' AND result IS NOT NULL",
    )
    .fetch_all(&mut *transaction)
    .await
    .map_err(|error| format!("读取标签失败：{error}"))?;

    let mut updated = 0usize;
    for row in rows {
        let meeting_id: String = row.try_get("meeting_id").unwrap_or_default();
        let raw: String = row.try_get("result").unwrap_or_default();
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(items) = value.get("keywords").and_then(|items| items.as_array()) else {
            continue;
        };
        let mut changed = false;
        let mut deduplicated = HashSet::new();
        let mut next = Vec::new();
        for item in items {
            let Some(keyword) = item.as_str().map(str::trim).filter(|item| !item.is_empty()) else {
                continue;
            };
            let output = if normalize_tag(keyword) == old_normalized {
                changed = true;
                replacement
            } else {
                Some(keyword)
            };
            if let Some(output) = output {
                let normalized = normalize_tag(output);
                if deduplicated.insert(normalized) {
                    next.push(serde_json::Value::String(output.to_string()));
                } else {
                    changed = true;
                }
            }
        }
        if changed {
            value["keywords"] = serde_json::Value::Array(next);
            sqlx::query(
                "UPDATE summary_processes SET result = ?, updated_at = datetime('now') WHERE meeting_id = ?",
            )
            .bind(value.to_string())
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("保存标签失败：{error}"))?;
            updated += 1;
        }
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("提交标签更新失败：{error}"))?;
    Ok(updated)
}

#[tauri::command]
pub async fn api_rename_tag(
    state: tauri::State<'_, AppState>,
    old_name: String,
    new_name: String,
) -> Result<usize, String> {
    rewrite_tag(state.db_manager.pool(), &old_name, Some(&new_name)).await
}

#[tauri::command]
pub async fn api_delete_tag(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<usize, String> {
    rewrite_tag(state.db_manager.pool(), &name, None).await
}

fn is_han(character: char) -> bool {
    matches!(character as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF)
}

fn is_stop_term(term: &str) -> bool {
    const STOP_TERMS: &[&str] = &[
        "这个",
        "那个",
        "然后",
        "就是",
        "但是",
        "因为",
        "所以",
        "如果",
        "还是",
        "可以",
        "可能",
        "我们",
        "你们",
        "他们",
        "自己",
        "一个",
        "一些",
        "这种",
        "那种",
        "现在",
        "觉得",
        "其实",
        "比较",
        "已经",
        "没有",
        "不是",
        "什么",
        "怎么",
        "这里",
        "那里",
        "时候",
        "东西",
        "事情",
        "进行",
        "需要",
        "以及",
        "或者",
        "还有",
        "这样",
        "这么",
        "那么",
        "非常",
        "基本",
        "大家",
        "今天",
        "好的",
        "对的",
        "的话",
        "一下",
        "一点",
        "刚才",
        "应该",
        "能够",
        "开始",
        "最后",
        "目前",
        "关于",
        "通过",
        "之后",
        "之前",
        "the",
        "and",
        "that",
        "this",
        "with",
        "from",
        "have",
        "will",
        "would",
        "there",
        "their",
        "about",
        "just",
        "really",
        "like",
        "yeah",
        "okay",
        "ok",
        "well",
        "then",
        "but",
        "because",
        "what",
        "when",
        "where",
        "which",
        "you",
        "your",
        "we",
        "our",
        "they",
        "them",
        "for",
        "are",
        "was",
        "were",
        "been",
        "can",
        "could",
        "should",
        "me",
        "my",
        "mine",
        "he",
        "him",
        "his",
        "she",
        "her",
        "hers",
        "it",
        "its",
        "us",
        "ours",
        "who",
        "someone",
        "somebody",
        "i'm",
        "you're",
        "we're",
        "我的",
        "你的",
        "他的",
        "她的",
        "它的",
        "咱们",
        "本人",
        "别人",
        "人家",
        "某个",
        "某些",
        "这些",
        "那些",
        "哪个",
        "哪种",
        "这里的",
        "那里的",
        "这边",
        "那边",
        "有的",
        "有个",
        "有一",
        "的是",
        "了的",
        "的吗",
        "的呢",
        "的吧",
        "来说",
        "来讲",
        "而言",
        "而且",
        "并且",
        "并没有",
        "还要",
        "就会",
        "就能",
        "是不是",
        "有没有",
        "为什么",
        "怎么样",
        "这么说",
        "这么做",
        "这么个",
        "那么说",
        "那么做",
        "我说",
        "你说",
        "他说",
        "她说",
        "我想",
        "你想",
        "我看",
        "你看",
        "我这",
        "你这",
        "他这",
        "我那",
        "你那",
        "咱们的",
        "我们的",
        "你们的",
        "他们的",
    ];
    let lower = term.to_lowercase();
    if STOP_TERMS.contains(&lower.as_str()) {
        return true;
    }
    const NOISE_FRAGMENTS: &[&str] = &[
        "我们", "你们", "他们", "咱们", "这个", "那个", "这些", "那些", "的话", "然后", "就是",
        "其实", "可能", "应该", "觉得", "什么", "怎么", "一下", "一点",
    ];
    if lower.chars().count() <= 4
        && NOISE_FRAGMENTS
            .iter()
            .any(|fragment| lower.contains(fragment))
    {
        return true;
    }
    let last = lower.chars().last();
    lower.chars().count() <= 3
        && last.is_some_and(|character| {
            matches!(
                character,
                '的' | '了' | '吗' | '呢' | '啊' | '呀' | '吧' | '嘛' | '哦' | '嗯' | '呃'
            )
        })
}

fn extract_terms(text: &str) -> HashMap<String, usize> {
    let mut terms = HashMap::new();
    let mut latin = String::new();
    let mut han = Vec::new();

    let flush_latin = |buffer: &mut String, output: &mut HashMap<String, usize>| {
        if buffer.chars().count() >= 2
            && !is_stop_term(buffer)
            && !buffer.chars().all(|c| c.is_ascii_digit())
        {
            *output.entry(buffer.to_lowercase()).or_insert(0) += 1;
        }
        buffer.clear();
    };
    let flush_han = |buffer: &mut Vec<char>, output: &mut HashMap<String, usize>| {
        if buffer.len() >= 2 {
            for size in 2..=4 {
                if buffer.len() < size {
                    break;
                }
                for window in buffer.windows(size) {
                    let term = window.iter().collect::<String>();
                    if !is_stop_term(&term) {
                        *output.entry(term).or_insert(0) += 1;
                    }
                }
            }
        }
        buffer.clear();
    };

    for character in text.chars().chain(std::iter::once(' ')) {
        if character.is_ascii_alphanumeric() || character == '\'' {
            flush_han(&mut han, &mut terms);
            latin.push(character.to_ascii_lowercase());
        } else if is_han(character) {
            flush_latin(&mut latin, &mut terms);
            han.push(character);
        } else {
            flush_latin(&mut latin, &mut terms);
            flush_han(&mut han, &mut terms);
        }
    }
    terms
}

fn select_words(
    counts: HashMap<String, usize>,
    meeting_counts: HashMap<String, usize>,
) -> Vec<WordFrequency> {
    let mut candidates = counts
        .into_iter()
        .filter(|(word, count)| *count >= 2 && !is_stop_term(word))
        .collect::<Vec<_>>();
    candidates.sort_by(|(left_word, left_count), (right_word, right_count)| {
        let left_score = *left_count * left_word.chars().count().min(4);
        let right_score = *right_count * right_word.chars().count().min(4);
        right_score
            .cmp(&left_score)
            .then_with(|| right_count.cmp(left_count))
    });

    let mut selected: Vec<(String, usize)> = Vec::new();
    for (word, count) in candidates {
        let overlaps = selected.iter().any(|(existing, existing_count)| {
            (existing.contains(&word) || word.contains(existing))
                && count.min(*existing_count) as f64 / count.max(*existing_count) as f64 > 0.72
        });
        if !overlaps {
            selected.push((word, count));
        }
        if selected.len() == MAX_WORDS {
            break;
        }
    }
    selected
        .into_iter()
        .map(|(word, count)| WordFrequency {
            meeting_count: meeting_counts.get(&word).copied().unwrap_or(0),
            word,
            count,
        })
        .collect()
}

fn count_occurrences_case_insensitive(text: &str, needle: &str) -> usize {
    text.to_lowercase().matches(&needle.to_lowercase()).count()
}

fn parse_created_at(value: &str) -> Option<DateTime<chrono::FixedOffset>> {
    DateTime::parse_from_rfc3339(value).ok()
}

async fn load_documents(
    pool: &sqlx::SqlitePool,
    scope: &str,
    collection_id: Option<&str>,
    tag: Option<&str>,
    text_source: &str,
) -> Result<Vec<CorpusDocument>, String> {
    let rows = sqlx::query(
        "SELECT m.id, m.created_at, m.collection_id, \
                COALESCE((SELECT GROUP_CONCAT(t.transcript, CHAR(10)) FROM transcripts t WHERE t.meeting_id = m.id), '') AS original_text, \
                COALESCE(tc.transcript_text, '') AS translated_text, \
                COALESCE(sp.result, '') AS summary_result \
         FROM meetings m \
         LEFT JOIN transcript_chunks tc ON tc.meeting_id = m.id \
         LEFT JOIN summary_processes sp ON sp.meeting_id = m.id AND sp.status = 'completed' \
         WHERE m.is_archived = 0 ORDER BY m.created_at ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| format!("读取语料失败：{error}"))?;

    let normalized_tag = tag.map(normalize_tag);
    let mut documents = Vec::new();
    for row in rows {
        let row_collection: Option<String> = row.try_get("collection_id").ok();
        if scope == "collection" && row_collection.as_deref() != collection_id {
            continue;
        }
        if scope == "tag" {
            let raw: String = row.try_get("summary_result").unwrap_or_default();
            let matches = normalized_tag.as_ref().is_some_and(|wanted| {
                keywords_from_result(&raw)
                    .iter()
                    .any(|keyword| normalize_tag(keyword) == *wanted)
            });
            if !matches {
                continue;
            }
        }

        let original: String = row.try_get("original_text").unwrap_or_default();
        let translated: String = row.try_get("translated_text").unwrap_or_default();
        let text = match text_source {
            "original" => original,
            "both" if !original.trim().is_empty() && !translated.trim().is_empty() => {
                if original.trim() == translated.trim() {
                    translated
                } else {
                    format!("{translated}\n{original}")
                }
            }
            "both" => format!("{translated}\n{original}"),
            _ if !translated.trim().is_empty() => translated,
            _ => original,
        };
        if text.trim().is_empty() {
            continue;
        }
        documents.push(CorpusDocument {
            created_at: row.try_get("created_at").unwrap_or_default(),
            text,
        });
    }
    Ok(documents)
}

#[tauri::command]
pub async fn api_get_corpus_ai_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<CorpusAiStatus, String> {
    match crate::copilot::configured_llm_status(&app).await {
        Ok((provider, model, is_local)) => Ok(CorpusAiStatus {
            configured: true,
            provider: Some(provider),
            model: Some(model),
            is_local,
        }),
        Err(_) => Ok(CorpusAiStatus {
            configured: false,
            provider: None,
            model: None,
            is_local: false,
        }),
    }
}

fn parse_ai_refinement(raw: &str) -> Result<RawAiRefinement, String> {
    let start = raw
        .find('{')
        .ok_or_else(|| "AI 没有返回可解析的 JSON".to_string())?;
    let end = raw
        .rfind('}')
        .filter(|end| *end >= start)
        .ok_or_else(|| "AI 返回的 JSON 不完整".to_string())?;
    serde_json::from_str(&raw[start..=end])
        .map_err(|error| format!("解析 AI 语料结果失败：{error}"))
}

fn build_local_refinement_prompt(documents: &[CorpusDocument], words: &[WordFrequency]) -> String {
    let candidates = words
        .iter()
        .take(100)
        .map(|word| {
            serde_json::json!({
                "word": word.word,
                "count": word.count,
                "meetingCount": word.meeting_count,
            })
        })
        .collect::<Vec<_>>();
    let stride = (documents.len() + 19) / 20;
    let excerpts = documents
        .iter()
        .step_by(stride.max(1))
        .take(20)
        .enumerate()
        .map(|(index, document)| {
            let chars = document.text.chars().collect::<Vec<_>>();
            let start = chars.len().saturating_sub(600) / 2;
            let end = (start + 600).min(chars.len());
            format!(
                "【节选 {}】{}",
                index + 1,
                chars[start..end].iter().collect::<String>()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "候选词（必须从 word 字段中原样选择）：\n{}\n\n语料节选：\n{}\n\n请输出 JSON。",
        serde_json::to_string(&candidates).unwrap_or_else(|_| "[]".to_string()),
        excerpts
    )
}

async fn refine_words_with_local_ai<R: Runtime>(
    app: &AppHandle<R>,
    documents: &[CorpusDocument],
    words: Vec<WordFrequency>,
) -> Result<(Vec<WordFrequency>, AiRefinement), String> {
    if words.is_empty() {
        return Err("没有足够的候选词供本地 AI 精炼".to_string());
    }
    let system_prompt = "你是一名严谨的中文语料与语用分析师。删除所有语气词、助词、连词、代词、人称指代、泛化动词、口语填充词、切词残片和无意义短语；保留具体主题、项目、产品、组织、行动或概念词，并避免包含关系造成的重复。keywords 必须从给定候选的 word 字段中原样选择 15 到 40 个，不得创造、翻译或改写。insights 输出 3 到 6 条简短、谨慎、可复核的中文观察，不要推断人格、心理或敏感属性。只返回严格 JSON：{\"keywords\":[\"原样候选词\"],\"insights\":[\"观察\"]}。";
    let user_prompt = build_local_refinement_prompt(documents, &words);
    let (raw, provider, is_local) = crate::copilot::refine_corpus_with_configured_llm(
        app,
        true,
        false,
        system_prompt,
        &user_prompt,
    )
    .await?;
    debug_assert!(is_local);
    let refinement = parse_ai_refinement(&raw)?;
    let available = words
        .into_iter()
        .map(|word| (word.word.to_lowercase(), word))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::new();
    let selected = refinement
        .keywords
        .into_iter()
        .filter_map(|keyword| available.get(&keyword.trim().to_lowercase()).cloned())
        .filter(|word| seen.insert(word.word.to_lowercase()))
        .take(50)
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return Err("本地 AI 没有选出有效主题词，请重试或使用快速本机统计。".to_string());
    }
    Ok((
        selected,
        AiRefinement {
            provider,
            is_local,
            insights: refinement
                .insights
                .into_iter()
                .map(|insight| insight.trim().to_string())
                .filter(|insight| !insight.is_empty())
                .take(6)
                .collect(),
        },
    ))
}

#[tauri::command]
pub async fn api_analyze_corpus<R: Runtime>(
    app: AppHandle<R>,
    consent: bool,
    scope: String,
    collection_id: Option<String>,
    tag: Option<String>,
    text_source: Option<String>,
    analysis_engine: Option<String>,
) -> Result<CorpusAnalysis, String> {
    if !consent {
        return Err("需要先授权本机语料分析".to_string());
    }
    if !matches!(scope.as_str(), "all" | "collection" | "tag") {
        return Err("无效的分析范围".to_string());
    }
    if scope == "collection" && collection_id.as_deref().map_or(true, str::is_empty) {
        return Err("请选择一个文件夹".to_string());
    }
    if scope == "tag" && tag.as_deref().map_or(true, str::is_empty) {
        return Err("请选择一个标签".to_string());
    }
    let text_source = text_source.as_deref().unwrap_or("translated");
    if !matches!(text_source, "translated" | "original" | "both") {
        return Err("无效的文字来源".to_string());
    }

    let analysis_engine = analysis_engine.as_deref().unwrap_or("fast");
    if !matches!(analysis_engine, "fast" | "local-ai") {
        return Err("总结模型/API 分析尚未获得云端发送授权。".to_string());
    }
    let pool = app.state::<AppState>().db_manager.pool().clone();
    let documents = load_documents(
        &pool,
        &scope,
        collection_id.as_deref(),
        tag.as_deref(),
        text_source,
    )
    .await?;

    let mut total_counts = HashMap::new();
    let mut meeting_counts = HashMap::new();
    let mut character_count = 0usize;
    let mut question_count = 0usize;
    let mut monthly: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut weekdays = vec![(0usize, 0usize); 7];
    let mut times = vec![(0usize, 0usize); 4];
    const HABITS: &[(&str, &str)] = &[
        ("嗯", "嗯"),
        ("呃", "呃"),
        ("然后", "然后"),
        ("就是", "就是"),
        ("其实", "其实"),
        ("我觉得", "我觉得"),
        ("可能", "可能"),
        ("you know", "you know"),
        ("basically", "basically"),
        ("actually", "actually"),
    ];
    let mut habit_counts = vec![0usize; HABITS.len()];

    for document in &documents {
        let chars = document
            .text
            .chars()
            .filter(|character| !character.is_whitespace())
            .count();
        character_count += chars;
        question_count += document.text.matches(['?', '？']).count();
        let local = extract_terms(&document.text);
        for (word, count) in local {
            *total_counts.entry(word.clone()).or_insert(0) += count;
            *meeting_counts.entry(word).or_insert(0) += 1;
        }
        for (index, (_, needle)) in HABITS.iter().enumerate() {
            habit_counts[index] += count_occurrences_case_insensitive(&document.text, needle);
        }
        if let Some(created) = parse_created_at(&document.created_at) {
            let month = format!("{:04}-{:02}", created.year(), created.month());
            let month_entry = monthly.entry(month).or_insert((0, 0));
            month_entry.0 += 1;
            month_entry.1 += chars;
            let weekday = created.weekday().num_days_from_monday() as usize;
            weekdays[weekday].0 += 1;
            weekdays[weekday].1 += chars;
            let time_index = match created.hour() {
                5..=11 => 0,
                12..=17 => 1,
                18..=22 => 2,
                _ => 3,
            };
            times[time_index].0 += 1;
            times[time_index].1 += chars;
        }
    }

    let term_count = total_counts.values().sum::<usize>();
    let unique_term_count = total_counts.len();
    let mut words = select_words(total_counts, meeting_counts);
    let mut ai_refinement = None;
    if analysis_engine == "local-ai" && !documents.is_empty() {
        let (refined, refinement) = refine_words_with_local_ai(&app, &documents, words).await?;
        words = refined;
        ai_refinement = Some(refinement);
    }
    let to_buckets = |values: Vec<(usize, usize)>, labels: &[&str]| {
        values
            .into_iter()
            .enumerate()
            .map(|(index, (meeting_count, character_count))| ChartBucket {
                label: labels[index].to_string(),
                meeting_count,
                character_count,
            })
            .collect::<Vec<_>>()
    };
    let monthly_activity = monthly
        .into_iter()
        .map(|(label, (meeting_count, character_count))| ChartBucket {
            label,
            meeting_count,
            character_count,
        })
        .collect();
    let denominator = character_count.max(1) as f64;
    let habits = HABITS
        .iter()
        .enumerate()
        .map(|(index, (label, _))| HabitMetric {
            label: (*label).to_string(),
            count: habit_counts[index],
            per_ten_thousand_chars: habit_counts[index] as f64 * 10_000.0 / denominator,
        })
        .filter(|habit| habit.count > 0)
        .collect();

    Ok(CorpusAnalysis {
        overview: CorpusOverview {
            meeting_count: documents.len(),
            character_count,
            term_count,
            unique_term_count,
            average_characters_per_meeting: character_count / documents.len().max(1),
            question_count,
            lexical_diversity: if term_count == 0 {
                0.0
            } else {
                unique_term_count as f64 / term_count as f64
            },
        },
        words,
        monthly_activity,
        weekday_activity: to_buckets(
            weekdays,
            &["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
        ),
        time_of_day_activity: to_buckets(times, &["上午", "下午", "晚上", "深夜"]),
        habits,
        analysis_engine: analysis_engine.to_string(),
        ai_refinement,
        generated_at: chrono::Utc::now().to_rfc3339(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_mixed_language_terms_and_filters_fillers() {
        let terms =
            extract_terms("然后我们讨论产品路线图，你的我的他的 product roadmap product roadmap");
        assert!(!terms.contains_key("然后"));
        assert!(!terms.contains_key("你的"));
        assert!(!terms.contains_key("我的"));
        assert!(!terms.contains_key("他的"));
        assert_eq!(terms.get("product"), Some(&2));
        assert!(terms.contains_key("产品路线"));
    }

    #[test]
    fn parses_json_wrapped_in_model_markdown() {
        let parsed = parse_ai_refinement(
            "```json\n{\"keywords\":[\"产品路线\"],\"insights\":[\"讨论集中\"]}\n```",
        )
        .unwrap();
        assert_eq!(parsed.keywords, vec!["产品路线"]);
        assert_eq!(parsed.insights, vec!["讨论集中"]);
    }

    #[test]
    fn reads_and_normalizes_summary_keywords() {
        let tags = keywords_from_result(r#"{"keywords":[" 产品路线图 ","Budget"]}"#);
        assert_eq!(tags, vec!["产品路线图", "Budget"]);
        assert_eq!(normalize_tag(" Budget "), "budget");
    }
}
