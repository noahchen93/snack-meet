# Snack Meet — integration notes & history

This document records how the two layers are wired together, the build/install
specifics that were learned the hard way, and the open issues. It is the
narrative behind the chronology that produced this repo.

## Architecture: capture → intelligence handoff

**Capture layer (`snack-record/`, Objective-C menu-bar app).**
`MeetingReminderMonitor` in `Sources/main.m` owns the lifecycle:

1. `pollForMeeting` (≈8 s timer) enumerates windows of the monitored meeting apps
   (腾讯会议 / Zoom / 企业微信 / 飞书 / browser meeting tabs).
2. `windowSuggestsMeeting:` picks an in-meeting window — keyword in the title
   for generic apps, or size ≥ 800×500 with a **non-home title** for dedicated
   meeting apps (Zoom / 腾讯会议). The home/launcher window is rejected by
   `isHomeWindowTitle:` (covers both `腾讯会议` and `TencentMeeting`).
3. `startSystemAudioProbe` opens an `SCStream` on the main display that captures
   **system audio** (the remote party's voice), computes RMS per sample buffer.
4. When RMS ≥ 0.015 accumulates for the threshold (6 s if the meeting app is
   frontmost, 30 s otherwise; 3 s in reminder mode), recording auto-starts.
5. While recording, every 8 s the meeting window is re-checked; if it is gone,
   recording auto-stops.
6. On stop, the system+mic tracks are mixed with ffmpeg and the result is handed
   to the intelligence layer via `sendToMeetilyWithURL:` → `NSTask` running
   `meetily --import <wav> --title <temp title>`.

**Intelligence layer (`meetily/`, Rust + Tauri).** `external_trigger.rs` exposes
the `--import` CLI path; on import it calls `auto_summarize_meeting` →
`process_transcript_background`, which transcribes (whisper, model from
`settings.whisperModel`, `large-v3-turbo`→`q5_0` fallback) and runs the LLM
summary. `service.rs::rename_meeting_folder` then renames the meeting folder to
a smart LLM-generated title and updates the meeting DB (`folder_path`/`title`).

The two layers share **no code and no state** — only the `--import` argv
contract and the filesystem (the wav, the meeting folder).

## Build & install specifics (lessons learned)

- **meetily binary must embed the frontend.** A plain `cargo build` produces a
  binary with no embedded `_next` assets → blank UI ("white board"). Use
  `pnpm tauri build --no-bundle`; the resulting binary (~70 MB) embeds `_next`.
  See `build.sh`.
- **Single-instance arg forwarding.** `open -b --args` drops args for an already-
  running instance. Launch the binary directly — `Contents/MacOS/meetily --import`
  — so the single-instance socket forwards the args. This is why the capture
  layer uses `NSTask` on the binary, not `open`.
- **Snack Meet signing.** `install.sh` resolves a stable local signing identity
  (`scripts/ensure_local_signing_identity.sh`) and re-signs the complete app after
  swapping its executable. The designated requirement therefore remains stable and
  TCC permissions survive subsequent development rebuilds. Migrating once from the
  previous ad-hoc signature still requires a clean re-grant.
- **Prerequisites.** Full Xcode (the `cidre` build script runs `xcodebuild`),
  Node + pnpm (meetily frontend), Rust toolchain, and ffmpeg on PATH. Command
  Line Tools alone are not sufficient.

## The onscreen-reliability fix

`SCShareableContent` reports `isOnScreen = 0` for **腾讯会议 windows even while a
real in-meeting window is visible** (confirmed across runs: the same home window
flipped between `onscreen=0` and `onscreen=1`). The earlier gate
`window.isOnScreen && width >= 800 && height >= 500` therefore rejected real
meetings, so the audio probe never started — "开了腾讯会议却不自动开始".

Fix: for dedicated meeting apps, drop `isOnScreen` and rely on
`isHomeWindowTitle` (already rejecting the launcher) + size. Observed home-
screen windows are all rejected by home-title or size, so the home screen still
does **not** trigger. Diagnostic logging was added: when no meeting window is
found, each dedicated-meeting candidate is logged with a rejection reason
(`home-title` / `size … < 800x500` / `would-accept`), so a real-meeting
observation unambiguously shows whether the in-meeting window was seen.

## Chronology

1. **Install Snack Record.** Source `/tmp/snack-record-src` → `~/Applications/Snack
   Record.app`. Capabilities: `SCStream` system audio + `AVAudioEngine` mic tap +
   ffmpeg mix; recordings cached under
   `~/Library/Application Support/Snack Record/Recordings/{UUID}.wav`. Auto-meeting
   detection via window keywords + audio threshold.
2. **Install & integrate meetily.** Source `/tmp/meetily` → `/Applications/meetily.app`.
   Fixed the blank-UI build (use `pnpm tauri build --no-bundle`), single-instance arg
   forwarding, `whisperModel` fallback, external-import auto-summarize, smart folder
   rename. End-to-end verified (cold-start import → auto-summary → "New Version Release
   Plan Discussion" rename).
3. **Snack Record ↔ meetily integration.** Ctrl+R toggles start/stop; manual recordings
   get a dated temp title; `sendToMeetily` runs the binary directly; auto-stop on
   window disappearance (8 s re-probe); tightened auto-detect (企业微信 no size
   fallback, RMS 0.015).
4. **This round — auto-start not triggering.** Root cause: probe listened to the mic,
   so a silent listener never reached threshold; switched the probe source to system
   audio. Then the onscreen-reliability bug above blocked the probe from starting.
   Fixed (see above) and verified safe on the home screen.

## To solve

- **High — confirm the real-meeting window state.** Observe the log while in a real
  腾讯会议 call with someone speaking. Expect a `reason=would-accept` line for the
  in-meeting window, then `probe selected bundle=…`, `system audio probe started`,
  and `probe audio rms=…` climbing to the threshold. If the in-meeting window title
  normalizes to a home title, extend `homeWindowTitlesForBundleIdentifier:`.
- **High — real-meeting auto-trigger.** Continuous system audio RMS ≥ 0.015 for ≥ 6 s
  should auto-start. Confirm during a live call.
- **Medium — full end-to-end during a real call.** auto-start → 8 s window re-check
  keeps recording → window disappears → stop → ffmpeg mix → `meetily --import` →
  transcribe + summarize + smart-rename.
- **Medium — misfire hardening.** Ensure only a real meeting window + sustained voice
  starts recording. System audio is global; a false window match + playing media could
  trigger. The 30 s non-frontmost threshold and home-title rejection mitigate this.
- **Low — first stable-signature migration.** Re-grant Screen Recording,
  Microphone, and Audio Capture once after moving from the old ad-hoc signature.
  Subsequent installs signed by the managed local identity retain the grants.
