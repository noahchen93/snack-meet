use crate::database::models::{Setting, TranscriptSetting};
use crate::summary::CustomOpenAIConfig;
use sqlx::SqlitePool;

#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "app.snackmeet.credentials";

#[cfg(target_os = "macos")]
fn keychain_account(scope: &str, provider: &str) -> String {
    format!("{scope}:{provider}")
}

#[cfg(target_os = "macos")]
fn save_keychain_secret(scope: &str, provider: &str, secret: &str) -> Result<(), sqlx::Error> {
    let account = keychain_account(scope, provider);
    if secret.trim().is_empty() {
        let _ = security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, &account);
        return Ok(());
    }
    security_framework::passwords::set_generic_password(
        KEYCHAIN_SERVICE,
        &account,
        secret.as_bytes(),
    )
    .map_err(|error| {
        sqlx::Error::Protocol(
            format!("Failed to store credential in macOS Keychain: {error}").into(),
        )
    })
}

#[cfg(target_os = "macos")]
fn read_keychain_secret(scope: &str, provider: &str) -> Option<String> {
    let account = keychain_account(scope, provider);
    security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, &account)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|secret| !secret.trim().is_empty())
}

#[cfg(target_os = "macos")]
fn delete_keychain_secret(scope: &str, provider: &str) {
    let account = keychain_account(scope, provider);
    let _ = security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, &account);
}

#[derive(serde::Deserialize, Debug)]
pub struct SaveModelConfigRequest {
    pub provider: String,
    pub model: String,
    #[serde(rename = "whisperModel")]
    pub whisper_model: String,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
    #[serde(rename = "ollamaEndpoint")]
    pub ollama_endpoint: Option<String>,
}

#[derive(serde::Deserialize, Debug)]
pub struct SaveTranscriptConfigRequest {
    pub provider: String,
    pub model: String,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
}

pub struct SettingsRepository;

// Transcript providers: localWhisper, deepgram, elevenLabs, groq, openai
// Summary providers: openai, claude, ollama, groq, added openrouter
// NOTE: Handle data exclusion in the higher layer as this is database abstraction layer(using SELECT *)

