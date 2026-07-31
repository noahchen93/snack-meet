# Snack Meet

> A silent macOS menu-bar tool that **auto-detects meetings, captures system + microphone audio, then automatically transcribes, summarizes, and smart-names the meeting** — no button presses, no copying files around.

Snack Meet fuses two complementary open-source engines into one product:

| Layer | Comes from | Job |
|---|---|---|
| **Capture** — `snack-record/` | [Snack Record](https://github.com/hehej0330/snack-record) (MIT) | Menu-bar app. Detects when you're in a meeting (window + system-audio probe), records **system audio (SCStream) + microphone (AVAudioEngine)**, mixes with ffmpeg, auto-stops when the meeting window disappears, then hands the recording off. |
| **Intelligence** — `meetily/` | [meetily](https://github.com/Zackriya-Solutions/meetily) (MIT) | Tauri (Rust + Next.js) app. On import: transcribes (whisper), generates an LLM summary, and renames the meeting folder to a smart title. Owns the meeting DB. |

The two layers are **decoupled by a one-way runtime contract**: the capture layer never knows how transcription works; it just launches the intelligence layer with `meetily --import <wav> --title <title>`. That keeps each layer replaceable.

```
 meeting starts ─► Snack Record auto-detects (window + system audio ≥ 6 s)
                     │  records system+mic → wav
                     │  auto-stops when meeting window gone
                     ▼
                meetily --import <wav> --title <temp title>
                     │  transcribe (whisper) → LLM summary
                     ▼
                smart-rename folder + write to meeting DB
```

## Build & install

One command from the repo root builds both layers (see `build.sh`):

```zsh
zsh build.sh        # builds snack-record/ and meetily/frontend
zsh install.sh      # installs both apps (Snack Record → ~/Applications, meetily → /Applications)
```

Details and prerequisites (Node, pnpm, Rust, Xcode CLT, ffmpeg) are in **[docs/INTEGRATION.md](docs/INTEGRATION.md)**.

### Permissions (TCC)

After install, grant **Screen Recording** and **Microphone** to *Snack Meet / Snack Record* in System Settings → Privacy & Security. Screen Recording is required for `SCStream` system-audio capture; without it the audio probe silently gets no samples. Re-grant after every reinstall (the local signature changes each build).

## Repository layout

```
snack-meet/
├── snack-record/      # Capture layer (Objective-C, menu-bar app)
│   ├── Sources/main.m
│   ├── build.sh
│   └── Info.plist
├── meetily/           # Intelligence layer (Rust + Tauri + Next.js)
│   ├── frontend/src-tauri/src/   # Rust: import, summary, external_trigger
│   └── frontend/src/             # Next.js UI
├── docs/INTEGRATION.md   # build/install details, the chronology, known issues
├── build.sh / install.sh # unified orchestration
└── README.md
```

## Status

Working and verified end-to-end on macOS (Apple Silicon):
- Auto-detect meeting window + system-audio probe → auto-start recording. ✅ (home screen correctly does **not** trigger)
- Auto-stop on meeting window disappearance. ✅
- ffmpeg mix → `meetily --import` → transcribe + summarize + smart folder rename. ✅
- Real-AI end-to-end (cold-start import → auto-summary → "New Version Release Plan Discussion" rename). ✅

Open items (see `docs/INTEGRATION.md` → To solve): confirm the auto-trigger during a *real* TencentMeeting call (needs a live meeting), end-to-end during a real call, misfire hardening.

## License & attribution

Both upstream projects are **MIT**; their licenses are preserved in `snack-record/LICENSE` and `meetily/LICENSE.md`. Snack Meet is also MIT. All credit for the two engines to their original contributors — Snack Meet only wires them together and adds the meeting-detection + auto-handoff glue.