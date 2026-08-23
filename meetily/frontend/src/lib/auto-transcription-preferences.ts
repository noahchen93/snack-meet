export type AutoTranscriptionProvider = 'localWhisper' | 'parakeet' | 'openai';

export interface AutoTranscriptionPreferences {
  enabled: boolean;
  provider: AutoTranscriptionProvider;
  model: string;
}

const STORAGE_KEY = 'snackmeet-auto-transcription-preferences';

const DEFAULT_MODELS: Record<AutoTranscriptionProvider, string> = {
  localWhisper: 'medium-q5_0',
  parakeet: 'parakeet-tdt-0.6b-v3-int8',
  openai: 'whisper-1',
};

export function isAutoTranscriptionProvider(value: unknown): value is AutoTranscriptionProvider {
  return value === 'localWhisper' || value === 'parakeet' || value === 'openai';
}

export function defaultAutoTranscriptionModel(provider: AutoTranscriptionProvider): string {
  return DEFAULT_MODELS[provider];
}

export function readAutoTranscriptionPreferences(
  fallback?: Partial<AutoTranscriptionPreferences>
): AutoTranscriptionPreferences {
  const fallbackProvider = isAutoTranscriptionProvider(fallback?.provider) ? fallback.provider : 'localWhisper';
  const defaults: AutoTranscriptionPreferences = {
    enabled: false,
    provider: fallbackProvider,
    model: fallback?.model?.trim() || DEFAULT_MODELS[fallbackProvider],
  };

  if (typeof window === 'undefined') return defaults;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<AutoTranscriptionPreferences>;
    const provider = isAutoTranscriptionProvider(parsed.provider) ? parsed.provider : defaults.provider;
    return {
      enabled: parsed.enabled === true,
      provider,
      model: parsed.model?.trim() || DEFAULT_MODELS[provider],
    };
  } catch {
    return defaults;
  }
}

export function saveAutoTranscriptionPreferences(
  preferences: AutoTranscriptionPreferences
): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  window.dispatchEvent(
    new CustomEvent('snackmeet:auto-transcription-preferences-changed', {
      detail: preferences,
    })
  );
}
