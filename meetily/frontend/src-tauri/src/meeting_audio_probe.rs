//! Low-power, in-memory ScreenCaptureKit audio activity probe used by meeting detection.
//! Audio samples are reduced to an RMS value in the callback and are never persisted.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use cidre::sc::stream::{Output, OutputImpl};
use cidre::{cat, cm, define_obj_type, dispatch, objc, sc};
use tokio_util::sync::CancellationToken;

const AUDIO_RMS_THRESHOLD: f64 = 0.015;
const MAX_ACCUMULATED_MS: u64 = 60_000;

#[repr(C)]
struct ProbeOutputInner {
    active_ms: Arc<AtomicU64>,
}

define_obj_type!(ProbeOutput + OutputImpl, ProbeOutputInner, PROBE_OUTPUT);

impl Output for ProbeOutput {}

#[objc::add_methods]
impl OutputImpl for ProbeOutput {
    extern "C" fn impl_stream_did_output_sample_buf(
        &mut self,
        _cmd: Option<&objc::Sel>,
        _stream: &sc::Stream,
        sample_buf: &mut cm::SampleBuf,
        kind: sc::OutputType,
    ) {
        if kind != sc::OutputType::Audio || !sample_buf.data_is_ready() {
            return;
        }
        let Some(rms) = sample_rms(sample_buf) else {
            return;
        };
        let duration = sample_buf.duration().as_secs();
        let duration_ms = if duration.is_finite() && duration > 0.0 {
            (duration * 1000.0).round() as u64
        } else {
            50
        };
        let active_ms = &self.inner().active_ms;
        if rms >= AUDIO_RMS_THRESHOLD {
            let _ = active_ms.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                Some(current.saturating_add(duration_ms).min(MAX_ACCUMULATED_MS))
            });
        } else {
            let decay = (duration_ms / 2).max(1);
            let _ = active_ms.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                Some(current.saturating_sub(decay))
            });
        }
    }
}

fn sample_rms(sample_buf: &cm::SampleBuf) -> Option<f64> {
    let is_float = sample_buf
        .format_desc()
        .and_then(|desc| desc.stream_basic_desc())
        .map(|desc| desc.format_flags.contains(cat::AudioFormatFlags::IS_FLOAT))
        .unwrap_or(true);

    let retained = sample_buf.audio_buf_list::<2>().ok()?;
    let list = retained.list();
    let mut sum = 0.0f64;
    let mut count = 0usize;
    for buffer in list
        .buffers
        .iter()
        .take(list.number_buffers.min(2) as usize)
    {
        if buffer.data.is_null() || buffer.data_bytes_size == 0 {
            continue;
        }
        if is_float {
            let len = buffer.data_bytes_size as usize / std::mem::size_of::<f32>();
            // SAFETY: CoreMedia owns the retained block buffer for the lifetime of
            // `retained`; the buffer size and format description bound this slice.
            let samples = unsafe { std::slice::from_raw_parts(buffer.data.cast::<f32>(), len) };
            for &sample in samples {
                let sample = sample as f64;
                sum += sample * sample;
            }
            count += samples.len();
        } else {
            let len = buffer.data_bytes_size as usize / std::mem::size_of::<i16>();
            // SAFETY: same retained CoreMedia buffer lifetime and size validation as above.
            let samples = unsafe { std::slice::from_raw_parts(buffer.data.cast::<i16>(), len) };
            for &sample in samples {
                let sample = sample as f64 / i16::MAX as f64;
                sum += sample * sample;
            }
            count += samples.len();
        }
    }
    (count > 0).then(|| (sum / count as f64).sqrt())
}

pub struct AudioProbeHandle {
    active_ms: Arc<AtomicU64>,
    cancel: CancellationToken,
}

impl AudioProbeHandle {
    pub fn active_ms(&self) -> u64 {
        self.active_ms.load(Ordering::Relaxed)
    }

    pub fn cancel(&self) {
        self.cancel.cancel();
    }
}

pub async fn start(window_id: u32) -> Result<AudioProbeHandle, String> {
    let content = sc::ShareableContent::current()
        .await
        .map_err(|e| format!("audio probe could not enumerate content: {e}"))?;
    let windows = content.windows();
    let window = windows
        .iter()
        .find(|window| window.id() == window_id)
        .ok_or_else(|| "audio probe candidate window disappeared".to_string())?;

    let filter = sc::ContentFilter::with_desktop_independent_window(window);
    let mut cfg = sc::StreamCfg::new();
    cfg.set_width(2);
    cfg.set_height(2);
    cfg.set_minimum_frame_interval(cm::Time::new(1, 1));
    cfg.set_captures_audio(true);
    cfg.set_excludes_current_process_audio(true);
    cfg.set_sample_rate(48_000);
    cfg.set_channel_count(2);

    let active_ms = Arc::new(AtomicU64::new(0));
    let output = ProbeOutput::with(ProbeOutputInner {
        active_ms: active_ms.clone(),
    });
    let queue = dispatch::Queue::serial_with_ar_pool();
    let stream = sc::Stream::new(&filter, &cfg);
    stream
        .add_stream_output(output.as_ref(), sc::OutputType::Audio, Some(&queue))
        .map_err(|e| format!("audio probe output setup failed: {e}"))?;
    stream
        .start()
        .await
        .map_err(|e| format!("audio probe start failed: {e}"))?;

    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    tauri::async_runtime::spawn(async move {
        task_cancel.cancelled().await;
        let _ = stream.stop().await;
        drop(output);
        drop(queue);
    });

    Ok(AudioProbeHandle { active_ms, cancel })
}
