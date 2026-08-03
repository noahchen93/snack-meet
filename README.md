# Snack Meet

> A single macOS menu-bar app that **auto-detects meetings, captures system + microphone audio, then automatically transcribes, summarizes, and smart-names the meeting** — no button presses, no second app, no copying files around.

Snack Meet is a **fusion of two open-source engines into one application**:

| Comes from | Role in Snack Meet |
|---|---|
| [meetily](https://github.com/Zackriya-Solutions/meetily) (MIT) — Tauri (Rust + Next.js) | The **whole app**: UI, tray, native system+mic audio capture (Core Audio process tap — no virtual device), ffmpeg mix, VAD, whisper transcription, LLM summary, the meeting DB, and the smart folder-rename. |
| [Snack Record](https://github.com/hehej0330/snack-record) (MIT) — Objective-C menu-bar app | **Retired as a separate app.** Its meeting-window auto-detection + start/stop confirmation logic was ported into meetily's Rust backend (`meeting_detector.rs`) and surfaced in the UI (`MeetingDetectorProvider`). The original `snack-record/` source is kept for reference/history. |

There is **no longer a wav-file handoff and no second process**. One app detects, records, transcribes, summarizes, and names — end to end.

```
 meeting app opens ─► meeting_detector (Rust, SCShareableContent poll) emits meeting-detected
                       │  frontend: native dialog "已检测到会议开启，是否自动录音？"
                       │  on confirm → start recording (system+mic, Core Audio tap)
                       ▼
 meeting window gone / app exits ─► meeting-ended  →  stop + save
                       │  background summarize → rename_meeting_folder
                       ▼
                folder: <topic>_<start>--<end>   (real meeting span from metadata.json)
```

## Build & install

```zsh
zsh build.sh        # builds meetily/frontend -> meetily/target/release/meetily
zsh install.sh      # installs the single app -> /Applications/Snack Meet.app
```

`build.sh` runs `pnpm tauri build --no-bundle` (the `--no-bundle` binary embeds the `_next` frontend; a plain `cargo build` does **not**, and yields a blank UI). The binary lands in the **workspace-root** target dir `meetily/target/release/` — not `src-tauri/target/`. Details and prerequisites (Node, pnpm, Rust, full Xcode, ffmpeg) are in **[docs/INTEGRATION.md](docs/INTEGRATION.md)**.

### Permissions (TCC)

After the first install, grant in System Settings → Privacy & Security:

- **Screen Recording** → Snack Meet — required for meeting-window detection (`SCShareableContent` enumerates on-screen windows).
- **Microphone** → Snack Meet.
- **Audio Capture** → Snack Meet — system audio via Core Audio process tap (macOS 14.4+).

Then open **Snack Meet → Settings → Recording** and turn on **Auto-detect Meetings**. (Screen Recording is requested on first enable.)

`install.sh` creates and reuses a local **Snack Meet Local Code Signing** identity by
default. This keeps the app's designated requirement stable, so the grants above survive
future local rebuilds. The first migration from the old ad-hoc signature requires one clean
re-grant. To intentionally use an ad-hoc signature instead, run
`SNACK_MEET_SIGNING_IDENTITY=- zsh install.sh`.

## How detection works

`meeting_detector.rs` is a faithful port of Snack Record's `MeetingReminderMonitor`. Every 8 s it enumerates windows (`cidre::sc::ShareableContent`) and running apps (`cidre::ns::Workspace`). A window "suggests a meeting" when:

- it is **not** a home/launcher window (per-app home-title list + normalized comparison), and
- its title contains a meeting keyword (`会议 通话 meeting call conference zoom teams meet 钉钉 webinar`), or
- it belongs to a **dedicated** meeting app (腾讯会议 / 腾讯会议 / Zoom) and is large enough (`≥800×500`), **ignoring `isOnScreen`** (SCShareableContent reports `isOnScreen=0` mid-meeting for some apps — the 腾讯会议 fix).

It emits `meeting-detected` (then self-cools down 10 min) and, while recording, `meeting-ended{app-exit}` (auto-stop) or `meeting-ended{window-gone}` (ask before stopping). The frontend shows **native** confirmation dialogs (visible above a fullscreen meeting) and drives meetily's existing start/stop/save path. Detect-triggered recordings set a flag so the stop flow auto-summarizes (→ smart rename), mirroring the `--import` path.

## Repository layout

```
snack-meet/
├── meetily/                          # The single app (Rust + Tauri + Next.js)
│   ├── frontend/src-tauri/src/
│   │   ├── meeting_detector.rs        # ported Snack Record detection
│   │   ├── external_trigger.rs        # --import + auto_summarize_meeting_command
│   │   ├── summary/service.rs         # rename_meeting_folder (smart name)
│   │   └── audio/                     # Core Audio capture, recording_saver, prefs
│   └── frontend/src/
│       ├── contexts/MeetingDetectorProvider.tsx  # detector ↔ UI + native dialogs
│       ├── hooks/useRecordingStop.ts             # save flow + auto-summarize hook
│       └── components/RecordingSettings.tsx      # Auto-detect Meetings toggle
├── snack-record/                      # RETIRED — kept for reference/history
├── docs/INTEGRATION.md
├── build.sh / install.sh              # single-app build + install
└── README.md
```

## Smart folder naming

`rename_meeting_folder` names a meeting folder `<topic>_<date>_<start>--<end>` using the **real meeting span** from `metadata.json` — `meeting_name` (`Snack Meet-YYYYMMDD-HHMMSS.txt`, local-time recording start) + `duration_seconds` (end = start + duration) — **not** the import/save time. Verified end-to-end: a 10:19–10:21 meeting renamed to `..._2026-08-01_10-19--10-21`.

## Status

Working and verified on macOS (Apple Silicon):
- Native system+mic capture (Core Audio tap), transcription, summary, smart rename. ✅
- Meeting-window detector (Rust port), native start/stop dialogs, auto-summarize on detect-triggered stop, smart rename. ✅ (builds; live-meeting confirmation pending a real call)
- Single app — no Snack Record process, tray reads "Snack Meet". ✅

The bundle identifier is kept as `com.meetily.ai` (not renamed) so existing DB/recordings/onboarding/TCC carry over. The `.app` is named and displayed as **"Snack Meet"** (`/Applications/Snack Meet.app`); the internal executable is still `meetily`, which is harmless.

## License & attribution

Both upstream projects are **MIT**; their licenses are preserved in `snack-record/LICENSE` and `meetily/LICENSE.md`. Snack Meet is also MIT. All credit for the two engines to their original contributors — Snack Meet ports the detection logic into meetily and adds the single-app glue.
