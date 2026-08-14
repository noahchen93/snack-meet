# Snack Meet architecture and release invariants

## One application

Snack Meet is one Tauri application. Meeting detection, microphone/system-audio capture, transcription, summarization, storage and the recording overlay run inside the same app process. The retired Objective-C capture app and legacy Python backend are not part of the supported tree.

## Detection

Microphone ownership is the primary start signal. Typeless, WeChat Input Method and known speech infrastructure processes are ignored. Meeting windows and system-audio activity are supporting signals.

During a detector-started recording, the end signal is debounced for roughly 6.4 seconds:

- monitored app exits; or
- its microphone capture is released; or
- with Screen Recording permission, the in-meeting window remains absent.

Screen Recording permission improves window classification but is not required for microphone-release auto-stop.

## Recording stop

Audio streams stop first and global recording state is cleared immediately. Remaining transcript chunks receive a bounded finalization window; raw audio/checkpoints remain the recovery source. The frontend does not maintain a second transcription polling state machine.

## Data operations

- Meeting file deletion is allowed only below the configured recordings root.
- Folders are renamed into a quarantine directory before the database transaction commits.
- SQLite WAL and SHM files are never silently deleted during corruption recovery.
- On macOS, provider API keys are stored in Keychain and legacy plaintext values migrate on first read.

## Release

`build.sh` always produces the complete app bundle. `install.sh` signs a staged copy, validates its executable/bundle identifier, then replaces the installed app as one unit. It never swaps a binary into an old bundle.

Automatic updates remain disabled until Snack Meet owns a dedicated signing key and release manifest. Never add an update endpoint or public key belonging to another project.
