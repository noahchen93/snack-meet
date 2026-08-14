//! Runtime inference parameters for local Ollama models.
//!
//! Single source of truth for the *effective* context window of a local model:
//! the value sent to Ollama (`num_ctx`) and the chunk budget used by the
//! summarizer both derive from these helpers, so a long transcript can never
//! exceed what the model actually sees at request time (which previously made
//! long-meeting summaries stop halfway).
//!
//! Priority: environment variable override > memory-aware auto-fit.
//!
//! Supported env vars (all optional):
//! * `OLLAMA_NUM_CTX`         - override the context window (e.g. `OLLAMA_NUM_CTX=32768`)
//! * `OLLAMA_NUM_PREDICT`     - override the max output tokens
//! * `OLLAMA_ENABLE_THINKING` - set to `1`/`true` to KEEP reasoning models' thinking output
//! * `OLLAMA_TIMEOUT_SECS`    - override the request timeout in seconds

use crate::ollama::metadata::ModelMetadataCache;
use once_cell::sync::Lazy;
use std::time::Duration;

/// Resolved parameters for a single Ollama inference request.
#[derive(Debug, Clone)]
pub struct OllamaParams {
    pub num_ctx: u32,
    pub num_predict: u32,
    pub disable_thinking: bool,
    pub timeout: Duration,
}

/// Long-lived, shared cache for per-model `/api/show` metadata.
static MODEL_CACHE: Lazy<ModelMetadataCache> =
    Lazy::new(|| ModelMetadataCache::new(Duration::from_secs(300)));

const GB: u64 = 1024 * 1024 * 1024;

/// Absolute cap so an accidental env override can't ask for absurd contexts.
const MAX_SAFE_CTX: u32 = 65536;

/// Total physical RAM in GB (macOS: `sysctl hw.memsize`). Falls back to 16.
pub fn system_memory_gb() -> u64 {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
        {
            if let Ok(s) = String::from_utf8(out.stdout) {
                if let Ok(bytes) = s.trim().parse::<u64>() {
                    return bytes / GB;
                }
            }
        }
    }
    16 // fallback assumption
}

/// Conservative default context window based on total system RAM, so the KV
/// cache fits in memory while staying large enough that long recordings are not
/// truncated. Capped further by the model's own context length.
pub fn default_num_ctx_for_system() -> u32 {
    match system_memory_gb() {
        0..=8 => 4096,
        9..=16 => 16384,
        17..=32 => 32768,
        _ => 65536,
    }
}

/// The `num_ctx` that will actually be sent to Ollama for a model with the
/// given declared context length.
pub fn effective_num_ctx_for(model_context_size: usize) -> u32 {
    let model_ctx = (model_context_size as u32).clamp(512, MAX_SAFE_CTX);
    let auto_ctx = default_num_ctx_for_system().min(model_ctx).max(512);
    env_u32("OLLAMA_NUM_CTX")
        .unwrap_or(auto_ctx)
        .clamp(512, model_ctx)
}

/// The `num_predict` (max output tokens) that will be sent to Ollama.
pub fn effective_num_predict() -> u32 {
    env_u32("OLLAMA_NUM_PREDICT")
        .unwrap_or(2048)
        .clamp(64, 65536)
}

/// How many input tokens can safely fit into one request for a model with the
/// given context length (context minus output budget minus prompt overhead).
/// The summarizer chunks long transcripts at this size so nothing is truncated.
pub fn effective_input_budget(model_context_size: usize) -> usize {
    let ctx = effective_num_ctx_for(model_context_size) as usize;
    let predict = effective_num_predict() as usize;
    ctx.saturating_sub(predict)
        .saturating_sub(300)
        .max(1)
        .min(ctx.saturating_sub(300).max(1))
}

/// Resolve the full set of request parameters for a model.
pub async fn resolve(model: &str, endpoint: Option<&str>) -> OllamaParams {
    let base = endpoint
        .unwrap_or("http://localhost:11434")
        .trim_end_matches('/');

    let model_ctx = MODEL_CACHE
        .get_or_fetch(model, Some(base))
        .await
        .ok()
        .map(|m| m.context_size)
        .unwrap_or(262144);

    let num_ctx = effective_num_ctx_for(model_ctx);
    let num_predict = effective_num_predict();

    let disable_thinking = match std::env::var("OLLAMA_ENABLE_THINKING") {
        Ok(v) => {
            let v = v.trim().to_ascii_lowercase();
            !(v == "1" || v == "true")
        }
        Err(_) => true,
    };

    let timeout_secs = env_u64("OLLAMA_TIMEOUT_SECS")
        .unwrap_or(600)
        .clamp(60, 3600);

    OllamaParams {
        num_ctx,
        num_predict,
        disable_thinking,
        timeout: Duration::from_secs(timeout_secs),
    }
}

fn env_u32(key: &str) -> Option<u32> {
    std::env::var(key).ok()?.trim().parse().ok()
}

fn env_u64(key: &str) -> Option<u64> {
    std::env::var(key).ok()?.trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::{effective_input_budget, effective_num_ctx_for};

    #[test]
    fn input_budget_never_exceeds_runtime_context() {
        for model_context in [512, 2048, 4096, 16384, 262144] {
            let context = effective_num_ctx_for(model_context) as usize;
            assert!(effective_input_budget(model_context) <= context);
        }
    }

    #[test]
    fn runtime_context_is_capped_by_model_context() {
        assert!(effective_num_ctx_for(4096) <= 4096);
        assert!(effective_num_ctx_for(16384) <= 16384);
    }
}
