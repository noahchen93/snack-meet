-- Migration: Add is_read flag to meetings
-- Tracks whether an imported meeting has been opened/read by the user. Used to
-- show a red dot on newly imported meetings that disappears once the user opens
-- the meeting. Default 0 (unread) for all existing meetings.

ALTER TABLE meetings ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0;
