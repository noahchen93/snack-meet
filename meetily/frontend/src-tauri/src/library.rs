use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::path::Path;
use tauri::{AppHandle, Runtime, State};
use uuid::Uuid;

use crate::state::AppState;
use crate::summary::metadata::{read_metadata_json, update_metadata_fields};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryCollection {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    #[serde(rename = "sortOrder")]
    pub sort_order: i64,
    #[serde(rename = "meetingCount")]
    pub meeting_count: i64,
}

fn normalize_collection_name(name: &str) -> Result<String, String> {
    let normalized = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return Err("文件夹名称不能为空。".to_string());
    }
    if normalized.chars().count() > 60 {
        return Err("文件夹名称不能超过 60 个字符。".to_string());
    }
    Ok(normalized)
}

async fn collection_exists(pool: &sqlx::SqlitePool, id: &str) -> Result<bool, String> {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM collections WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map(|count| count > 0)
        .map_err(|error| format!("检查文件夹失败：{error}"))
}

async fn persist_meeting_organization(pool: &sqlx::SqlitePool, meeting_ids: &[String]) {
    for meeting_id in meeting_ids {
        let row = sqlx::query(
            r#"
            SELECT m.folder_path, m.is_archived, m.is_favorite,
                   c.id AS collection_id, c.name AS collection_name
            FROM meetings m
            LEFT JOIN collections c ON c.id = m.collection_id
            WHERE m.id = ?
            "#,
        )
        .bind(meeting_id)
        .fetch_optional(pool)
        .await;
        let Ok(Some(row)) = row else {
            continue;
        };
        let folder_path: Option<String> = row.try_get("folder_path").ok();
        let Some(folder_path) = folder_path.filter(|path| Path::new(path).is_dir()) else {
            continue;
        };
        let collection_id: Option<String> = row.try_get("collection_id").ok();
        let collection_name: Option<String> = row.try_get("collection_name").ok();
        let collection = collection_id.zip(collection_name).map(|(id, name)| {
            serde_json::json!({
                "id": id,
                "name": name,
            })
        });
        let is_archived: bool = row.try_get("is_archived").unwrap_or(false);
        let is_favorite: bool = row.try_get("is_favorite").unwrap_or(false);
        if let Err(error) = update_metadata_fields(
            Path::new(&folder_path),
            &[
                ("snack_meet_collection", collection),
                (
                    "snack_meet_archived",
                    Some(serde_json::Value::Bool(is_archived)),
                ),
                (
                    "snack_meet_favorite",
                    Some(serde_json::Value::Bool(is_favorite)),
                ),
            ],
        ) {
            log::warn!(
                "Failed to persist organization metadata for meeting {}: {}",
                meeting_id,
                error
            );
        }
    }
}

