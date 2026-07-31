# Snack Record

Local macOS meeting recorder and Chinese transcription app powered by FunASR.

## Features

- Captures system audio and microphone audio with ScreenCaptureKit.
- Transcribes locally with Paraformer, punctuation, VAD, and speaker diarization.
- Imports local audio and video files.
- Saves TXT transcripts to Desktop.
- Keeps the seven most recent tasks and cached audio locally.
- Offers fast transcription without speaker labels and standard transcription with speaker diarization.
- Shows transcription percentage and estimated remaining time for long audio.
- Preloads the local models once at app launch and reuses them across transcription tasks.
- Optionally detects likely meetings in WeCom, Feishu, Tencent Meeting, and Zoom, then shows a local recording reminder.
- Supports Chinese and English UI.

## AI coding tool installation

Ask your AI coding tool to clone this repository, review `install.sh`, and run:

```bash
chmod +x install.sh build.sh scripts/download_models.py scripts/ensure_local_signing_identity.sh
./install.sh
```

The installer builds a native app for the current Mac (Apple Silicon or Intel) and creates a stable, local-only signing identity in a dedicated Snack Record keychain. It does not require an Apple Developer account, a Developer ID certificate, or access to another person's signing identity. The same identity is reused on later builds so macOS privacy permissions remain associated with the app after an update.

On Intel Macs, the installer selects a native Python 3.10-3.12 runtime and uses the last PyTorch release that provides x86_64 macOS wheels. If no compatible Python is installed, Homebrew is used to install Python 3.11. Set `SNACK_RECORD_PYTHON` to a compatible Python executable to override automatic selection.

The first installation downloads about 2 GB of speech models. The app is installed to:

```text
~/Applications/Snack Record.app
```

Runtime files and models are stored under:

```text
~/Library/Application Support/Snack Record/
```

The local signing keychain and its randomly generated password are stored under:

```text
~/Library/Application Support/Snack Record/Signing/
```

The signing key is generated on the current Mac, is not uploaded, and has no connection to the repository owner.

## Requirements

- macOS 13 or later (macOS 15 or later recommended)
- Apple Silicon or Intel Mac
- Xcode Command Line Tools
- Python 3.10 or later (Intel requires Python 3.10-3.12)
- Homebrew and FFmpeg
- Internet connection during first installation

## Privacy

- Audio, task history, and transcripts are processed locally.
- Recordings and task metadata are not uploaded by Snack Record.
- Model files are downloaded from ModelScope during installation.
- ScreenCaptureKit permission is used to capture system audio; screen video is not saved.
- Meeting reminders are off by default. When enabled, the app checks matching meeting windows and audio energy in memory without saving probe audio.

See [PRIVACY.md](PRIVACY.md) for storage locations and deletion behavior.

## Signing

`install.sh` creates and reuses a local code-signing identity for source-based installation. Existing users upgrading from an older ad-hoc-signed build must grant microphone and screen/system-audio permissions one final time after the migration. Later source updates keep the same designated requirement and should not reset those permissions.

Set `SIGN_IDENTITY` to a Developer ID identity when producing a signed release. `SIGN_IDENTITY=-` remains available only for disposable development builds; ad-hoc builds are not suitable for upgrades because macOS binds privacy permissions to their changing code hash.

## Third-party models

FunASR and each downloaded ModelScope model may have separate licenses. Review the upstream repository and model cards before redistributing model files. This repository does not bundle model weights.

## License

Source code is provided under the MIT License. Third-party dependencies, models, and brand assets remain subject to their respective licenses.
