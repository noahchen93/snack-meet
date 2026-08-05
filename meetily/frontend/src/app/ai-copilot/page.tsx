'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Bot, Send, X, Trash2, Cloud, Sparkles } from 'lucide-react';

interface TranscriptUpdate {
  text: string;
  is_partial: boolean;
  speaker?: string;
}

interface CopilotMessage {
  role: 'reminder' | 'answer';
  text: string;
  time: string;
}

interface CopilotCloudConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
}

const REMINDER_INTERVAL_MS = 45_000; // ask for a reminder ~every 45s while recording
const MAX_CONTEXT_SEGMENTS = 120;

function nowTime(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

export default function AICopilotPage() {
  const [transcript, setTranscript] = useState('');
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const transcriptRef = useRef('');
  const messagesRef = useRef<CopilotMessage[]>([]);
  const busyRef = useRef(false);
  const lastReminderRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const pushMessage = useCallback((m: CopilotMessage) => {
    messagesRef.current = [...messagesRef.current, m].slice(-100);
    setMessages(messagesRef.current);
  }, []);

  const ask = useCallback(
    async (questionText: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const res = await invoke<{ answer: string; is_reminder: boolean }>('copilot_ask', {
          request: { context: transcriptRef.current, question: questionText },
        });
        if (questionText.trim()) {
          pushMessage({ role: 'answer', text: questionText, time: nowTime() });
        }
        pushMessage({ role: 'reminder', text: res.answer, time: nowTime() });
      } catch (e) {
        pushMessage({
          role: 'reminder',
          text: `⚠️ ${e instanceof Error ? e.message : String(e)}`,
          time: nowTime(),
        });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [pushMessage]
  );

  // Keep transcript up to date from the recording overlay's events.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    const setup = async () => {
      unlisten = await listen<TranscriptUpdate>('transcript-update', (event) => {
        const u = event.payload;
        if (u.is_partial) return; // only final segments
        const speakerLabel =
          u.speaker === 'local' ? '你' : u.speaker === 'remote' ? '对方' : null;
        const line = speakerLabel ? `[${speakerLabel}] ${u.text}` : u.text;
        const segments = transcriptRef.current.split('\n').filter((s) => s.trim());
        segments.push(line);
        transcriptRef.current = segments.slice(-MAX_CONTEXT_SEGMENTS).join('\n');
        setTranscript(transcriptRef.current);
      });
    };
    setup();
    return () => {
      unlisten?.();
    };
  }, []);

  // Poll recording state to know when to auto-remind.
  useEffect(() => {
    const tick = async () => {
      try {
        const s = await invoke<{ is_recording: boolean }>('get_recording_state');
        setRecording(!!s.is_recording);
      } catch {
        /* ignore */
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, []);

  // Automatic reminders while recording.
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      const now = Date.now();
      if (now - lastReminderRef.current < REMINDER_INTERVAL_MS) return;
      if (busyRef.current) return;
      lastReminderRef.current = now;
      ask('');
    }, REMINDER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [recording, ask]);

  // Auto-scroll to the newest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const q = question.trim();
    if (!q || busy) return;
    setQuestion('');
    await ask(q);
  };

  return (
    <main className="h-screen w-screen select-none overflow-hidden bg-transparent p-2">
      <section className="flex h-full flex-col rounded-[18px] border border-slate-200 bg-white/95 shadow-2xl backdrop-blur-2xl">
        {/* Header */}
        <header data-tauri-drag-region className="flex items-center justify-between px-3 py-2 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
              <Bot size={15} />
            </span>
            <div>
              <p className="text-[13px] font-semibold text-slate-900 leading-tight">AI 会议副驾</p>
              <p className="text-[10px] text-slate-400 leading-tight">
                {recording ? '● 录音中 · 自动提醒' : '○ 未在录音'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowSettings((v) => !v)}
              className="flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              aria-label="设置"
            >
              <Cloud size={14} />
            </button>
            <button
              onClick={() => getCurrentWindow().hide().catch(() => undefined)}
              className="flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              aria-label="关闭"
            >
              <X size={14} />
            </button>
          </div>
        </header>

        {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
          {messages.length === 0 && (
            <div className="flex h-full items-center justify-center text-center px-4">
              <div>
                <Sparkles className="mx-auto mb-2 text-indigo-300" size={28} />
                <p className="text-[12px] text-slate-400 leading-relaxed">
                  录音时 AI 会基于会议内容自动提醒。<br />
                  你也可以在下方输入框随时提问。
                </p>
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              className={`rounded-xl px-3 py-2 text-[13px] leading-relaxed ${
                m.role === 'answer'
                  ? 'ml-8 bg-indigo-50 text-slate-700'
                  : m.text.startsWith('⚠️')
                    ? 'mr-1 bg-rose-50 text-rose-700'
                    : 'mr-1 bg-slate-50 text-slate-700'
              }`}
            >
              {m.role === 'answer' && (
                <p className="mb-1 text-[10px] font-semibold text-indigo-500">
                  我问 · {m.time}
                </p>
              )}
              <p className="whitespace-pre-wrap">{m.text}</p>
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-slate-400">
              <span className="animate-pulse">思考中…</span>
            </div>
          )}
        </div>

        {/* Input */}
        <footer className="border-t border-slate-100 p-2">
          <div className="flex items-center gap-2">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && handleSend()}
              placeholder="问 AI：例如「刚才提到的截止日期是什么？」"
              className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-indigo-300"
            />
            <button
              onClick={handleSend}
              disabled={busy || !question.trim()}
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 text-white transition hover:bg-indigo-500 disabled:opacity-40"
              aria-label="发送"
            >
              <Send size={15} />
            </button>
          </div>
        </footer>
      </section>
    </main>
  );
}

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [doc, setDoc] = useState('');
  const [cloud, setCloud] = useState<CopilotCloudConfig>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    invoke<string>('copilot_get_context_document')
      .then((d) => setDoc(d ?? ''))
      .catch(() => undefined);
    invoke<CopilotCloudConfig>('copilot_get_cloud_config')
      .then((c) => setCloud(c ?? {}))
      .catch(() => undefined);
  }, []);

  const saveAll = async () => {
    setSaving(true);
    try {
      await invoke('copilot_save_context_document', { content: doc });
      await invoke('copilot_save_cloud_config', { config: cloud });
      onClose();
    } catch (e) {
      console.error('Failed to save copilot settings:', e);
    } finally {
      setSaving(false);
    }
  };

  const clearDoc = async () => {
    setDoc('');
  };

  return (
    <div className="border-b border-slate-100 bg-slate-50/80 px-3 py-3 space-y-3">
      <p className="text-[11px] font-semibold text-slate-500">AI 副驾设置</p>

      <div>
        <div className="flex items-center justify-between">
          <label className="text-[11px] text-slate-500">语境 / 背景资料</label>
          <button
            onClick={clearDoc}
            className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-rose-500"
          >
            <Trash2 size={11} /> 清空
          </button>
        </div>
        <textarea
          value={doc}
          onChange={(e) => setDoc(e.target.value)}
          rows={3}
          placeholder="粘贴你的背景、目标、项目资料等，AI 回答时会结合这些语境。"
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[12px] text-slate-700 outline-none placeholder:text-slate-400 focus:border-indigo-300"
        />
      </div>

      <div>
        <label className="text-[11px] text-slate-500">云端模型（可选，更快）</label>
        <input
          value={cloud.endpoint ?? ''}
          onChange={(e) => setCloud((c) => ({ ...c, endpoint: e.target.value }))}
          placeholder="API 地址，如 https://api.openai.com/v1"
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[12px] text-slate-700 outline-none placeholder:text-slate-400 focus:border-indigo-300"
        />
        <input
          value={cloud.model ?? ''}
          onChange={(e) => setCloud((c) => ({ ...c, model: e.target.value }))}
          placeholder="模型名，如 gpt-4o-mini"
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[12px] text-slate-700 outline-none placeholder:text-slate-400 focus:border-indigo-300"
        />
        <input
          value={cloud.apiKey ?? ''}
          onChange={(e) => setCloud((c) => ({ ...c, apiKey: e.target.value }))}
          placeholder="API Key（留空则用设置里的 LLM）"
          type="password"
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[12px] text-slate-700 outline-none placeholder:text-slate-400 focus:border-indigo-300"
        />
        <p className="mt-1 text-[10px] text-slate-400">
          配置云端模型后优先使用；留空则复用「设置 → LLM」的配置。
        </p>
      </div>

      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="px-3 py-1.5 rounded-lg text-[12px] text-slate-500 hover:bg-slate-100"
        >
          取消
        </button>
        <button
          onClick={saveAll}
          disabled={saving}
          className="px-3 py-1.5 rounded-lg bg-indigo-600 text-[12px] text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}