pub(crate) async fn restore_meeting_organization_from_metadata(
    pool: &sqlx::SqlitePool,
    meeting_id: &str,
    folder: &Path,
) {
    let Ok(metadata) = read_metadata_json(folder) else {
        return;
    };
    let has_collection = metadata.get("snack_meet_collection").is_some();
    let has_archived = metadata.get("snack_meet_archived").is_some();
    let has_favorite = metadata.get("snack_meet_favorite").is_some();
    if !has_collection && !has_archived && !has_favorite {
        return;
    }
    let current = sqlx::query_as::<_, (Option<String>, bool, bool)>(
        "SELECT collection_id, is_archived, is_favorite FROM meetings WHERE id = ?",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    let Some((current_collection_id, current_archived, current_favorite)) = current else {
        return;
    };
    let collection = metadata
        .get("snack_meet_collection")
        .and_then(|value| value.as_object());
    let mut restored_collection_id = if has_collection {
        None
    } else {
        current_collection_id
    };
    if let Some(collection) = collection {
        let id = collection
            .get("id")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let name = collection
            .get("name")
            .and_then(|value| value.as_str())
            .and_then(|value| normalize_collection_name(value).ok());
        if let (Some(id), Some(name)) = (id, name) {
            let now = Utc::now().to_rfc3339();
            let next_order: i64 =
                sqlx::query_scalar("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM collections")
                    .fetch_one(pool)
                    .await
                    .unwrap_or_default();
            let _ = sqlx::query(
                "INSERT OR IGNORE INTO collections (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(id)
            .bind(&name)
            .bind(next_order)
            .bind(&now)
            .bind(&now)
            .execute(pool)
            .await;
            restored_collection_id = sqlx::query_scalar::<_, String>(
                "SELECT id FROM collections WHERE id = ? OR name = ? COLLATE NOCASE LIMIT 1",
            )
            .bind(id)
            .bind(name)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
        }
    }
    let archived = metadata
        .get("snack_meet_archived")
        .and_then(|value| value.as_bool())
        .unwrap_or(current_archived);
    let favorite = metadata
        .get("snack_meet_favorite")
        .and_then(|value| value.as_bool())
        .unwrap_or(current_favorite);
    if let Err(error) = sqlx::query(
        "UPDATE meetings SET collection_id = ?, is_archived = ?, is_favorite = ? WHERE id = ?",
    )
    .bind(restored_collection_id)
    .bind(archived)
    .bind(favorite)
    .bind(meeting_id)
    .execute(pool)
    .await
    {
        log::warn!(
            "Failed to restore organization metadata for meeting {}: {}",
            meeting_id,
            error
        );
    }
}

#[tauri::command]
pub async fn api_list_collections<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<Vec<LibraryCollection>, String> {
    let rows = sqlx::query(
        r#"
        SELECT c.id, c.name, c.color, c.sort_order,
               COUNT(CASE WHEN m.is_archived = 0 THEN 1 END) AS meeting_count
        FROM collections c
        LEFT JOIN meetings m ON m.collection_id = c.id
        GROUP BY c.id, c.name, c.color, c.sort_order
        ORDER BY c.sort_order ASC, c.name COLLATE NOCASE ASC
        "#,
    )
    .fetch_all(state.db_manager.pool())
    .await
    .map_err(|error| format!("读取文件夹失败：{error}"))?;

    Ok(rows
        .into_iter()
        .map(|row| LibraryCollection {
            id: row.try_get("id").unwrap_or_default(),
            name: row.try_get("name").unwrap_or_default(),
            color: row.try_get("color").ok(),
            sort_order: row.try_get("sort_order").unwrap_or_default(),
            meeting_count: row.try_get("meeting_count").unwrap_or_default(),
        })
        .collect())
}

#[tauri::command]
pub async fn api_create_collection<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, AppState>,
    name: String,
    color: Option<String>,
) -> Result<LibraryCollection, String> {
    let name = normalize_collection_name(&name)?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let next_order: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM collections")
            .fetch_one(state.db_manager.pool())
            .await
            .map_err(|error| format!("读取文件夹排序失败：{error}"))?;

    sqlx::query(
        "INSERT INTO collections (id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&name)
    .bind(&color)
    .bind(next_order)
    .bind(&now)
    .bind(&now)
    .execute(state.db_manager.pool())
    .await
    .map_err(|error| {
        if error.to_string().contains("UNIQUE constraint failed") {
            "已经存在同名文件夹。".to_string()
        } else {
            format!("创建文件夹失败：{error}")
        }
    })?;

    Ok(LibraryCollection {
        id,
        name,
        color,
        sort_order: next_order,
        meeting_count: 0,
    })
}

#[tauri::command]
pub async fn api_rename_collection<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, AppState>,
    collection_id: String,
    name: String,
) -> Result<(), String> {
    let name = normalize_collection_name(&name)?;
    let meeting_ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM meetings WHERE collection_id = ?")
            .bind(&collection_id)
            .fetch_all(state.db_manager.pool())
            .await
            .map_err(|error| format!("读取文件夹会议失败：{error}"))?;
    let result = sqlx::query("UPDATE collections SET name = ?, updated_at = ? WHERE id = ?")
        .bind(name)
        .bind(Utc::now().to_rfc3339())
        .bind(collection_id)
        .execute(state.db_manager.pool())
        .await
        .map_err(|error| {
            if error.to_string().contains("UNIQUE constraint failed") {
                "已经存在同名文件夹。".to_string()
            } else {
                format!("重命名文件夹失败：{error}")
            }
        })?;
    if result.rows_affected() == 0 {
        return Err("文件夹不存在。".to_string());
    }
    persist_meeting_organization(state.db_manager.pool(), &meeting_ids).await;
    Ok(())
}

#[tauri::command]
pub async fn api_delete_collection<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, AppState>,
    collection_id: String,
) -> Result<(), String> {
    let meeting_ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM meetings WHERE collection_id = ?")
            .bind(&collection_id)
            .fetch_all(state.db_manager.pool())
            .await
            .map_err(|error| format!("读取文件夹会议失败：{error}"))?;
    let mut transaction = state
        .db_manager
        .pool()
        .begin()
        .await
        .map_err(|error| format!("开始删除文件夹失败：{error}"))?;
    sqlx::query("UPDATE meetings SET collection_id = NULL WHERE collection_id = ?")
        .bind(&collection_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("移出会议失败：{error}"))?;
    let result = sqlx::query("DELETE FROM collections WHERE id = ?")
        .bind(collection_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("删除文件夹失败：{error}"))?;
    if result.rows_affected() == 0 {
        transaction
            .rollback()
            .await
            .map_err(|error| error.to_string())?;
        return Err("文件夹不存在。".to_string());
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("保存文件夹删除操作失败：{error}"))?;
    persist_meeting_organization(state.db_manager.pool(), &meeting_ids).await;
    Ok(())
}

