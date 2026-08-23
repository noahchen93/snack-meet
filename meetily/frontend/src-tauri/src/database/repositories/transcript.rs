use crate::api::{TranscriptSearchResult, TranscriptSegment};
use chrono::Utc;
use sqlx::{Connection, Error as SqlxError, SqlitePool};
use std::collections::{HashMap, HashSet};
use tracing::{error, info};
use uuid::Uuid;

pub struct TranscriptsRepository;

impl TranscriptsRepository {
    /// Saves a new meeting and its associated transcript segments.
    /// This function uses a transaction to ensure that either both the meeting
    /// and all its transcripts are saved, or none of them are.
    pub async fn save_transcript(
        pool: &SqlitePool,
        meeting_title: &str,
        transcripts: &[TranscriptSegment],
        folder_path: Option<String>,
    ) -> Result<String, SqlxError> {
        let meeting_id = format!("meeting-{}", Uuid::new_v4());

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        let now = Utc::now();

        // 1. Create the new meeting
        let result = sqlx::query(
            "INSERT INTO meetings (id, title, created_at, updated_at, folder_path) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&meeting_id)
        .bind(meeting_title)
        .bind(now)
        .bind(now)
        .bind(&folder_path)
        .execute(&mut *transaction)
        .await;

        if let Err(e) = result {
            error!("Failed to create meeting '{}': {}", meeting_title, e);
            transaction.rollback().await?;
            return Err(e);
        }

        info!("Successfully created meeting with id: {}", meeting_id);

        // 2. Save each transcript segment with audio timing fields
        for segment in transcripts {
            let transcript_id = format!("transcript-{}", Uuid::new_v4());
            let result = sqlx::query(
                "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration, speaker)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(&transcript_id)
            .bind(&meeting_id)
            .bind(&segment.text)
            .bind(&segment.timestamp)
            .bind(segment.audio_start_time)
            .bind(segment.audio_end_time)
            .bind(segment.duration)
            .bind(&segment.speaker)
            .execute(&mut *transaction)
            .await;

            if let Err(e) = result {
                error!(
                    "Failed to save transcript segment for meeting {}: {}",
                    meeting_id, e
                );
                transaction.rollback().await?;
                return Err(e);
            }
        }

        info!(
            "Successfully saved {} transcript segments for meeting {}",
            transcripts.len(),
            meeting_id
        );

        // Commit the transaction
        transaction.commit().await?;

        Ok(meeting_id)
    }

    /// Global text search across meeting title, full transcript, original
    /// transcript segments, generated summary and legacy summary fields.
    /// Results are grouped by meeting so the UI never renders one duplicate
    /// card per matching transcript segment.
    pub async fn search_transcripts(
        pool: &SqlitePool,
        query: &str,
    ) -> Result<Vec<TranscriptSearchResult>, SqlxError> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }

        let escaped = query
            .trim()
            .to_lowercase()
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let search_query = format!("%{escaped}%");

        // JSON summaries store the visible report in $.markdown. The CASE
        // keeps legacy/plain-text and malformed rows searchable as well.
        let rows = sqlx::query_as::<_, (String, String, String, String, String, i64, String, i64)>(
            r#"
            WITH searchable AS (
                SELECT m.id, m.title, m.title AS content, '' AS timestamp,
                       'title' AS match_type, 500 AS priority, m.updated_at
                FROM meetings m

                UNION ALL

                SELECT m.id, m.title, t.transcript AS content, t.timestamp,
                       'original' AS match_type, 300 AS priority, m.updated_at
                FROM meetings m
                JOIN transcripts t ON t.meeting_id = m.id

                UNION ALL

                SELECT m.id, m.title, tc.transcript_text AS content, '' AS timestamp,
                       'transcript' AS match_type, 350 AS priority, m.updated_at
                FROM meetings m
                JOIN transcript_chunks tc ON tc.meeting_id = m.id

                UNION ALL

                SELECT m.id, m.title,
                       CASE
                         WHEN json_valid(sp.result) THEN COALESCE(
                           json_extract(sp.result, '$.markdown'),
                           json_extract(sp.result, '$.data.markdown'),
                           sp.result
                         )
                         ELSE sp.result
                       END AS content,
                       '' AS timestamp, 'summary' AS match_type,
                       400 AS priority, m.updated_at
                FROM meetings m
                JOIN summary_processes sp ON sp.meeting_id = m.id
                WHERE sp.result IS NOT NULL AND sp.result <> ''

                UNION ALL

                SELECT m.id, m.title,
                       COALESCE(t.summary, '') || ' ' ||
                       COALESCE(t.key_points, '') || ' ' ||
                       COALESCE(t.action_items, '') AS content,
                       t.timestamp, 'summary' AS match_type,
                       390 AS priority, m.updated_at
                FROM meetings m
                JOIN transcripts t ON t.meeting_id = m.id
                WHERE COALESCE(t.summary, '') <> ''
                   OR COALESCE(t.key_points, '') <> ''
                   OR COALESCE(t.action_items, '') <> ''
            ), matching AS (
                SELECT id, title, content, timestamp, match_type, priority, updated_at,
                       COUNT(*) OVER (PARTITION BY id, match_type) AS source_match_count,
                       ROW_NUMBER() OVER (
                           PARTITION BY id, match_type
                           ORDER BY timestamp ASC
                       ) AS source_row
                FROM searchable
                WHERE LOWER(content) LIKE ? ESCAPE '\'
            )
            SELECT id, title, content, timestamp, match_type, priority, updated_at,
                   source_match_count
            FROM matching
            WHERE source_row = 1
            ORDER BY priority DESC, updated_at DESC, timestamp ASC
            "#,
        )
        .bind(&search_query)
        .fetch_all(pool)
        .await?;

        struct AggregatedMatch {
            result: TranscriptSearchResult,
            sources: HashSet<String>,
            best_priority: i64,
            context_priority: i64,
            updated_at: String,
        }

        let mut grouped: HashMap<String, AggregatedMatch> = HashMap::new();
        for (id, title, content, timestamp, match_type, priority, updated_at, source_match_count) in
            rows
        {
            let context = Self::get_match_context(&content, query);
            let context_priority = if match_type == "title" { 0 } else { priority };
            let entry = grouped
                .entry(id.clone())
                .or_insert_with(|| AggregatedMatch {
                    result: TranscriptSearchResult {
                        id,
                        title,
                        match_context: context.clone(),
                        timestamp: timestamp.clone(),
                        match_types: Vec::new(),
                        match_count: 0,
                    },
                    sources: HashSet::new(),
                    best_priority: priority,
                    context_priority,
                    updated_at,
                });

            entry.result.match_count += source_match_count.max(0) as usize;
            if entry.sources.insert(match_type.clone()) {
                entry.result.match_types.push(match_type);
            }
            entry.best_priority = entry.best_priority.max(priority);
            if context_priority > entry.context_priority {
                entry.context_priority = context_priority;
                entry.result.match_context = context;
                entry.result.timestamp = timestamp;
            }
        }

        let mut results: Vec<AggregatedMatch> = grouped.into_values().collect();
        results.sort_by(|left, right| {
            right
                .best_priority
                .cmp(&left.best_priority)
                .then_with(|| right.updated_at.cmp(&left.updated_at))
        });
        Ok(results.into_iter().map(|item| item.result).collect())
    }

