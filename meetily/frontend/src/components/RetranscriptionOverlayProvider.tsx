'use client';

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { Loader2, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { toast } from 'sonner';
import Analytics from '@/lib/analytics';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';

interface RetranscriptionProgress {
  meeting_id: string;
  stage: string;
  progress_percentage: number;
  message: string;
}

interface RetranscriptionResult {
  meeting_id: string;
  segments_count: number;
  duration_seconds: number;
  language: string | null;
}

interface RetranscriptionError {
  meeting_id: string;
  error: string;
}

type Status = 'running' | 'complete' | 'error';

interface Job {
  meetingId: string;
  stage: string;
  progress: number;
  message: string;
}

// DOM event dispatched on completion so the meeting-details view can refetch
// transcripts for the meeting that was retranscribed.
export const RETRANSCRIPTION_COMPLETE_EVENT = 'snackmeet:retranscription-complete';

const AUTO_HIDE_MS = 4500;

export function RetranscriptionOverlayProvider() {
  const { refetchMeetings } = useSidebar();
  const [job, setJob] = useState<Job | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetchMeetingsRef = useRef(refetchMeetings);
  useEffect(() => { refetchMeetingsRef.current = refetchMeetings; }, [refetchMeetings]);

  const clearHide = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  const reset = () => {
    clearHide();
    setJob(null);
    setStatus(null);
    setErrorMsg(null);
  };

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    const setup = async () => {
      const uProgress = await listen<RetranscriptionProgress>('retranscription-progress', (event) => {
        const p = event.payload;
        clearHide();
        setJob({
          meetingId: p.meeting_id,
          stage: p.stage,
          progress: p.progress_percentage,
          message: p.message,
        });
        setStatus('running');
        setErrorMsg(null);
      });
      if (cancelled) { uProgress(); return; }
      unlisteners.push(uProgress);

      const uComplete = await listen<RetranscriptionResult>('retranscription-complete', async (event) => {
        const r = event.payload;
        await Analytics.track('enhance_transcript_completed', {
          success: 'true',
          duration_seconds: r.duration_seconds.toString(),
          segments_count: r.segments_count.toString(),
        });
        setJob({
          meetingId: r.meeting_id,
          stage: 'complete',
          progress: 100,
          message: `完成 · ${r.segments_count} 段`,
        });
        setStatus('complete');
        setErrorMsg(null);
        toast.success(`重新转译完成 · ${r.segments_count} 段`);
        // Refresh sidebar list (transcript counts) + notify the meeting view.
        refetchMeetingsRef.current?.();
        window.dispatchEvent(
          new CustomEvent(RETRANSCRIPTION_COMPLETE_EVENT, { detail: { meetingId: r.meeting_id } })
        );
        clearHide();
        hideTimer.current = setTimeout(reset, AUTO_HIDE_MS);
      });
      if (cancelled) { uComplete(); return; }
      unlisteners.push(uComplete);

      const uError = await listen<RetranscriptionError>('retranscription-error', async (event) => {
        const r = event.payload;
        await Analytics.trackError('enhance_transcript_failed', r.error);
        setStatus('error');
        setErrorMsg(r.error);
        toast.error('重新转译失败');
      });
      if (cancelled) { uError(); return; }
      unlisteners.push(uError);
    };

    setup();
    return () => {
      cancelled = true;
      clearHide();
      unlisteners.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCancel = async () => {
    try {
      await invoke('cancel_retranscription_command');
      toast.info('已取消重新转译');
    } catch (err) {
      console.error('Failed to cancel retranscription:', err);
    }
    reset();
  };

  // Nothing to show.
  if (!job && !errorMsg) return null;

  const running = status === 'running';
  const complete = status === 'complete';
  const errored = !!errorMsg;

  const border = errored
    ? 'border-red-200/80'
    : complete
      ? 'border-emerald-200/80'
      : 'border-blue-200/80';
  const barColor = errored
    ? 'bg-red-500'
    : complete
      ? 'bg-emerald-500'
      : 'bg-blue-600';
  const iconBg = errored
    ? 'bg-red-100 text-red-600'
    : complete
      ? 'bg-emerald-100 text-emerald-600'
      : 'bg-blue-100 text-blue-600';
  const title = errored
    ? '重新转译失败'
    : complete
      ? '重新转译完成'
      : '正在后台重新转译';

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50">
      <div
        className={`pointer-events-auto w-72 rounded-2xl border ${border} bg-white/95 p-3 shadow-2xl backdrop-blur-2xl`}
      >
        <div className="flex items-center gap-2">
          <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${iconBg}`}>
            {running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : errored ? (
              <AlertCircle className="h-4 w-4" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
          </div>
          <p className="flex-1 truncate text-[13px] font-semibold text-slate-900">{title}</p>
          <span className="font-mono text-xs tabular-nums text-slate-500">
            {errored ? '' : `${Math.round(job?.progress ?? 0)}%`}
          </span>
          <button
            onClick={errored ? reset : handleCancel}
            className="flex h-6 w-6 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            aria-label={errored ? '关闭' : '取消转译'}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {!errored && (
          <div className="relative mt-2">
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className={`h-2 rounded-full transition-all duration-300 ease-out ${barColor}`}
                style={{ width: `${Math.min(job?.progress ?? 0, 100)}%` }}
              />
            </div>
          </div>
        )}

        <p className="mt-2 truncate text-xs text-slate-500">
          {errored ? errorMsg : job?.message || (running ? '处理中…' : '')}
        </p>

        {!errored && !complete && running && (
          <button
            onClick={handleCancel}
            className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
          >
            取消
          </button>
        )}
      </div>
    </div>
  );
}