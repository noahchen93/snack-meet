import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { Eye, EyeOff, Lock, Unlock } from 'lucide-react';
import { ModelManager } from './WhisperModelManager';
import { ParakeetModelManager } from './ParakeetModelManager';
import { WhisperAPI } from '@/lib/whisper';
import { ParakeetAPI } from '@/lib/parakeet';
import { useLocale } from '@/contexts/LocaleContext';
import {
    AutoTranscriptionPreferences,
    AutoTranscriptionProvider,
    defaultAutoTranscriptionModel,
    isAutoTranscriptionProvider,
    readAutoTranscriptionPreferences,
    saveAutoTranscriptionPreferences,
} from '@/lib/auto-transcription-preferences';


export interface TranscriptModelProps {
    provider: 'localWhisper' | 'parakeet' | 'deepgram' | 'elevenLabs' | 'groq' | 'openai';
    model: string;
    apiKey?: string | null;
}

export interface TranscriptSettingsProps {
    transcriptModelConfig: TranscriptModelProps;
    setTranscriptModelConfig: (config: TranscriptModelProps) => void;
    onModelSelect?: () => void;
}

export function TranscriptSettings({ transcriptModelConfig, setTranscriptModelConfig, onModelSelect }: TranscriptSettingsProps) {
    const { locale } = useLocale();
    const [apiKey, setApiKey] = useState<string | null>(transcriptModelConfig.apiKey || null);
    const [showApiKey, setShowApiKey] = useState<boolean>(false);
    const [isApiKeyLocked, setIsApiKeyLocked] = useState<boolean>(true);
    const [isLockButtonVibrating, setIsLockButtonVibrating] = useState<boolean>(false);
    const [uiProvider, setUiProvider] = useState<TranscriptModelProps['provider']>(transcriptModelConfig.provider);
    const [autoPreferences, setAutoPreferences] = useState<AutoTranscriptionPreferences>(() =>
        readAutoTranscriptionPreferences({
            provider: isAutoTranscriptionProvider(transcriptModelConfig.provider)
                ? transcriptModelConfig.provider
                : 'localWhisper',
            model: transcriptModelConfig.model,
        })
    );
    const [autoModels, setAutoModels] = useState<string[]>([autoPreferences.model]);
    const [isLoadingAutoModels, setIsLoadingAutoModels] = useState(false);

    const updateAutoPreferences = (next: AutoTranscriptionPreferences) => {
        setAutoPreferences(next);
        saveAutoTranscriptionPreferences(next);
    };

    useEffect(() => {
        if (!autoPreferences.enabled) return;

        let cancelled = false;
        const loadModels = async () => {
            setIsLoadingAutoModels(true);
            try {
                if (autoPreferences.provider === 'openai') {
                    if (!cancelled) setAutoModels(['whisper-1']);
                    return;
                }

                const models = autoPreferences.provider === 'parakeet'
                    ? await (async () => {
                        await ParakeetAPI.init();
                        return ParakeetAPI.getAvailableModels();
                    })()
                    : await (async () => {
                        await WhisperAPI.init();
                        return WhisperAPI.getAvailableModels();
                    })();
                const available = models
                    .filter(model => model.status === 'Available')
                    .map(model => model.name);
                if (!cancelled) {
                    setAutoModels(Array.from(new Set([autoPreferences.model, ...available])));
                }
            } catch (error) {
                console.error('Failed to load automatic transcription models:', error);
                if (!cancelled) setAutoModels([autoPreferences.model]);
            } finally {
                if (!cancelled) setIsLoadingAutoModels(false);
            }
        };

        loadModels();
        return () => { cancelled = true; };
    }, [autoPreferences.enabled, autoPreferences.model, autoPreferences.provider]);

    // Sync uiProvider when backend config changes (e.g., after model selection or initial load)
    useEffect(() => {
        setUiProvider(transcriptModelConfig.provider);
    }, [transcriptModelConfig.provider]);

    useEffect(() => {
        if (transcriptModelConfig.provider === 'localWhisper' || transcriptModelConfig.provider === 'parakeet') {
            setApiKey(null);
            setTranscriptModelConfig({ ...transcriptModelConfig, apiKey: null });
        }
    }, [transcriptModelConfig.provider]);

    const updateApiKey = (key: string) => {
        setApiKey(key);
        // Keep the parent config in sync so the saved payload includes the key.
        setTranscriptModelConfig({ ...transcriptModelConfig, apiKey: key || null });
    };

    const fetchApiKey = async (provider: string) => {
        try {

            const data = await invoke('api_get_transcript_api_key', { provider }) as string;

            updateApiKey(data || '');
        } catch (err) {
            console.error('Error fetching API key:', err);
            updateApiKey('');
        }
    };
    const modelOptions = {
        localWhisper: [], // Model selection handled by ModelManager component
        parakeet: [], // Model selection handled by ParakeetModelManager component
        deepgram: ['nova-2-phonecall'],
        elevenLabs: ['eleven_multilingual_v2'],
        groq: ['whisper-large-v3'],
        openai: ['whisper-1'],
    };
    const requiresApiKey = transcriptModelConfig.provider === 'deepgram' || transcriptModelConfig.provider === 'elevenLabs' || transcriptModelConfig.provider === 'openai' || transcriptModelConfig.provider === 'groq';

    const handleInputClick = () => {
        if (isApiKeyLocked) {
            setIsLockButtonVibrating(true);
            setTimeout(() => setIsLockButtonVibrating(false), 500);
        }
    };

    const handleWhisperModelSelect = (modelName: string) => {
        // Always update config when model is selected, regardless of current provider
        // This ensures the model is set when user switches back
        setTranscriptModelConfig({
            ...transcriptModelConfig,
            provider: 'localWhisper', // Ensure provider is set correctly
            model: modelName
        });
        // Close modal after selection
        if (onModelSelect) {
            onModelSelect();
        }
    };

    const handleParakeetModelSelect = (modelName: string) => {
        // Always update config when model is selected, regardless of current provider
        // This ensures the model is set when user switches back
        setTranscriptModelConfig({
            ...transcriptModelConfig,
            provider: 'parakeet', // Ensure provider is set correctly
            model: modelName
        });
        // Close modal after selection
        if (onModelSelect) {
            onModelSelect();
        }
    };

    return (
        <div>
            <div>
                {/* <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-semibold text-gray-900">Transcript Settings</h3>
                </div> */}
                <div className="space-y-4 pb-6">
                    <div>
                        <Label className="block text-sm font-medium text-gray-700 mb-1">
                            Transcript Model
                        </Label>
                        <div className="flex space-x-2 mx-1">
                            <Select
                                value={uiProvider}
                                onValueChange={(value) => {
                                    const provider = value as TranscriptModelProps['provider'];
                                    setUiProvider(provider);
                                    const model = provider === 'openai'
                                        ? 'whisper-1'
                                        : transcriptModelConfig.model;
                                    setTranscriptModelConfig({ ...transcriptModelConfig, provider, model });
                                    if (provider !== 'localWhisper' && provider !== 'parakeet') {
                                        fetchApiKey(provider);
                                    }
                                }}
                            >
                                <SelectTrigger className='focus:ring-1 focus:ring-blue-500 focus:border-blue-500'>
                                    <SelectValue placeholder="Select provider" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="localWhisper">🏠 Local Whisper (Recommended - Chinese & English)</SelectItem>
                                    <SelectItem value="parakeet">⚡ Parakeet (English only)</SelectItem>
                                    <SelectItem value="openai">☁️ OpenAI Whisper API</SelectItem>
                                    {/* <SelectItem value="deepgram">☁️ Deepgram (Backup)</SelectItem>
                                    <SelectItem value="elevenLabs">☁️ ElevenLabs</SelectItem>
                                    <SelectItem value="groq">☁️ Groq</SelectItem> */}
                                </SelectContent>
                            </Select>

                            {uiProvider !== 'localWhisper' && uiProvider !== 'parakeet' && (
                                <Select
                                    value={transcriptModelConfig.model}
                                    onValueChange={(value) => {
                                        const model = value as TranscriptModelProps['model'];
                                        setTranscriptModelConfig({ ...transcriptModelConfig, provider: uiProvider, model });
                                    }}
                                >
                                    <SelectTrigger className='focus:ring-1 focus:ring-blue-500 focus:border-blue-500'>
                                        <SelectValue placeholder="Select model" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {modelOptions[uiProvider].map((model) => (
                                            <SelectItem key={model} value={model}>{model}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}

                        </div>
                        <p className="mx-1 mt-2 text-xs leading-5 text-gray-500">
                            {uiProvider === 'openai'
                                ? locale === 'zh-CN'
                                    ? '云端 OpenAI 支持录制时实时转写。'
                                    : 'OpenAI supports live transcription while recording.'
                                : locale === 'zh-CN'
                                    ? '本地模型不会在录制时运行；停止后的转译行为由下方设置决定。'
                                    : 'Local models do not run while recording; use the setting below to control post-recording transcription.'}
                        </p>
                    </div>

                    <div className="mx-1 rounded-xl border border-gray-200 bg-gray-50 p-4">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <p className="text-sm font-semibold text-gray-900">
                                    {locale === 'zh-CN' ? '录音结束后自动转译' : 'Transcribe automatically after recording'}
                                </p>
                                <p className="mt-1 text-xs leading-5 text-gray-500">
                                    {locale === 'zh-CN'
                                        ? '默认关闭。关闭时只保存音频，你可以稍后在会议记录中手动开始转译。'
                                        : 'Off by default. When off, Snack Meet only saves the audio; you can transcribe it manually later.'}
                                </p>
                            </div>
                            <Switch
                                checked={autoPreferences.enabled}
                                onCheckedChange={(enabled) => updateAutoPreferences({ ...autoPreferences, enabled })}
                                aria-label={locale === 'zh-CN' ? '录音结束后自动转译' : 'Automatic post-recording transcription'}
                            />
                        </div>

                        {autoPreferences.enabled && (
                            <div className="mt-4 grid gap-3 sm:grid-cols-2">
                                <div>
                                    <Label className="mb-1 block text-xs font-medium text-gray-600">
                                        {locale === 'zh-CN' ? '自动转译服务' : 'Automatic transcription provider'}
                                    </Label>
                                    <Select
                                        value={autoPreferences.provider}
                                        onValueChange={(value) => {
                                            const provider = value as AutoTranscriptionProvider;
                                            const model = defaultAutoTranscriptionModel(provider);
                                            setAutoModels([model]);
                                            updateAutoPreferences({ ...autoPreferences, provider, model });
                                        }}
                                    >
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="localWhisper">Local Whisper</SelectItem>
                                            <SelectItem value="parakeet">Parakeet</SelectItem>
                                            <SelectItem value="openai">OpenAI Whisper API</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div>
                                    <Label className="mb-1 block text-xs font-medium text-gray-600">
                                        {locale === 'zh-CN' ? '自动转译模型' : 'Automatic transcription model'}
                                    </Label>
                                    <Select
                                        value={autoPreferences.model}
                                        onValueChange={(model) => updateAutoPreferences({ ...autoPreferences, model })}
                                    >
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            {autoModels.map(model => (
                                                <SelectItem key={model} value={model}>{model}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    {isLoadingAutoModels && (
                                        <p className="mt-1 text-[11px] text-gray-400">
                                            {locale === 'zh-CN' ? '正在读取已安装模型…' : 'Loading installed models…'}
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>

                    {uiProvider === 'localWhisper' && (
                        <div className="mt-6">
                            <ModelManager
                                selectedModel={transcriptModelConfig.provider === 'localWhisper' ? transcriptModelConfig.model : undefined}
                                onModelSelect={handleWhisperModelSelect}
                                autoSave={true}
                            />
                        </div>
                    )}

                    {uiProvider === 'parakeet' && (
                        <div className="mt-6">
                            <ParakeetModelManager
                                selectedModel={transcriptModelConfig.provider === 'parakeet' ? transcriptModelConfig.model : undefined}
                                onModelSelect={handleParakeetModelSelect}
                                autoSave={true}
                            />
                        </div>
                    )}


                    {requiresApiKey && (
                        <div>
                            <Label className="block text-sm font-medium text-gray-700 mb-1">
                                API Key
                            </Label>
                            <div className="relative mx-1">
                                <Input
                                    type={showApiKey ? "text" : "password"}
                                    className={`pr-24 focus:ring-1 focus:ring-blue-500 focus:border-blue-500 ${isApiKeyLocked ? 'bg-gray-100 cursor-not-allowed' : ''
                                        }`}
                                    value={apiKey || ''}
                                    onChange={(e) => updateApiKey(e.target.value)}
                                    disabled={isApiKeyLocked}
                                    onClick={handleInputClick}
                                    placeholder="Enter your API key"
                                />
                                {isApiKeyLocked && (
                                    <div
                                        onClick={handleInputClick}
                                        className="absolute inset-0 flex items-center justify-center bg-gray-100 bg-opacity-50 rounded-md cursor-not-allowed"
                                    />
                                )}
                                <div className="absolute inset-y-0 right-0 pr-1 flex items-center">
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => setIsApiKeyLocked(!isApiKeyLocked)}
                                        className={`transition-colors duration-200 ${isLockButtonVibrating ? 'animate-vibrate text-red-500' : ''
                                            }`}
                                        title={isApiKeyLocked ? "Unlock to edit" : "Lock to prevent editing"}
                                    >
                                        {isApiKeyLocked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => setShowApiKey(!showApiKey)}
                                    >
                                        {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                    </Button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div >
    )
}