impl SettingsRepository {
    pub async fn get_model_config(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<Setting>, sqlx::Error> {
        let setting = sqlx::query_as::<_, Setting>("SELECT * FROM settings LIMIT 1")
            .fetch_optional(pool)
            .await?;
        Ok(setting)
    }

    pub async fn save_model_config(
        pool: &SqlitePool,
        provider: &str,
        model: &str,
        whisper_model: &str,
        ollama_endpoint: Option<&str>,
    ) -> std::result::Result<(), sqlx::Error> {
        // Using id '1' for backward compatibility
        sqlx::query(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, ollamaEndpoint)
            VALUES ('1', $1, $2, $3, $4)
            ON CONFLICT(id) DO UPDATE SET
                provider = excluded.provider,
                model = excluded.model,
                whisperModel = excluded.whisperModel,
                ollamaEndpoint = excluded.ollamaEndpoint
            "#,
        )
        .bind(provider)
        .bind(model)
        .bind(whisper_model)
        .bind(ollama_endpoint)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn save_api_key(
        pool: &SqlitePool,
        provider: &str,
        api_key: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        // Custom OpenAI uses JSON config (customOpenAIConfig) instead of a separate API key column
        if provider == "custom-openai" {
            return Err(sqlx::Error::Protocol(
                "custom-openai provider should use save_custom_openai_config() instead of save_api_key()".into(),
            ));
        }

        let api_key_column = match provider {
            "openai" => "openaiApiKey",
            "claude" => "anthropicApiKey",
            "ollama" => "ollamaApiKey",
            "groq" => "groqApiKey",
            "openrouter" => "openRouterApiKey",
            "builtin-ai" => return Ok(()), // No API key needed
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        #[cfg(target_os = "macos")]
        save_keychain_secret("summary", provider, api_key)?;

        let query = format!(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, "{}")
            VALUES ('1', 'openai', 'gpt-4o-2024-11-20', 'large-v3', $1)
            ON CONFLICT(id) DO UPDATE SET
                "{}" = $1
            "#,
            api_key_column, api_key_column
        );
        #[cfg(target_os = "macos")]
        let database_value: Option<&str> = None;
        #[cfg(not(target_os = "macos"))]
        let database_value = Some(api_key);
        sqlx::query(&query)
            .bind(database_value)
            .execute(pool)
            .await?;

        Ok(())
    }

    /// Reads the global user-defined summary system prompt (unified style for all meetings).
    pub async fn get_summary_system_prompt(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<String>, sqlx::Error> {
        let value: Option<String> =
            sqlx::query_scalar("SELECT summarySystemPrompt FROM settings WHERE id = '1' LIMIT 1")
                .fetch_optional(pool)
                .await?;
        Ok(value.filter(|v| !v.trim().is_empty()))
    }

    /// Saves (or clears) the global user-defined summary system prompt.
    pub async fn save_summary_system_prompt(
        pool: &SqlitePool,
        prompt: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        let value = prompt.trim();
        if value.is_empty() {
            sqlx::query("UPDATE settings SET summarySystemPrompt = NULL WHERE id = '1'")
                .execute(pool)
                .await?;
        } else {
            sqlx::query(
                "INSERT INTO settings (id, provider, model, whisperModel, summarySystemPrompt) \
                 VALUES ('1', '', '', '', $1) \
                 ON CONFLICT(id) DO UPDATE SET summarySystemPrompt = excluded.summarySystemPrompt",
            )
            .bind(value)
            .execute(pool)
            .await?;
        }
        Ok(())
    }

    pub async fn get_api_key(
        pool: &SqlitePool,
        provider: &str,
    ) -> std::result::Result<Option<String>, sqlx::Error> {
        // Custom OpenAI uses JSON config - extract API key from there
        if provider == "custom-openai" {
            let config = Self::get_custom_openai_config(pool).await?;
            return Ok(config.and_then(|c| c.api_key));
        }

        let api_key_column = match provider {
            "openai" => "openaiApiKey",
            "ollama" => "ollamaApiKey",
            "groq" => "groqApiKey",
            "claude" => "anthropicApiKey",
            "openrouter" => "openRouterApiKey",
            "builtin-ai" => return Ok(None), // No API key needed
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        #[cfg(target_os = "macos")]
        if let Some(secret) = read_keychain_secret("summary", provider) {
            return Ok(Some(secret));
        }

        let query = format!(
            "SELECT {} FROM settings WHERE id = '1' LIMIT 1",
            api_key_column
        );
        let api_key: Option<String> = sqlx::query_scalar(&query).fetch_optional(pool).await?;

        // One-time migration for existing Snack Meet installations. The
        // plaintext database column is cleared only after Keychain succeeds.
        #[cfg(target_os = "macos")]
        if let Some(ref secret) = api_key {
            if !secret.trim().is_empty() {
                save_keychain_secret("summary", provider, secret)?;
                let clear_query = format!(
                    "UPDATE settings SET {} = NULL WHERE id = '1'",
                    api_key_column
                );
                sqlx::query(&clear_query).execute(pool).await?;
            }
        }
        Ok(api_key)
    }

    pub async fn get_transcript_config(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<TranscriptSetting>, sqlx::Error> {
        let setting =
            sqlx::query_as::<_, TranscriptSetting>("SELECT * FROM transcript_settings LIMIT 1")
                .fetch_optional(pool)
                .await?;
        Ok(setting)
    }

    pub async fn save_transcript_config(
        pool: &SqlitePool,
        provider: &str,
        model: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO transcript_settings (id, provider, model)
            VALUES ('1', $1, $2)
            ON CONFLICT(id) DO UPDATE SET
                provider = excluded.provider,
                model = excluded.model
            "#,
        )
        .bind(provider)
        .bind(model)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn save_transcript_api_key(
        pool: &SqlitePool,
        provider: &str,
        api_key: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        let api_key_column = match provider {
            "localWhisper" => "whisperApiKey",
            "parakeet" => return Ok(()), // Parakeet doesn't need an API key, return early
            "deepgram" => "deepgramApiKey",
            "elevenLabs" => "elevenLabsApiKey",
            "groq" => "groqApiKey",
            "openai" => "openaiApiKey",
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        #[cfg(target_os = "macos")]
        save_keychain_secret("transcription", provider, api_key)?;

        let query = format!(
            r#"
            INSERT INTO transcript_settings (id, provider, model, "{}")
            VALUES ('1', 'parakeet', '{}', $1)
            ON CONFLICT(id) DO UPDATE SET
                "{}" = $1
            "#,
            api_key_column,
            crate::config::DEFAULT_PARAKEET_MODEL,
            api_key_column
        );
        #[cfg(target_os = "macos")]
        let database_value: Option<&str> = None;
        #[cfg(not(target_os = "macos"))]
        let database_value = Some(api_key);
        sqlx::query(&query)
            .bind(database_value)
            .execute(pool)
            .await?;

        Ok(())
    }

    pub async fn get_transcript_api_key(
        pool: &SqlitePool,
        provider: &str,
    ) -> std::result::Result<Option<String>, sqlx::Error> {
        let api_key_column = match provider {
            "localWhisper" => "whisperApiKey",
            "parakeet" => return Ok(None), // Parakeet doesn't need an API key
            "deepgram" => "deepgramApiKey",
            "elevenLabs" => "elevenLabsApiKey",
            "groq" => "groqApiKey",
            "openai" => "openaiApiKey",
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        #[cfg(target_os = "macos")]
        if let Some(secret) = read_keychain_secret("transcription", provider) {
            return Ok(Some(secret));
        }

        let query = format!(
            "SELECT {} FROM transcript_settings WHERE id = '1' LIMIT 1",
            api_key_column
        );
        let api_key: Option<String> = sqlx::query_scalar(&query).fetch_optional(pool).await?;
        #[cfg(target_os = "macos")]
        if let Some(ref secret) = api_key {
            if !secret.trim().is_empty() {
                save_keychain_secret("transcription", provider, secret)?;
                let clear_query = format!(
                    "UPDATE transcript_settings SET {} = NULL WHERE id = '1'",
                    api_key_column
                );
                sqlx::query(&clear_query).execute(pool).await?;
            }
        }
        Ok(api_key)
    }

    pub async fn delete_api_key(
        pool: &SqlitePool,
        provider: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        // Custom OpenAI uses JSON config - clear the entire config
        if provider == "custom-openai" {
            #[cfg(target_os = "macos")]
            delete_keychain_secret("summary", provider);
            sqlx::query("UPDATE settings SET customOpenAIConfig = NULL WHERE id = '1'")
                .execute(pool)
                .await?;
            return Ok(());
        }

        let api_key_column = match provider {
            "openai" => "openaiApiKey",
            "ollama" => "ollamaApiKey",
            "groq" => "groqApiKey",
            "claude" => "anthropicApiKey",
            "openrouter" => "openRouterApiKey",
            "builtin-ai" => return Ok(()), // No API key needed
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        #[cfg(target_os = "macos")]
        delete_keychain_secret("summary", provider);

        let query = format!(
            "UPDATE settings SET {} = NULL WHERE id = '1'",
            api_key_column
        );
        sqlx::query(&query).execute(pool).await?;

        Ok(())
    }

    // ===== CUSTOM OPENAI CONFIG METHODS =====

    /// Gets the custom OpenAI configuration from JSON
    ///
    /// # Returns
    /// * `Ok(Some(CustomOpenAIConfig))` - Config exists and is valid JSON
    /// * `Ok(None)` - No config stored
    /// * `Err(sqlx::Error)` - Database error
    pub async fn get_custom_openai_config(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<CustomOpenAIConfig>, sqlx::Error> {
        use sqlx::Row;

        let row = sqlx::query(
            r#"
            SELECT customOpenAIConfig
            FROM settings
            WHERE id = '1'
            LIMIT 1
            "#,
        )
        .fetch_optional(pool)
        .await?;

        match row {
            Some(record) => {
                let config_json: Option<String> = record.get("customOpenAIConfig");

                if let Some(json) = config_json {
                    // Parse JSON into CustomOpenAIConfig
                    let mut config: CustomOpenAIConfig =
                        serde_json::from_str(&json).map_err(|e| {
                            sqlx::Error::Protocol(
                                format!("Invalid JSON in customOpenAIConfig: {}", e).into(),
                            )
                        })?;

                    #[cfg(target_os = "macos")]
                    {
                        if let Some(secret) = read_keychain_secret("summary", "custom-openai") {
                            config.api_key = Some(secret);
                        } else if let Some(legacy_secret) = config.api_key.clone() {
                            if !legacy_secret.trim().is_empty() {
                                save_keychain_secret("summary", "custom-openai", &legacy_secret)?;
                                let mut redacted = config.clone();
                                redacted.api_key = None;
                                let redacted_json = serde_json::to_string(&redacted).map_err(|error| {
                                    sqlx::Error::Protocol(format!("Failed to redact legacy custom credential: {error}").into())
                                })?;
                                sqlx::query(
                                    "UPDATE settings SET customOpenAIConfig = ? WHERE id = '1'",
                                )
                                .bind(redacted_json)
                                .execute(pool)
                                .await?;
                            }
                        }
                    }

                    Ok(Some(config))
                } else {
                    Ok(None)
                }
            }
            None => Ok(None),
        }
    }

    /// Saves the custom OpenAI configuration as JSON
    ///
    /// # Arguments
    /// * `pool` - Database connection pool
    /// * `config` - CustomOpenAIConfig to save (includes endpoint, apiKey, model, maxTokens, temperature, topP)
    ///
    /// # Returns
    /// * `Ok(())` - Config saved successfully
    /// * `Err(sqlx::Error)` - Database or JSON serialization error
    pub async fn save_custom_openai_config(
        pool: &SqlitePool,
        config: &CustomOpenAIConfig,
    ) -> std::result::Result<(), sqlx::Error> {
        let mut database_config = config.clone();
        #[cfg(target_os = "macos")]
        {
            match config.api_key.as_deref() {
                Some(secret) if !secret.trim().is_empty() => {
                    save_keychain_secret("summary", "custom-openai", secret)?;
                }
                _ => delete_keychain_secret("summary", "custom-openai"),
            }
            database_config.api_key = None;
        }

        // Only non-secret endpoint/model parameters are serialized on macOS.
        let config_json = serde_json::to_string(&database_config).map_err(|e| {
            sqlx::Error::Protocol(format!("Failed to serialize config to JSON: {}", e).into())
        })?;

        // Upsert into settings table
        sqlx::query(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, customOpenAIConfig)
            VALUES ('1', 'custom-openai', $1, 'large-v3', $2)
            ON CONFLICT(id) DO UPDATE SET
                customOpenAIConfig = excluded.customOpenAIConfig
            "#,
        )
        .bind(&config.model)
        .bind(config_json)
        .execute(pool)
        .await?;

        Ok(())
    }
}
