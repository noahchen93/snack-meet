-- Migration: Add is_imported flag to meetings
-- Marks meetings that were imported from a synced transcripts.json (e.g. from a
-- desktop machine that transcribed the audio). Used to show a "新导入" badge in
-- the UI. Default 0 (false) for all existing meetings.

ALTER TABLE meetings ADD COLUMN is_imported INTEGER NOT NULL DEFAULT 0;
