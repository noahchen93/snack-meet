#!/bin/zsh
set -euo pipefail

TARGET="/Users/SDQ/Desktop/noah/meetly recording"
OLD_SYNC="/Users/SDQ/Desktop/noah/meetily-recordings"
OLD_MOVIES="/Users/SDQ/Movies/meetily-recordings"
OLD_SNACK_MEET_MOVIES="/Users/SDQ/Movies/Snack Meet Recordings"
APP_SUPPORT="/Users/SDQ/Library/Application Support/com.meetily.ai"
DATABASE="$APP_SUPPORT/meeting_minutes.sqlite"
PREFERENCES="$APP_SUPPORT/recording_preferences.json"
STAMP="$(date +%Y%m%d-%H%M%S)"

if pgrep -f '/Applications/Snack Meet.app/Contents/MacOS/snack-meet' >/dev/null 2>&1; then
  osascript -e 'tell application "Snack Meet" to quit' 2>/dev/null || true
  sleep 2
fi
if pgrep -f '/Applications/Snack Meet.app/Contents/MacOS/snack-meet' >/dev/null 2>&1; then
  echo "Snack Meet is still running; refusing to migrate live recording data." >&2
  exit 1
fi

mkdir -p "${TARGET:h}"

if [[ ! -d "$TARGET" && -d "$OLD_SYNC" ]]; then
  mv "$OLD_SYNC" "$TARGET"
else
  mkdir -p "$TARGET"
fi

move_meeting_folders() {
  local source="$1"
  [[ -d "$source" ]] || return 0

  local folder destination
  while IFS= read -r -d '' folder; do
    destination="$TARGET/${folder:t}"
    if [[ -e "$destination" ]]; then
      echo "Refusing to overwrite duplicate meeting folder: $destination" >&2
      exit 1
    fi
    mv "$folder" "$destination"
  done < <(find "$source" -mindepth 1 -maxdepth 1 -type d -print0)

  # Finder metadata is not meeting data and may legitimately exist in both roots.
  rmdir "$source" 2>/dev/null || true
}

move_meeting_folders "$OLD_SYNC"
move_meeting_folders "$OLD_MOVIES"
move_meeting_folders "$OLD_SNACK_MEET_MOVIES"

if [[ -f "$DATABASE" ]]; then
  cp -p "$DATABASE" "$DATABASE.before-baidu-migration-$STAMP"
  sqlite3 "$DATABASE" <<SQL
BEGIN IMMEDIATE;
UPDATE meetings
SET folder_path = replace(folder_path, '/Users/SDQ/Desktop/noah/meetily-recordings', '$TARGET')
WHERE folder_path LIKE '/Users/SDQ/Desktop/noah/meetily-recordings/%';
UPDATE meetings
SET folder_path = replace(folder_path, '/Users/SDQ/Movies/meetily-recordings', '$TARGET')
WHERE folder_path LIKE '/Users/SDQ/Movies/meetily-recordings/%';
UPDATE meetings
SET folder_path = replace(folder_path, '/Users/SDQ/Movies/Snack Meet Recordings', '$TARGET')
WHERE folder_path LIKE '/Users/SDQ/Movies/Snack Meet Recordings/%';
COMMIT;
SQL
fi

if [[ -f "$PREFERENCES" ]]; then
  cp -p "$PREFERENCES" "$PREFERENCES.before-baidu-migration-$STAMP"
  local_temp="$PREFERENCES.tmp-$STAMP"
  jq --arg folder "$TARGET" '.preferences.save_folder = $folder' "$PREFERENCES" > "$local_temp"
  mv "$local_temp" "$PREFERENCES"
fi

remaining_old_paths="$(sqlite3 "$DATABASE" "SELECT count(*) FROM meetings WHERE folder_path LIKE '/Users/SDQ/Desktop/noah/meetily-recordings/%' OR folder_path LIKE '/Users/SDQ/Movies/meetily-recordings/%' OR folder_path LIKE '/Users/SDQ/Movies/Snack Meet Recordings/%';")"
if [[ "$remaining_old_paths" != "0" ]]; then
  echo "Migration validation failed: $remaining_old_paths database paths still reference old roots." >&2
  exit 1
fi

meeting_folders="$(find "$TARGET" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
echo "Migrated $meeting_folders meeting folders to: $TARGET"
echo "Database and preference backups use stamp: $STAMP"