    /// Helper function to extract a snippet of text around the first match of a query.
    fn get_match_context(transcript: &str, query: &str) -> String {
        let transcript_lower = transcript.to_lowercase();
        let query_lower = query.to_lowercase();

        match transcript_lower.find(&query_lower) {
            Some(match_index) => {
                // `str::find` returns a byte offset. Convert it to character
                // offsets before slicing so Chinese, emoji and other multibyte
                // text can never panic on a non-UTF-8 boundary.
                let match_char_index = transcript_lower[..match_index].chars().count();
                let query_char_len = query_lower.chars().count();
                let transcript_chars: Vec<char> = transcript.chars().collect();
                let start_index = match_char_index.saturating_sub(100);
                let end_index =
                    (match_char_index + query_char_len + 100).min(transcript_chars.len());

                let mut context = String::new();
                if start_index > 0 {
                    context.push_str("...");
                }
                context.extend(transcript_chars[start_index..end_index].iter());
                if end_index < transcript_chars.len() {
                    context.push_str("...");
                }
                context
            }
            None => transcript.chars().take(200).collect(), // Fallback to the start of the transcript
        }
    }
}

#[cfg(test)]
mod tests {
    use super::TranscriptsRepository;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn search_test_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create in-memory database");
        sqlx::raw_sql(
            r#"
            CREATE TABLE meetings (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE transcripts (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL,
                transcript TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                summary TEXT,
                action_items TEXT,
                key_points TEXT
            );
            CREATE TABLE transcript_chunks (
                meeting_id TEXT PRIMARY KEY,
                transcript_text TEXT NOT NULL
            );
            CREATE TABLE summary_processes (
                meeting_id TEXT PRIMARY KEY,
                result TEXT
            );
            "#,
        )
        .execute(&pool)
        .await
        .expect("create search tables");
        pool
    }

