CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (LENGTH(TRIM(name)) > 0),
    color TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_name_nocase
    ON collections(name COLLATE NOCASE);

ALTER TABLE meetings ADD COLUMN collection_id TEXT
    REFERENCES collections(id) ON DELETE SET NULL;
ALTER TABLE meetings ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meetings ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_meetings_collection_id ON meetings(collection_id);
CREATE INDEX IF NOT EXISTS idx_meetings_is_archived ON meetings(is_archived);
CREATE INDEX IF NOT EXISTS idx_meetings_is_favorite ON meetings(is_favorite);
