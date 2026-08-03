import React, { useState, useEffect, useMemo, useRef } from 'react';
import { RefreshCw, Globe, AlertCircle, Cpu } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';
import { LANGUAGES } from '@/constants/languages';
import { useTranscriptionModels, ModelOption } from '@/hooks/useTranscriptionModels';
import Analytics from '@/lib/analytics';

interface RetranscribeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  meetingFolderPath: string | null;
  // Retained for API compatibility. Completion is now handled globally by
  // RetranscriptionOverlayProvider (floating progress pill), so this is unused.
  onComplete?: () => void;
}

export function RetranscribeDialog({
  open,
  onOpenChange,
  meetingId,
  meetingFolderPath,
}: RetranscribeDialogProps) {
  const { selectedLanguage, transcriptModelConfig } = useConfig();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [selectedLang, setSelectedLang] = useState(selectedLanguage || 'auto');

  // Use centralized model fetching hook
  const {
    availableModels,
    selectedModelKey,
    setSelectedModelKey,
    loadingModels,
    fetchModels,
    resetSelection,
  } = useTranscriptionModels(transcriptModelConfig);

  // Helper to get selected model details (memoized)
  const selectedModelDetails = useMemo((): ModelOption | undefined => {
    if (!selectedModelKey) return undefined;
    const colonIndex = selectedModelKey.indexOf(':');
    if (colonIndex === -1) return undefined;
    const provider = selectedModelKey.slice(0, colonIndex);
    const name = selectedModelKey.slice(colonIndex + 1);
    return availableModels.find(m => m.provider === provider && m.name === name);
  }, [selectedModelKey, availableModels]);
  const isParakeetModel = selectedModelDetails?.provider === 'parakeet';

  useEffect(() => {
    if (isParakeetModel && selectedLang !== 'auto') {
      setSelectedLang('auto');
    }
  }, [isParakeetModel, selectedLang]);

  // Reset state only when dialog transitions from closed to open.
  const prevOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    if (open && !wasOpen) {
      resetSelection();
      setError(null);
      setStarting(false);
      setSelectedLang(selectedLanguage || 'auto');
      fetchModels();
    }
  }, [open, selectedLanguage, transcriptModelConfig, fetchModels, resetSelection]);

  const handleStartRetranscription = async () => {
    if (!meetingFolderPath) {
      setError('Meeting folder path not available');
      return;
    }

    setStarting(true);
    setError(null);

    try {
      const languageToSend = isParakeetModel ? null : selectedLang === 'auto' ? null : selectedLang;
      await Analytics.track('enhance_transcript_started', {
        language: isParakeetModel ? 'auto' : (selectedLang === 'auto' ? 'auto' : selectedLang),
        model_provider: selectedModelDetails?.provider || '',
        model_name: selectedModelDetails?.name || ''
      });

      await invoke('start_retranscription_command', {
        meetingId,
        meetingFolderPath,
        language: languageToSend,
        model: selectedModelDetails?.name || null,
        provider: selectedModelDetails?.provider || null,
      });

      // The backend spawned the job and returned immediately. Transcription
      // now runs in the background; close the dialog and let the floating
      // overlay (RetranscriptionOverlayProvider) show progress + cancel.
      toast.success('已在后台开始重新转译');
      onOpenChange(false);
    } catch (err: any) {
      setStarting(false);
      const errorMsg = typeof err === 'string' ? err : (err?.message || String(err));
      setError(errorMsg);
      await Analytics.trackError('enhance_transcript_failed', errorMsg);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {error ? (
              <>
                <AlertCircle className="h-5 w-5 text-red-600" />
                Retranscription Failed
              </>
            ) : (
              <>
                <RefreshCw className="h-5 w-5 text-blue-600" />
                Retranscribe Meeting
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {error
              ? 'An error occurred while starting retranscription'
              : 'Re-process the audio with different settings. Transcription runs in the background so you can keep using the app.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {!error && (
            !isParakeetModel ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Language</span>
                </div>
                <Select value={selectedLang} onValueChange={setSelectedLang}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select language" />
                  </SelectTrigger>
                  <SelectContent className="max-h-60">
                    {LANGUAGES.map((lang) => (
                      <SelectItem key={lang.code} value={lang.code}>
                        {lang.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Select a specific language to improve accuracy, or use auto-detect
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Language</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Language selection isn&apos;t supported for Parakeet. It always uses automatic detection.
                </p>
              </div>
            )
          )}

          {!error && availableModels.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Model</span>
              </div>
              <Select value={selectedModelKey} onValueChange={setSelectedModelKey} disabled={loadingModels}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={loadingModels ? "Loading models..." : "Select model"} />
                </SelectTrigger>
                <SelectContent>
                  {availableModels.map((model) => (
                    <SelectItem key={`${model.provider}:${model.name}`} value={`${model.provider}:${model.name}`}>
                      {model.displayName} ({Math.round(model.size_mb)} MB)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Choose a transcription model
              </p>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          {error ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button
                onClick={() => {
                  setError(null);
                  setStarting(false);
                }}
                variant="outline"
              >
                Try Again
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleStartRetranscription}
                className="bg-blue-600 hover:bg-blue-700"
                disabled={!meetingFolderPath || starting}
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${starting ? 'animate-spin' : ''}`} />
                {starting ? 'Starting...' : 'Start Retranscription'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}