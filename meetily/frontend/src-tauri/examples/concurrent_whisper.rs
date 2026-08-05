// examples/concurrent_whisper.rs
//
// Verifies that WhisperEngine can keep multiple downloaded models loaded at the
// same time, and that loading a model concurrently does not evict the current
// model.

use app_lib::whisper_engine::WhisperEngine;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let models_dir = dirs::data_dir()
        .ok_or_else(|| anyhow::anyhow!("system data dir not found"))?
        .join("com.meetily.ai")
        .join("models");

    println!("Using models directory: {}", models_dir.display());

    let engine = WhisperEngine::new_with_models_dir(Some(models_dir))?;
    engine.discover_models().await?;

    // Load the first model as the live/current model.
    println!("Loading medium-q5_0 as current model...");
    engine.load_model("medium-q5_0").await?;
    assert_eq!(engine.get_current_model().await, Some("medium-q5_0".to_string()));
    assert!(engine.is_model_loaded_named("medium-q5_0").await);

    // Load a second model concurrently; the current model should stay unchanged.
    println!("Loading large-v3-turbo-q5_0 concurrently...");
    engine.load_model_concurrent("large-v3-turbo-q5_0").await?;
    assert_eq!(engine.get_current_model().await, Some("medium-q5_0".to_string()));
    assert!(engine.is_model_loaded_named("medium-q5_0").await);
    assert!(engine.is_model_loaded_named("large-v3-turbo-q5_0").await);

    let mut loaded = engine.loaded_models().await;
    loaded.sort();
    assert_eq!(
        loaded,
        vec!["large-v3-turbo-q5_0".to_string(), "medium-q5_0".to_string()]
    );
    println!("Both models loaded concurrently: {:?}", loaded);

    // Unload the current model and verify the other remains usable.
    assert!(engine.unload_model_named("medium-q5_0").await);
    assert!(!engine.is_model_loaded_named("medium-q5_0").await);
    assert!(engine.is_model_loaded_named("large-v3-turbo-q5_0").await);
    assert!(engine.get_current_model().await.is_none());
    println!("After unloading medium-q5_0, large-v3-turbo-q5_0 remains loaded.");

    // Clean up.
    assert!(engine.unload_model_named("large-v3-turbo-q5_0").await);
    assert!(engine.loaded_models().await.is_empty());

    println!("Concurrent model verification passed.");
    Ok(())
}