#[tauri::command]
pub async fn api_move_meetings_to_collection<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, AppState>,
    meeting_ids: Vec<String>,
    collection_id: Option<String>,
) -> Result<u64, String> {
    if meeting_ids.is_empty() {
        return Ok(0);
    }
    if let Some(id) = collection_id.as_deref() {
        if !collection_exists(state.db_manager.pool(), id).await? {
            return Err("目标文件夹不存在。".to_string());
        }
    }

    let mut transaction = state
        .db_manager
        .pool()
        .begin()
        .await
        .map_err(|error| format!("开始移动会议失败：{error}"))?;
    let mut changed = 0;
    for meeting_id in &meeting_ids {
        let result = sqlx::query("UPDATE meetings SET collection_id = ? WHERE id = ?")
            .bind(collection_id.as_deref())
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("移动会议失败：{error}"))?;
        changed += result.rows_affected();
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("保存会议归类失败：{error}"))?;
    persist_meeting_organization(state.db_manager.pool(), &meeting_ids).await;
    Ok(changed)
}

#[tauri::command]
pub async fn api_set_meeting_archived<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, AppState>,
    meeting_ids: Vec<String>,
    archived: bool,
) -> Result<u64, String> {
    let changed = update_boolean_flag(
        state.db_manager.pool(),
        &meeting_ids,
        "is_archived",
        archived,
    )
    .await?;
    persist_meeting_organization(state.db_manager.pool(), &meeting_ids).await;
    Ok(changed)
}

#[tauri::command]
pub async fn api_set_meeting_favorite<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, AppState>,
    meeting_id: String,
    favorite: bool,
) -> Result<(), String> {
    let changed = update_boolean_flag(
        state.db_manager.pool(),
        std::slice::from_ref(&meeting_id),
        "is_favorite",
        favorite,
    )
    .await?;
    if changed == 0 {
        return Err("会议不存在。".to_string());
    }
    persist_meeting_organization(state.db_manager.pool(), std::slice::from_ref(&meeting_id)).await;
    Ok(())
}

async fn update_boolean_flag(
    pool: &sqlx::SqlitePool,
    meeting_ids: &[String],
    column: &str,
    value: bool,
) -> Result<u64, String> {
    let statement = match column {
        "is_archived" => "UPDATE meetings SET is_archived = ? WHERE id = ?",
        "is_favorite" => "UPDATE meetings SET is_favorite = ? WHERE id = ?",
        _ => return Err("不支持的会议状态。".to_string()),
    };
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("开始更新会议状态失败：{error}"))?;
    let mut changed = 0;
    for meeting_id in meeting_ids {
        let result = sqlx::query(statement)
            .bind(value)
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("更新会议状态失败：{error}"))?;
        changed += result.rows_affected();
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("保存会议状态失败：{error}"))?;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_collection_name, persist_meeting_organization,
        restore_meeting_organization_from_metadata,
    };
    use sqlx::sqlite::SqlitePoolOptions;

    async fn organization_test_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE collections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                color TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE meetings (
                id TEXT PRIMARY KEY,
                folder_path TEXT,
                collection_id TEXT,
                is_archived INTEGER NOT NULL DEFAULT 0,
                is_favorite INTEGER NOT NULL DEFAULT 0
            );
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[test]
    fn collection_name_is_trimmed_and_compacted() {
        assert_eq!(normalize_collection_name("  客户   A  ").unwrap(), "客户 A");
    }

    #[test]
    fn collection_name_rejects_empty_and_long_names() {
        assert!(normalize_collection_name("   ").is_err());
        assert!(normalize_collection_name(&"文".repeat(61)).is_err());
    }

    #[tokio::test]
    async fn organization_metadata_round_trips_through_sync_folder() {
        let pool = organization_test_pool().await;
        let folder = tempfile::tempdir().unwrap();
        sqlx::query(
            "INSERT INTO collections (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind("collection-1")
        .bind("客户 A")
        .bind("2026-08-13T00:00:00Z")
        .bind("2026-08-13T00:00:00Z")
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO meetings (id, folder_path, collection_id, is_archived, is_favorite) VALUES (?, ?, ?, 1, 1)")
            .bind("meeting-1")
            .bind(folder.path().to_string_lossy().to_string())
            .bind("collection-1")
            .execute(&pool)
            .await
            .unwrap();

        persist_meeting_organization(&pool, &["meeting-1".to_string()]).await;
        let metadata: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(folder.path().join("metadata.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(metadata["snack_meet_collection"]["name"], "客户 A");
        assert_eq!(metadata["snack_meet_archived"], true);

        sqlx::query("DELETE FROM collections")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE meetings SET collection_id = NULL, is_archived = 0, is_favorite = 0")
            .execute(&pool)
            .await
            .unwrap();
        restore_meeting_organization_from_metadata(&pool, "meeting-1", folder.path()).await;

        let restored: (Option<String>, bool, bool) = sqlx::query_as(
            "SELECT collection_id, is_archived, is_favorite FROM meetings WHERE id = 'meeting-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(restored, (Some("collection-1".to_string()), true, true));
    }
}
