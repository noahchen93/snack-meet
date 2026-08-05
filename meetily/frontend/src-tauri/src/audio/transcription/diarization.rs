// audio/transcription/diarization.rs
//
// Lightweight speaker diarization for live meeting transcription.
// Since we capture the local microphone and remote/system audio on separate
// channels before mixing, we can estimate which source dominated each speech
// segment by comparing the per-window energy of the two channels.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// Speaker label for a transcript segment.
///
/// In a typical online meeting:
/// - `Local`  → captured from the local microphone (the user running the app).
/// - `Remote` → captured from system audio (other meeting participants).
/// - `Unknown` → could not confidently determine the source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SpeakerLabel {
    Local,
    Remote,
    Unknown,
}

impl SpeakerLabel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Remote => "remote",
            Self::Unknown => "unknown",
        }
    }

    /// Human-readable speaker name shown in the UI.
    /// These strings are intentionally short so they fit in the transcript list.
    pub fn display_name(&self) -> String {
        match self {
            Self::Local => "说话人 1".to_string(),
            Self::Remote => "说话人 2".to_string(),
            Self::Unknown => "未知".to_string(),
        }
    }
}

impl Default for SpeakerLabel {
    fn default() -> Self {
        Self::Unknown
    }
}

/// A speech segment ready for transcription, annotated with an estimated speaker.
#[derive(Debug, Clone)]
pub struct TranscriptionChunk {
    pub audio: crate::audio::recording_state::AudioChunk,
    pub speaker: Option<SpeakerLabel>,
}

/// Per-window energy record used to attribute a VAD speech segment to a channel.
struct EnergyFrame {
    start_ms: f64,
    end_ms: f64,
    /// Mean squared amplitude of the local microphone window.
    mic_energy: f32,
    /// Mean squared amplitude of the system/remote audio window.
    sys_energy: f32,
}

/// Estimates whether a speech segment came from the local microphone or from
/// system audio by comparing channel energies over the segment interval.
pub struct ChannelEnergyEstimator {
    frames: VecDeque<EnergyFrame>,
    next_start_ms: f64,
}

impl ChannelEnergyEstimator {
    pub fn new() -> Self {
        Self {
            frames: VecDeque::new(),
            next_start_ms: 0.0,
        }
    }

    /// Add a mixed window's channel energies.
    ///
    /// `window_duration_ms` is the real-time duration of the window.  The
    /// estimator internally maintains a monotonic timeline starting at 0 ms.
    pub fn add_window(&mut self, window_duration_ms: f64, mic_samples: &[f32], sys_samples: &[f32]) {
        let start_ms = self.next_start_ms;
        let end_ms = start_ms + window_duration_ms;
        self.next_start_ms = end_ms;

        let mic_energy = mean_squared(mic_samples);
        let sys_energy = mean_squared(sys_samples);

        self.frames.push_back(EnergyFrame {
            start_ms,
            end_ms,
            mic_energy,
            sys_energy,
        });

        // Keep a bounded history.  Speech segments are usually returned soon
        // after the corresponding windows are processed, so a few minutes of
        // frames is more than enough.  At 600 ms / window this is ~600 frames.
        const MAX_FRAMES: usize = 1000;
        if self.frames.len() > MAX_FRAMES {
            self.frames.pop_front();
        }
    }

    /// Estimate the dominant speaker for a speech segment with the given time
    /// interval (in milliseconds from the start of the VAD session).
    pub fn estimate(&self, start_ms: f64, end_ms: f64) -> SpeakerLabel {
        if start_ms >= end_ms {
            return SpeakerLabel::Unknown;
        }

        let mut weighted_mic: f64 = 0.0;
        let mut weighted_sys: f64 = 0.0;
        let mut total_weight: f64 = 0.0;

        for frame in &self.frames {
            // No overlap
            if frame.end_ms <= start_ms || frame.start_ms >= end_ms {
                continue;
            }

            let overlap_start = frame.start_ms.max(start_ms);
            let overlap_end = frame.end_ms.min(end_ms);
            let overlap = (overlap_end - overlap_start).max(0.0);

            weighted_mic += frame.mic_energy as f64 * overlap;
            weighted_sys += frame.sys_energy as f64 * overlap;
            total_weight += overlap;
        }

        if total_weight <= 0.0 {
            return SpeakerLabel::Unknown;
        }

        let eps = 1e-12;
        let mic_ratio = weighted_mic / (weighted_mic + weighted_sys + eps);

        // Slightly favour "local" when energies are similar: the local microphone
        // is usually the primary signal we want to attribute speech to, while
        // system audio is often echo/playback.
        if mic_ratio > 0.55 {
            SpeakerLabel::Local
        } else if mic_ratio < 0.45 {
            SpeakerLabel::Remote
        } else {
            SpeakerLabel::Unknown
        }
    }
}

fn mean_squared(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f32 = samples.iter().map(|s| s * s).sum();
    sum / samples.len() as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_window(amp: f32, len: usize) -> Vec<f32> {
        (0..len).map(|i| {
            // Simple sine-ish signal so energy scales with amplitude
            let t = i as f32 / len as f32;
            (t * std::f32::consts::TAU).sin() * amp
        }).collect()
    }

    #[test]
    fn empty_estimator_returns_unknown() {
        let estimator = ChannelEnergyEstimator::new();
        assert_eq!(estimator.estimate(0.0, 600.0), SpeakerLabel::Unknown);
    }

    #[test]
    fn local_dominant_window_labels_local() {
        let mut estimator = ChannelEnergyEstimator::new();
        let mic = make_window(1.0, 9600); // 600 ms @ 16 kHz
        let sys = make_window(0.1, 9600);
        estimator.add_window(600.0, &mic, &sys);

        assert_eq!(estimator.estimate(0.0, 600.0), SpeakerLabel::Local);
    }

    #[test]
    fn remote_dominant_window_labels_remote() {
        let mut estimator = ChannelEnergyEstimator::new();
        let mic = make_window(0.1, 9600);
        let sys = make_window(1.0, 9600);
        estimator.add_window(600.0, &mic, &sys);

        assert_eq!(estimator.estimate(0.0, 600.0), SpeakerLabel::Remote);
    }

    #[test]
    fn mixed_windows_estimate_by_overlap_weight() {
        let mut estimator = ChannelEnergyEstimator::new();
        // 0-600 ms: local speaker
        estimator.add_window(600.0, &make_window(1.0, 9600), &make_window(0.1, 9600));
        // 600-1200 ms: remote speaker
        estimator.add_window(600.0, &make_window(0.1, 9600), &make_window(1.0, 9600));

        assert_eq!(estimator.estimate(0.0, 600.0), SpeakerLabel::Local);
        assert_eq!(estimator.estimate(600.0, 1200.0), SpeakerLabel::Remote);
        // Across both speakers is ambiguous (≈50/50) → Unknown
        assert_eq!(estimator.estimate(100.0, 1100.0), SpeakerLabel::Unknown);
    }

    #[test]
    fn frame_capping_keeps_recent_history() {
        let mut estimator = ChannelEnergyEstimator::new();
        for i in 0..1200 {
            let amp = if i % 2 == 0 { 1.0 } else { 0.1 };
            estimator.add_window(600.0, &make_window(amp, 9600), &make_window(0.0, 9600));
        }
        // 1200 frames × 600 ms = 720 s.  Estimator caps at 1000 frames, so the oldest
        // 200 frames are gone.  Querying the oldest 0-600 ms window should be Unknown
        // because its frame has been evicted.
        assert_eq!(estimator.estimate(0.0, 600.0), SpeakerLabel::Unknown);
    }
}
