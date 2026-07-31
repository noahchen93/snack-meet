#!/usr/bin/env python3
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from funasr import AutoModel

MODEL_NAMES = (
    "iic--speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    "iic--speech_fsmn_vad_zh-cn-16k-common-pytorch",
    "iic--punc_ct-transformer_cn-en-common-vocab471067-large",
    "iic--speech_campplus_sv_zh-cn_16k-common",
)


def local_model_directories() -> tuple[Path, Path, Path, Path]:
    cache_root = Path(
        os.environ.get("MODELSCOPE_CACHE", Path.home() / ".cache" / "modelscope")
    ).expanduser()
    directories = tuple(
        cache_root / "models" / model_name / "snapshots" / "master"
        for model_name in MODEL_NAMES
    )
    missing = [str(directory) for directory in directories if not directory.is_dir()]
    if missing:
        raise RuntimeError("Local FunASR models are unavailable: " + ", ".join(missing))
    return directories


def normalize_text(text: str) -> str:
    text = text.strip()
    return re.sub(r"(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])", "", text)


def normalized_audio_path(input_path: Path) -> tuple[Path, Path | None]:
    if input_path.suffix.lower() == ".wav":
        return input_path, None

    ffmpeg = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg")
    if not ffmpeg:
        for candidate in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"):
            if Path(candidate).is_file():
                ffmpeg = candidate
                break
    if not ffmpeg:
        raise RuntimeError("FFmpeg is required to decode this audio format")

    temporary = tempfile.NamedTemporaryFile(prefix="snack-record-", suffix=".wav", delete=False)
    temporary.close()
    output_path = Path(temporary.name)
    result = subprocess.run(
        [
            ffmpeg,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(input_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        output_path.unlink(missing_ok=True)
        detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "unknown error"
        raise RuntimeError(f"Unable to decode audio: {detail}")
    return output_path, output_path


def relative_time(milliseconds: int) -> str:
    total_seconds = max(0, int(milliseconds)) // 1000
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


class ProgressReporter:
    def __init__(self, request_id: str | None = None) -> None:
        self.request_id = request_id
        self.last_percent = -1.0

    def emit(self, percent: float) -> None:
        percent = max(0.0, min(100.0, percent))
        if percent < 100.0 and percent - self.last_percent < 0.5:
            return
        self.last_percent = percent
        if self.request_id is None:
            print(f"PROGRESS {percent:.1f}", flush=True)
        else:
            print(
                json.dumps(
                    {"type": "progress", "id": self.request_id, "percent": round(percent, 1)},
                    ensure_ascii=False,
                ),
                flush=True,
            )


def audio_duration_ms(value: object) -> float:
    if isinstance(value, (list, tuple)):
        return sum(audio_duration_ms(item) for item in value)
    try:
        array = np.asarray(value)
    except Exception:
        return 0.0
    if array.ndim == 0:
        return 0.0
    sample_count = array.shape[-1]
    batch_count = array.shape[0] if array.ndim > 1 else 1
    return float(sample_count * batch_count) / 16.0


def install_progress_bridge(model: AutoModel, reporter: ProgressReporter, mode: str):
    original_inference = model.inference
    state = {
        "total_speech_ms": 0.0,
        "processed_speech_ms": 0.0,
        "pending_percent": 8.0,
        "pending_speaker_calls": 0,
    }

    def inference_with_progress(input_value, *args, **kwargs):
        target_model = kwargs.get("model")
        asr_duration = audio_duration_ms(input_value) if target_model is model.model else 0.0
        if isinstance(input_value, (list, tuple)):
            asr_batch_count = len(input_value)
        else:
            input_array = np.asarray(input_value)
            asr_batch_count = input_array.shape[0] if input_array.ndim > 1 else 1
        result = original_inference(input_value, *args, **kwargs)

        if target_model is model.vad_model:
            state["total_speech_ms"] = sum(
                max(0, segment[1] - segment[0])
                for item in result
                for segment in (item.get("value") or [])
            )
            reporter.emit(8.0)
        elif target_model is model.model:
            state["processed_speech_ms"] += asr_duration
            total = max(state["total_speech_ms"], state["processed_speech_ms"], 1.0)
            ratio = min(1.0, state["processed_speech_ms"] / total)
            state["pending_percent"] = 8.0 + ratio * 82.0
            if mode == "standard":
                state["pending_speaker_calls"] += max(1, asr_batch_count)
            else:
                reporter.emit(state["pending_percent"])
        elif mode == "standard" and target_model is model.spk_model:
            state["pending_speaker_calls"] = max(0, state["pending_speaker_calls"] - 1)
            if state["pending_speaker_calls"] == 0:
                reporter.emit(state["pending_percent"])
        elif target_model is model.punc_model:
            reporter.emit(94.0)
        return result

    model.inference = inference_with_progress
    return original_inference


def create_model(include_speaker: bool) -> AutoModel:
    model_path, vad_model, punc_model, speaker_model = local_model_directories()
    model_options = dict(
        model=str(model_path),
        vad_model=str(vad_model),
        punc_model=str(punc_model),
        disable_update=True,
        disable_pbar=True,
    )
    if include_speaker:
        model_options["spk_model"] = str(speaker_model)
    return AutoModel(**model_options)


def transcribe(
    model: AutoModel,
    input_path: Path,
    output_path: Path,
    start_time: str,
    mode: str,
    reporter: ProgressReporter,
) -> None:
    reporter.emit(2.0)
    speaker_model = model.spk_model
    if mode == "fast":
        model.spk_model = None
    original_inference = None
    temporary_audio = None
    try:
        prepared_input, temporary_audio = normalized_audio_path(input_path)
        reporter.emit(5.0)
        original_inference = install_progress_bridge(model, reporter, mode)
        results = model.generate(
            input=str(prepared_input),
            batch_size_s=300,
            sentence_timestamp=mode == "fast",
        )
    finally:
        if original_inference is not None:
            model.inference = original_inference
        model.spk_model = speaker_model
        if temporary_audio is not None:
            temporary_audio.unlink(missing_ok=True)

    reporter.emit(98.0)

    result = results[0] if results else {}
    sentences = result.get("sentence_info") or []
    lines = [f"录音开始时间：{start_time}", ""]
    if sentences:
        for sentence in sentences:
            text = normalize_text(sentence.get("text") or sentence.get("sentence") or "")
            if not text:
                continue
            timestamp = relative_time(sentence.get("start", 0))
            if mode == "standard":
                speaker = int(sentence.get("spk", 0)) + 1
                lines.append(f"[{timestamp}] 说话人 {speaker}：{text}")
            else:
                lines.append(f"[{timestamp}] {text}")
    else:
        text = normalize_text(result.get("text", ""))
        if text:
            prefix = "说话人 1：" if mode == "standard" else ""
            lines.append(f"[00:00:00] {prefix}{text}")

    if len(lines) == 2:
        lines.append("[00:00:00] 未检测到可识别的对话声音")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    reporter.emit(100.0)


def run_worker() -> None:
    model = create_model(include_speaker=True)
    print(json.dumps({"type": "ready"}), flush=True)
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            request_id = str(request["id"])
            mode = "standard" if request.get("mode") == "standard" else "fast"
            reporter = ProgressReporter(request_id)
            transcribe(
                model=model,
                input_path=Path(request["input"]),
                output_path=Path(request["output"]),
                start_time=str(request["start_time"]),
                mode=mode,
                reporter=reporter,
            )
            print(json.dumps({"type": "completed", "id": request_id}), flush=True)
        except Exception as error:
            request_id = str(request.get("id", ""))
            print(
                json.dumps({"type": "error", "id": request_id, "message": str(error)}, ensure_ascii=False),
                flush=True,
            )


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe a WAV file with local paraformer-zh.")
    parser.add_argument("input", type=Path, nargs="?")
    parser.add_argument("output", type=Path, nargs="?")
    parser.add_argument("start_time", nargs="?")
    parser.add_argument("--mode", choices=("fast", "standard"), default="fast")
    parser.add_argument("--worker", action="store_true")
    args = parser.parse_args()
    if args.worker:
        run_worker()
        return
    if not args.input or not args.output or not args.start_time:
        parser.error("input, output, and start_time are required unless --worker is used")

    reporter = ProgressReporter()
    reporter.emit(1.0)
    model = create_model(include_speaker=args.mode == "standard")
    transcribe(model, args.input, args.output, args.start_time, args.mode, reporter)


if __name__ == "__main__":
    main()