    #[test]
    fn match_context_handles_chinese_boundaries() {
        let transcript = format!(
            "{}腾讯会议讨论了产品路线{}",
            "前".repeat(120),
            "后".repeat(120)
        );
        let context = TranscriptsRepository::get_match_context(&transcript, "产品路线");
        assert!(context.contains("产品路线"));
        assert!(context.starts_with("..."));
        assert!(context.ends_with("..."));
    }

    #[test]
    fn match_context_handles_emoji() {
        let context = TranscriptsRepository::get_match_context("计划🙂确认下一步行动", "确认");
        assert_eq!(context, "计划🙂确认下一步行动");
    }

    #[tokio::test]
    async fn global_search_groups_all_text_sources_by_meeting() {
        let pool = search_test_pool().await;
        sqlx::query("INSERT INTO meetings (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .bind("meeting-1")
            .bind("火星计划产品讨论")
            .bind("2026-08-13T09:00:00Z")
            .bind("2026-08-13T10:00:00Z")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO transcripts (id, meeting_id, transcript, timestamp) VALUES (?, ?, ?, ?)",
        )
        .bind("segment-1")
        .bind("meeting-1")
        .bind("原文记录了火星计划")
        .bind("00:01:00")
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO transcript_chunks (meeting_id, transcript_text) VALUES (?, ?)")
            .bind("meeting-1")
            .bind("转写全文也包含火星计划")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO summary_processes (meeting_id, result) VALUES (?, ?)")
            .bind("meeting-1")
            .bind(r##"{"markdown":"# 总结\n火星计划将在下周继续。","english_cache":"not searchable"}"##)
            .execute(&pool)
            .await
            .unwrap();

        let results = TranscriptsRepository::search_transcripts(&pool, "火星计划")
            .await
            .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "meeting-1");
        assert_eq!(results[0].match_count, 4);
        assert_eq!(
            results[0].match_types,
            vec!["title", "summary", "transcript", "original"]
        );
        assert!(results[0].match_context.contains("下周继续"));
    }

    #[tokio::test]
    async fn global_search_treats_sql_wildcards_as_literal_text() {
        let pool = search_test_pool().await;
        for (id, title) in [("literal", "预算100%"), ("wildcard", "预算100X")] {
            sqlx::query(
                "INSERT INTO meetings (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            )
            .bind(id)
            .bind(title)
            .bind("2026-08-13T09:00:00Z")
            .bind("2026-08-13T10:00:00Z")
            .execute(&pool)
            .await
            .unwrap();
        }

        let results = TranscriptsRepository::search_transcripts(&pool, "100%")
            .await
            .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "literal");
    }
}
