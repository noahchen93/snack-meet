import { useState, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { useLocale } from '@/contexts/LocaleContext';

export interface BatchAudioFileInfo {
  path: string;
  filename: string;
  duration_seconds: number;
  size_bytes: number;
  format: string;
}

export interface BatchFileItem {
  path: string;
  filename: string;
  duration_seconds: number;
  size_bytes: number;
  format: string;
  title: string;
  status: 'queued' | 'preparing' | 'complete' | 'error';
  error?: string;
  meeting_id?: string;
  folder_path?: string;
}

export interface BatchImportProgress {
  index: number;
  total: number;
  filename: string;
}

export interface BatchImportFileResult {
  index: number;
  total: number;
  filename: string;
  meeting_id: string;
  title: string;
  folder_path: string;
}

export interface BatchImportError {
  index: number;
  total: number;
  filename: string;
  error: string;
}

export interface BatchImportComplete {
  total: number;
  imported: number;
  failed: number;
}

export interface ImportStageProgress {
  stage: string;
  progress_percentage: number;
  message: string;
}

export type BatchStatus = 'idle' | 'selecting' | 'processing' | 'complete';

export function useBatchImportAudio() {
  const { locale } = useLocale();
  const isChinese = locale === 'zh-CN';
  const [files, setFiles] = useState<BatchFileItem[]>([]);
  const [status, setStatus] = useState<BatchStatus>('idle');
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [stageProgress, setStageProgress] = useState<ImportStageProgress | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  const isProcessing = status === 'processing';
  const completedCount = files.filter((f) => f.status === 'complete').length;
  const failedCount = files.filter((f) => f.status === 'error').length;

  // Event listeners (registered once)
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    const cleanedUpRef = { current: false };

    const setupListeners = async () => {
      const unlistenProgress = await listen<BatchImportProgress>(
        'batch-import-progress',
        (event) => {
          const p = event.payload;
          setCurrentIndex(p.index);
          setFiles((prev) =>
            prev.map((f, i) => (i === p.index ? { ...f, status: 'preparing' } : f))
          );
          setStageProgress(null);
        }
      );
      if (cleanedUpRef.current) { unlistenProgress(); return; }
      unlisteners.push(unlistenProgress);

      const unlistenFileComplete = await listen<BatchImportFileResult>(
        'batch-import-file-complete',
        (event) => {
          const p = event.payload;
          setFiles((prev) =>
            prev.map((f, i) =>
              i === p.index
                ? { ...f, status: 'complete', meeting_id: p.meeting_id, folder_path: p.folder_path }
                : f
            )
          );
          setStageProgress(null);
        }
      );
      if (cleanedUpRef.current) { unlistenFileComplete(); return; }
      unlisteners.push(unlistenFileComplete);

      const unlistenError = await listen<BatchImportError>(
        'batch-import-error',
        (event) => {
          const p = event.payload;
          setFiles((prev) =>
            prev.map((f, i) => (i === p.index ? { ...f, status: 'error', error: p.error } : f))
          );
          setStageProgress(null);
        }
      );
      if (cleanedUpRef.current) { unlistenError(); return; }
      unlisteners.push(unlistenError);

      const unlistenComplete = await listen<BatchImportComplete>(
        'batch-import-complete',
        (event) => {
          setStatus('complete');
          setCurrentIndex(-1);
          setStageProgress(null);
          const { imported, failed } = event.payload;
          toast.success(isChinese
            ? `音频导入完成：成功 ${imported} 个，失败 ${failed} 个`
            : `Audio import complete: ${imported} succeeded, ${failed} failed`);
        }
      );
      if (cleanedUpRef.current) { unlistenComplete(); return; }
      unlisteners.push(unlistenComplete);

      // Per-file stage progress for the currently-processing file
      const unlistenStage = await listen<ImportStageProgress>(
        'import-progress',
        (event) => {
          setStageProgress(event.payload);
        }
      );
      if (cleanedUpRef.current) { unlistenStage(); return; }
      unlisteners.push(unlistenStage);
    };

    setupListeners();

    return () => {
      cleanedUpRef.current = true;
      unlisteners.forEach((u) => u());
    };
  }, [isChinese]);

  const selectFiles = useCallback(async (): Promise<boolean> => {
    setStatus('selecting');
    try {
      const infos = await invoke<BatchAudioFileInfo[]>('select_and_validate_audio_files_command');
      setStatus('idle');
      if (infos.length === 0) return false;
      setFiles((prev) => {
        const existing = new Set(prev.map((f) => f.path));
        const newItems: BatchFileItem[] = infos
          .filter((i) => !existing.has(i.path))
          .map((i) => ({
            path: i.path,
            filename: i.filename,
            duration_seconds: i.duration_seconds,
            size_bytes: i.size_bytes,
            format: i.format,
            title: i.filename,
            status: 'queued',
          }));
        // When selecting a fresh batch (nothing queued yet), replace; otherwise append.
        return prev.length === 0 ? newItems : [...prev, ...newItems];
      });
      return true;
    } catch (err: any) {
      setStatus('idle');
      const msg = typeof err === 'string' ? err : (err?.message || String(err));
      toast.error(isChinese ? '选择音频文件失败' : 'Failed to select audio files', { description: msg });
      return false;
    }
  }, [isChinese]);

  const addFiles = useCallback((paths: string[], filenameOf: (p: string) => string) => {
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.path));
      const newItems: BatchFileItem[] = paths
        .filter((p) => !existing.has(p))
        .map((p) => ({
          path: p,
          filename: filenameOf(p),
          duration_seconds: 0,
          size_bytes: 0,
          format: '',
          title: filenameOf(p),
          status: 'queued',
        }));
      return [...prev, ...newItems];
    });
  }, []);

  const updateTitle = useCallback((path: string, title: string) => {
    setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, title } : f)));
  }, []);

  const removeFile = useCallback((path: string) => {
    setFiles((prev) => prev.filter((f) => f.path !== path));
  }, []);

  const startBatch = useCallback(async (): Promise<boolean> => {
    const pending = files.filter((f) => f.status === 'queued');
    if (pending.length === 0) {
      toast.error(isChinese ? '没有待导入的文件' : 'No files are waiting to be imported');
      return false;
    }
    if (pending.length !== files.length) {
      toast.error(isChinese
        ? '请先移除已完成或失败的文件，再开始新的导入队列'
        : 'Remove completed or failed files before starting a new import queue');
      return false;
    }

    setStatus('processing');
    setCurrentIndex(0);
    try {
      await invoke('start_batch_import_command', {
        files: pending.map((f) => ({ path: f.path, title: f.title || f.filename })),
      });
      return true;
    } catch (err: any) {
      setStatus('idle');
      const msg = typeof err === 'string' ? err : (err?.message || String(err));
      toast.error(isChinese ? '导入队列启动失败' : 'Failed to start the import queue', { description: msg });
      return false;
    }
  }, [files, isChinese]);

  const cancelBatch = useCallback(async () => {
    setIsCancelling(true);
    try {
      await invoke('cancel_import_command');
      setStatus('idle');
      setCurrentIndex(-1);
      setStageProgress(null);
    } catch (err: any) {
      console.error('Failed to cancel batch import:', err);
    } finally {
      setIsCancelling(false);
    }
  }, []);

  const reset = useCallback(() => {
    setFiles([]);
    setStatus('idle');
    setCurrentIndex(-1);
    setStageProgress(null);
    setIsCancelling(false);
  }, []);

  return {
    files,
    status,
    currentIndex,
    stageProgress,
    isProcessing,
    isCancelling,
    completedCount,
    failedCount,
    selectFiles,
    addFiles,
    updateTitle,
    removeFile,
    startBatch,
    cancelBatch,
    reset,
  };
}
