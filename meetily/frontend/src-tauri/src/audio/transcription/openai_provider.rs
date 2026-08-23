// audio/transcription/openai_provider.rs
//
// OpenAI Whisper API transcription provider.
//
// Implements the unified TranscriptionProvider trait so live recording can use
// the cloud API, and exposes `transcribe_audio_file` so file-based flows
// (retranscription / batch) can transcribe a whole file in a single request
// and get back timestamped segments.

use super::provider::{TranscriptResult, TranscriptionError, TranscriptionProvider};
use async_trait::async_trait;
use log::{debug, info};
use reqwest::multipart::{Form, Part};
use reqwest::Client;
use serde::Deserialize;
use std::path::Path;

/// Default OpenAI transcription endpoint
pub const OPENAI_TRANSCRIPTION_URL: &str = "https://api.openai.com/v1/audio/transcriptions";

/// Optional override for the transcription base URL (proxies / compatible APIs).
/// Only the request URL is replaced; the payload stays OpenAI-compatible.
fn transcription_url() -> String {
    match std::env::var("OPENAI_TRANSCRIPTION_BASE_URL") {
        Ok(base) if !base.trim().is_empty() => {
            let base = base.trim().trim_end_matches('/');
            format!("{}/v1/audio/transcriptions", base)
        }
        _ => OPENAI_TRANSCRIPTION_URL.to_string(),
    }
}

/// One timestamped segment returned by the OpenAI Whisper API (verbose_json).
#[derive(Debug, Clone, Deserialize)]
pub struct OpenAISegment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// verbose_json response from the Whisper API.
#[derive(Debug, Deserialize)]
struct VerboseJsonResponse {
    #[allow(dead_code)]
    text: String,
    #[allow(dead_code)]
    duration: f64,
    segments: Vec<OpenAISegment>,
}

/// Result of transcribing a whole file.
#[derive(Debug, Clone)]
pub struct TranscribedFile {
    pub segments: Vec<OpenAISegment>,
    pub duration_secs: f64,
}

/// Wraps the raw `audio: f32` samples into a 16-bit PCM mono WAV buffer so it
/// can be uploaded to the Whisper API (which accepts WAV, MP3, M4A, etc.).
fn samples_to_wav(samples: &[f32]) -> Vec<u8> {
    const SAMPLE_RATE: u32 = 16000;
    const CHANNELS: u16 = 1;
    const BITS_PER_SAMPLE: u16 = 16;

    let data_len = samples.len() * 2;
    let mut wav = Vec::with_capacity(44 + data_len);

    // RIFF header
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVE");

    // fmt chunk
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&CHANNELS.to_le_bytes());
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(
        &(SAMPLE_RATE * CHANNELS as u32 * BITS_PER_SAMPLE as u32 / 8).to_le_bytes(),
    );
    wav.extend_from_slice(&(CHANNELS * BITS_PER_SAMPLE / 8).to_le_bytes());
    wav.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());

    // data chunk
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data_len as u32).to_le_bytes());
    for &s in samples {
        let v = if s.is_nan() || s.is_infinite() {
            0.0
        } else {
            s
        };
        let i16_val = (v.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        wav.extend_from_slice(&i16_val.to_le_bytes());
    }

    wav
}

/// Build the multipart form from an audio file path.
fn form_from_file(
    path: &Path,
    model: &str,
    language: Option<&str>,
) -> Result<Form, TranscriptionError> {
    let bytes = std::fs::read(path).map_err(|e| {
        TranscriptionError::EngineFailed(format!("Failed to read audio file: {}", e))
    })?;
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("audio")
        .to_string();

    let file_part = Part::bytes(bytes)
        .file_name(filename)
        .mime_str("application/octet-stream")
        .map_err(|e| TranscriptionError::EngineFailed(e.to_string()))?;

    let mut form = Form::new()
        .text("model", model.to_string())
        .text("response_format", "verbose_json".to_string())
        .part("file", file_part);

    if let Some(lang) = language {
        if !lang.trim().is_empty() {
            form = form.text("language", lang.trim().to_string());
        }
    }

    Ok(form)
}

/// Send a transcription request and return the raw verbose_json response.
async fn post_transcription(
    form: Form,
    api_key: &str,
) -> Result<VerboseJsonResponse, TranscriptionError> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| TranscriptionError::EngineFailed(format!("HTTP client error: {}", e)))?;

    let response = client
        .post(transcription_url())
        .bearer_auth(api_key.trim())
        .multipart(form)
        .send()
        .await
        .map_err(|e| TranscriptionError::EngineFailed(format!("Request failed: {}", e)))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(TranscriptionError::EngineFailed(format!(
            "OpenAI transcription failed ({}): {}",
            status,
            body.chars().take(500).collect::<String>()
        )));
    }

    let parsed = response.json::<VerboseJsonResponse>().await.map_err(|e| {
        TranscriptionError::EngineFailed(format!("Failed to parse response: {}", e))
    })?;

    Ok(parsed)
}

/// Transcribe a whole audio file in a single request and return timestamped
/// segments (seconds) plus the total duration. Used by retranscription and
/// batch import.
pub async fn transcribe_audio_file(
    path: &Path,
    api_key: &str,
    model: &str,
    language: Option<&str>,
) -> Result<TranscribedFile, TranscriptionError> {
    let form = form_from_file(path, model, language)?;
    let parsed = post_transcription(form, api_key).await?;

    info!(
        "OpenAI transcription of {}: {} segments",
        path.display(),
        parsed.segments.len()
    );

    Ok(TranscribedFile {
        segments: parsed.segments,
        duration_secs: parsed.duration,
    })
}

/// OpenAI Whisper API provider (implements the unified trait for live recording).
pub struct OpenAIWhisperApiProvider {
    api_key: String,
    model: String,
}

impl OpenAIWhisperApiProvider {
    pub fn new(api_key: String, model: String) -> Self {
        Self { api_key, model }
    }
}

#[async_trait]
impl TranscriptionProvider for OpenAIWhisperApiProvider {
    async fn transcribe(
        &self,
        audio: Vec<f32>,
        language: Option<String>,
    ) -> std::result::Result<TranscriptResult, TranscriptionError> {
        let wav = samples_to_wav(&audio);
        let file_part = Part::bytes(wav)
            .file_name("segment.wav".to_string())
            .mime_str("audio/wav")
            .map_err(|e| TranscriptionError::EngineFailed(e.to_string()))?;

        let mut form = Form::new()
            .text("model", self.model.clone())
            .text("response_format", "verbose_json".to_string())
            .part("file", file_part);

        if let Some(lang) = language {
            if !lang.trim().is_empty() {
                form = form.text("language", lang.trim().to_string());
            }
        }

        let parsed = post_transcription(form, &self.api_key).await?;

        let mut text = String::new();
        for seg in &parsed.segments {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(seg.text.trim());
        }

        debug!("OpenAI transcription chunk: {}", text);
        Ok(TranscriptResult {
            text,
            confidence: None,
            is_partial: false,
        })
    }

    async fn is_model_loaded(&self) -> bool {
        // Cloud API has no local model to load.
        !self.api_key.trim().is_empty()
    }

    async fn get_current_model(&self) -> Option<String> {
        Some(self.model.clone())
    }

    fn provider_name(&self) -> &'static str {
        "OpenAI Whisper API"
    }
}
