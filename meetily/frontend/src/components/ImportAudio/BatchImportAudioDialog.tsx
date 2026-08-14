'use client';

import React, { useEffect, useCallback, useRef } from 'react';
import {
  Upload,
  Loader2,
  CheckCircle2,
  X,
  XCircle,
  FileAudio,
  Clock,
  HardDrive,
  Plus,
  Play,
  Ban,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { toast } from 'sonner';
import { useBatchImportAudio } from '@/hooks/useBatchImportAudio';
import { useSidebar } from '../Sidebar/SidebarProvider';
import { useLocale } from '@/contexts/LocaleContext';

interface BatchImportAudioDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preselectedFiles?: string[];
  onComplete?: () => void;
}

const EMPTY_PRESELECTED_FILES: string[] = [];

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '--:--';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes: number): string {
  if (bytes <= 0) return '--';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function BatchImportAudioDialog({
  open,
  onOpenChange,
  preselectedFiles = EMPTY_PRESELECTED_FILES,
  onComplete,
}: BatchImportAudioDialogProps) {
  const { refetchMeetings } = useSidebar();
  const { locale } = useLocale();
  const wording = locale === 'zh-CN' ? {
    importing: '正在导入音频…', complete: '音频导入完成', title: '导入音频',
    processing: '正在处理…', result: (done: number, failed: number) => `成功 ${done} 个，失败 ${failed} 个`,
    description: '可以选择 1 个或多个音频文件；多个文件会自动排队。这里只保存原始音频和 metadata，不会自动转写。',
    meetingTitle: '会议标题', remove: '移除', validating: '校验中…', select: '选择音频文件', add: '继续添加文件',
    formats: '支持单选或多选', queue: (index: number, total: number, done: number, failed: number) => `队列 ${index}/${total} · 已完成 ${done} · 失败 ${failed}`,
    close: '关闭', start: (count: number) => `开始导入 (${count})`, cancel: '取消导入', done: '完成',
  } : {
    importing: 'Importing audio…', complete: 'Audio import complete', title: 'Import audio',
    processing: 'Processing…', result: (done: number, failed: number) => `${done} succeeded, ${failed} failed`,
    description: 'Select one or many audio files. Multiple files are queued. This preserves the original audio and metadata without automatic transcription.',
    meetingTitle: 'Meeting title', remove: 'Remove', validating: 'Validating…', select: 'Select audio files', add: 'Add more files',
    formats: 'Single or multi-select', queue: (index: number, total: number, done: number, failed: number) => `Queue ${index}/${total} · ${done} complete · ${failed} failed`,
    close: 'Close', start: (count: number) => `Import (${count})`, cancel: 'Cancel import', done: 'Done',
  };
  const prevOpenRef = useRef(false);
  const seededPathsRef = useRef('');

  const {
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
  } = useBatchImportAudio();

  const handleBatchComplete = useCallback(() => {
    refetchMeetings();
    onComplete?.();
  }, [refetchMeetings, onComplete]);

  // Reset only when dialog transitions from closed to open
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    const signature = preselectedFiles.join('\n');
    if (open && !wasOpen) {
      reset();
      seededPathsRef.current = signature;
      if (preselectedFiles.length > 0) {
        addFiles(preselectedFiles, (path) => {
          const basename = path.split(/[\\/]/).pop() || 'Imported Audio';
          return basename.replace(/\.[^.]+$/, '') || basename;
        });
      }
    } else if (open && signature && signature !== seededPathsRef.current) {
      seededPathsRef.current = signature;
      addFiles(preselectedFiles, (path) => {
        const basename = path.split(/[\\/]/).pop() || 'Imported Audio';
        return basename.replace(/\.[^.]+$/, '') || basename;
      });
    } else if (!open) {
      seededPathsRef.current = '';
    }
  }, [addFiles, open, preselectedFiles, reset]);

  // Refetch meetings when the batch finishes
  useEffect(() => {
    if (status === 'complete' && files.length > 0) {
      handleBatchComplete();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && isProcessing) return;
    onOpenChange(newOpen);
  };

  const handleEscapeKeyDown = (event: KeyboardEvent) => {
    if (isProcessing) event.preventDefault();
  };

  const handleInteractOutside = (event: Event) => {
    if (isProcessing) event.preventDefault();
  };

  const handleStart = async () => {
    const started = await startBatch();
    if (started) {
      toast.success(locale === 'zh-CN' ? `导入队列已开始，共 ${files.length} 个文件` : `Import queue started with ${files.length} files`);
    }
  };

  const handleCancel = async () => {
    if (isProcessing) {
      await cancelBatch();
      toast.info(locale === 'zh-CN' ? '导入队列已取消' : 'Import queue cancelled');
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[560px] max-h-[80vh] flex flex-col"
        onEscapeKeyDown={handleEscapeKeyDown}
        onInteractOutside={handleInteractOutside}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isProcessing ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                {wording.importing}
              </>
            ) : status === 'complete' ? (
              <>
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                {wording.complete}
              </>
            ) : (
              <>
                <Upload className="h-5 w-5 text-blue-600" />
                {wording.title}
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {isProcessing
              ? stageProgress?.message || wording.processing
              : status === 'complete'
              ? wording.result(completedCount, failedCount)
               : wording.description}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-1 space-y-3">
          {/* File list */}
          {files.length > 0 && (
            <div className="space-y-2">
              {files.map((file, index) => (
                <div
                  key={file.path}
                  className={`rounded-lg border p-3 ${
                    file.status === 'error'
                      ? 'border-red-200 bg-red-50'
                      : file.status === 'complete'
                      ? 'border-green-200 bg-green-50'
                      : file.status === 'preparing'
                      ? 'border-blue-200 bg-blue-50'
                      : 'border-gray-200 bg-gray-50'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {file.status === 'complete' ? (
                      <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
                    ) : file.status === 'error' ? (
                      <XCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
                    ) : file.status === 'preparing' ? (
                      <Loader2 className="h-5 w-5 animate-spin text-blue-600 flex-shrink-0 mt-0.5" />
                    ) : (
                      <FileAudio className="h-5 w-5 text-gray-500 flex-shrink-0 mt-0.5" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 truncate">{file.filename}</p>
                      <div className="flex items-center gap-4 text-xs text-gray-500 mt-0.5">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDuration(file.duration_seconds)}
                        </span>
                        <span className="flex items-center gap-1">
                          <HardDrive className="h-3 w-3" />
                          {formatFileSize(file.size_bytes)}
                        </span>
                        {file.format && <span className="text-blue-600 font-medium">{file.format}</span>}
                      </div>

                      {/* Editable title */}
                      {!isProcessing && file.status !== 'complete' && file.status !== 'error' && (
                        <div className="mt-2">
                          <Input
                            value={file.title}
                            onChange={(e) => updateTitle(file.path, e.target.value)}
                            placeholder={wording.meetingTitle}
                            className="h-8 text-sm"
                          />
                        </div>
                      )}

                      {file.status === 'preparing' && currentIndex === index && stageProgress && (
                        <div className="mt-2">
                          <div className="w-full bg-gray-200 rounded-full h-1.5">
                            <div
                              className="bg-blue-600 h-1.5 rounded-full transition-all duration-300"
                              style={{ width: `${Math.min(stageProgress.progress_percentage, 100)}%` }}
                            />
                          </div>
                          <p className="text-xs text-gray-500 mt-1">
                            {stageProgress.stage} · {Math.round(stageProgress.progress_percentage)}%
                          </p>
                        </div>
                      )}

                      {file.status === 'error' && file.error && (
                        <p className="text-xs text-red-700 mt-1 break-words">{file.error}</p>
                      )}
                    </div>

                    {!isProcessing && file.status !== 'complete' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 flex-shrink-0"
                        onClick={() => removeFile(file.path)}
                        title={wording.remove}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add more files */}
          {!isProcessing && status !== 'complete' && files.length > 0 && (
            <Button variant="outline" onClick={selectFiles} className="w-full border-dashed" disabled={status === 'selecting'}>
              {status === 'selecting' ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {wording.validating}
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4 mr-2" />
                  {wording.add}
                </>
              )}
            </Button>
          )}

          {/* Empty state */}
          {files.length === 0 && !isProcessing && status !== 'complete' && (
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
              <FileAudio className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <Button onClick={selectFiles} disabled={status === 'selecting'}>
                {status === 'selecting' ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    {wording.validating}
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4 mr-2" />
                    {wording.select}
                  </>
                )}
              </Button>
              <p className="text-sm text-gray-500 mt-2">{wording.formats} · MP4, M4A, WAV, MP3, FLAC, OGG, MKV, WebM, WMA</p>
            </div>
          )}

          {/* Progress summary while processing */}
          {isProcessing && files.length > 0 && (
            <p className="text-xs text-gray-500 text-center">
              {wording.queue(currentIndex + 1, files.length, completedCount, failedCount)}
            </p>
          )}
        </div>

        <DialogFooter className="pt-3">
          {!isProcessing && status !== 'complete' && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {wording.close}
              </Button>
              <Button
                onClick={handleStart}
                className="bg-blue-600 hover:bg-blue-700"
                disabled={files.length === 0 || files.some((f) => f.status !== 'queued')}
              >
                <Play className="h-4 w-4 mr-2" />
                {wording.start(files.length)}
              </Button>
            </>
          )}
          {isProcessing && (
            <Button variant="outline" onClick={handleCancel} disabled={isCancelling}>
              <Ban className="h-4 w-4 mr-2" />
              {wording.cancel}
            </Button>
          )}
          {status === 'complete' && (
            <Button onClick={() => onOpenChange(false)} className="bg-blue-600 hover:bg-blue-700">
              {wording.done}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
