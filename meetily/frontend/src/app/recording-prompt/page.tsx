'use client';

import { useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { BellRing, Mic2, X } from 'lucide-react';

interface RecordingPromptRequest {
  request_id: string;
  app_name: string;
  bundle_id: string;
  window_title: string;
  trigger: 'microphone' | 'meeting';
}

export default function RecordingPromptPage() {
  const [request, setRequest] = useState<RecordingPromptRequest | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<RecordingPromptRequest>('recording-prompt-request', (event) => {
      setRequest(event.payload);
      invoke('recording_prompt_ensure_frontmost').catch(() => undefined);
    }).then((dispose) => {
      unlisten = dispose;
    }).catch((error) => {
      console.warn('[Recording prompt] Listener setup failed:', error);
    });

    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!request) return;
    const frontmostTimer = setInterval(() => {
      invoke('recording_prompt_ensure_frontmost').catch(() => undefined);
    }, 1000);
    return () => clearInterval(frontmostTimer);
  }, [request]);

  const answer = async (accepted: boolean) => {
    if (!request) return;
    await emit('recording-prompt-response', {
      request_id: request.request_id,
      accepted,
    });
    setRequest(null);
    await getCurrentWindow().hide();
  };

  return (
    <main className="h-screen w-screen select-none overflow-hidden bg-transparent p-3">
      <section
        data-tauri-drag-region
        className="relative flex h-full flex-col rounded-[24px] border border-slate-200/90 bg-white/97 p-6 shadow-2xl backdrop-blur-2xl"
      >
        <button
          type="button"
          onClick={() => answer(false)}
          className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          aria-label="不录音"
        >
          <X size={17} />
        </button>

        <div data-tauri-drag-region className="flex items-start gap-4 pr-8">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-rose-50 text-rose-600">
            <BellRing size={23} />
          </div>
          <div data-tauri-drag-region className="min-w-0 pt-0.5">
            <h1 className="text-[17px] font-semibold text-slate-950">检测到语音活动</h1>
            <p className="mt-1 truncate text-[14px] font-medium text-slate-700">
              {request?.app_name ?? '会议应用'}
            </p>
            <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-slate-500">
              {request?.trigger === 'microphone'
                ? '该应用正在使用麦克风，是否开始录音？'
                : request?.window_title
                  ? `检测到会议窗口：${request.window_title}`
                  : '检测到会议窗口，是否开始录音？'}
            </p>
          </div>
        </div>

        <div className="mt-auto flex gap-3">
          <button
            type="button"
            onClick={() => answer(false)}
            disabled={!request}
            className="h-11 flex-1 rounded-xl border border-slate-200 bg-white text-[14px] font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            暂不录音
          </button>
          <button
            type="button"
            onClick={() => answer(true)}
            disabled={!request}
            className="flex h-11 flex-[1.35] items-center justify-center gap-2 rounded-xl bg-rose-600 text-[14px] font-semibold text-white shadow-lg shadow-rose-200 transition hover:bg-rose-700 disabled:opacity-50"
          >
            <Mic2 size={17} />
            开始录音
          </button>
        </div>
      </section>
    </main>
  );
}
