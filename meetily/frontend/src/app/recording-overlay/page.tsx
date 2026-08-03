'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, Window } from '@tauri-apps/api/window';
import { Mic2, Pause, Play, Radio, SquareArrowOutUpRight } from 'lucide-react';
import type { RecordingState } from '@/services/recordingService';

function formatDuration(seconds: number | null): string {
  const total = Math.max(0, Math.floor(seconds ?? 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    : `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export default function RecordingOverlayPage() {
  const [state, setState] = useState<RecordingState | null>(null);
  const [ended, setEnded] = useState(false);
  const wasRecording = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sync = useCallback(async () => {
    try {
      const next = await invoke<RecordingState>('get_recording_state');
      if (next.is_recording) {
        wasRecording.current = true;
        setEnded(false);
      } else if (wasRecording.current) {
        wasRecording.current = false;
        setEnded(true);
        hideTimer.current = setTimeout(() => {
          getCurrentWindow().hide().catch(() => undefined);
        }, 4500);
      }
      setState(next);
    } catch (error) {
      console.warn('[Recording overlay] State sync failed:', error);
    }
  }, []);

  useEffect(() => {
    sync();
    const timer = setInterval(sync, 500);
    return () => {
      clearInterval(timer);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [sync]);

  const togglePause = async () => {
    await invoke(state?.is_paused ? 'resume_recording' : 'pause_recording');
    await sync();
  };

  const openMainWindow = async () => {
    const main = await Window.getByLabel('main');
    await main?.show();
    await main?.unminimize();
    await main?.setFocus();
  };

  const isPaused = !!state?.is_paused;
  return (
    <main className="h-screen w-screen select-none overflow-hidden bg-transparent p-2">
      <section
        data-tauri-drag-region
        className={`flex h-full items-center gap-3 rounded-[18px] border px-4 shadow-2xl backdrop-blur-2xl ${
          ended
            ? 'border-slate-200/80 bg-white/95'
            : isPaused
              ? 'border-amber-200/80 bg-amber-50/95'
              : 'border-rose-200/80 bg-white/95'
        }`}
      >
        <div className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${ended ? 'bg-slate-100 text-slate-500' : isPaused ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-600'}`}>
          {!ended && !isPaused && <span className="absolute inset-0 animate-ping rounded-full bg-rose-300/35" />}
          {ended ? <Mic2 size={18} /> : <Radio className="relative" size={18} />}
        </div>

        <div data-tauri-drag-region className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-slate-900">
            {ended ? '录音已停止' : isPaused ? '录音已暂停' : '正在录音'}
          </p>
          <p className="mt-0.5 font-mono text-[12px] tabular-nums text-slate-500">
            {ended ? '正在保存会议内容…' : formatDuration(state?.recording_duration ?? null)}
          </p>
        </div>

        {!ended && (
          <button
            onClick={togglePause}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50"
            aria-label={isPaused ? '继续录音' : '暂停录音'}
          >
            {isPaused ? <Play size={14} fill="currentColor" /> : <Pause size={14} fill="currentColor" />}
          </button>
        )}
        <button
          onClick={openMainWindow}
          className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          aria-label="打开 Snack Meet"
        >
          <SquareArrowOutUpRight size={14} />
        </button>
      </section>
    </main>
  );
}
