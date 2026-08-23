"use client";
import { useState, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Bot, Send, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';

interface CopilotMessage {
  role: 'user' | 'assistant';
  content: string;
}

type CopilotScope = 'meeting' | 'collection' | 'all';

export function CopilotChat({ meetingId }: { meetingId?: string }) {
  const { meetings, collections, libraryView } = useSidebar();
  const meeting = meetingId ? meetings.find((item) => item.id === meetingId) : undefined;
  const defaultCollectionId = meeting?.collectionId || (libraryView.kind === 'collection' ? libraryView.collectionId : null);
  const [scope, setScope] = useState<CopilotScope>(meetingId ? 'meeting' : defaultCollectionId ? 'collection' : 'all');
  const [collectionId, setCollectionId] = useState<string | null>(defaultCollectionId);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, loading, open]);

  useEffect(() => {
    setMessages([]);
  }, [scope, collectionId]);

  useEffect(() => {
    if (!meetingId && libraryView.kind === 'collection') {
      setCollectionId(libraryView.collectionId);
      setScope('collection');
    } else if (!meetingId && libraryView.kind !== 'collection') {
      setScope('all');
    }
  }, [libraryView, meetingId]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    const history: CopilotMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(history);
    setInput('');
    setLoading(true);
    try {
      const reply = await invoke<string>('api_copilot_chat', {
        meetingId: scope === 'meeting' ? meetingId : null,
        collectionId: scope === 'collection' ? collectionId : null,
        scope,
        messages: history,
      });
      setMessages([...history, { role: 'assistant', content: reply }]);
    } catch (error) {
      console.error('AI 问答失败:', error);
      toast.error(String(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 px-4 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full shadow-lg shadow-indigo-600/25 transition-colors"
        title="AI 问答"
        aria-label="打开 AI 问答"
      >
        <Bot className="w-5 h-5" />
        <span className="text-sm font-medium">AI 问答</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/20"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-[400px] h-full bg-white shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 shrink-0">
              <Bot className="w-5 h-5 text-indigo-600" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-800">AI 会议问答</div>
                <div className="truncate text-xs text-gray-400">
                  {scope === 'meeting' ? '仅依据当前会议' : scope === 'collection' ? '基于当前文件夹' : '基于全部未归档会议'}
                </div>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="ml-auto p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md"
                aria-label="关闭"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="border-b border-gray-100 bg-gray-50/80 px-4 py-2.5">
              <div className="flex gap-2">
                {meetingId && (
                  <button
                    onClick={() => setScope('meeting')}
                    className={`rounded-full px-3 py-1 text-xs ${scope === 'meeting' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 ring-1 ring-gray-200'}`}
                  >
                    当前会议
                  </button>
                )}
                {collections.length > 0 && (
                  <button
                    onClick={() => {
                      setCollectionId((current) => current || defaultCollectionId || collections[0].id);
                      setScope('collection');
                    }}
                    className={`rounded-full px-3 py-1 text-xs ${scope === 'collection' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 ring-1 ring-gray-200'}`}
                  >
                    文件夹
                  </button>
                )}
                <button
                  onClick={() => setScope('all')}
                  className={`rounded-full px-3 py-1 text-xs ${scope === 'all' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 ring-1 ring-gray-200'}`}
                >
                  全部会议
                </button>
              </div>
              {scope === 'collection' && (
                <select
                  value={collectionId || ''}
                  onChange={(event) => setCollectionId(event.target.value)}
                  className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {collections.map((collection) => (
                    <option key={collection.id} value={collection.id}>{collection.name} ({collection.meetingCount})</option>
                  ))}
                </select>
              )}
              {scope !== 'meeting' && (
                <p className="mt-2 text-[11px] leading-4 text-gray-400">
                  会先在本机检索问题相关的最多 8 条会议，再交给本地 AI 综合回答。
                </p>
              )}
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {messages.length === 0 && !loading && (
                <div className="text-center text-sm text-gray-400 mt-8">
                  {scope === 'meeting' ? '基于本会议的转写稿和 AI 总结，' : '可以跨会议询问主题、决策和行动项，'}
                  <br />
                  可以提问会议内容、行动项、结论等。
                </div>
              )}
              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={`max-w-[85%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap break-words ${
                    msg.role === 'user'
                      ? 'ml-auto bg-indigo-600 text-white rounded-br-none'
                      : 'mr-auto bg-gray-100 text-gray-800 rounded-bl-none'
                  }`}
                >
                  {msg.content}
                </div>
              ))}
              {loading && (
                <div className="mr-auto bg-gray-100 text-gray-500 rounded-lg px-3 py-2 text-sm inline-flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  正在思考…
                </div>
              )}
            </div>

            <div className="border-t border-gray-200 p-3 flex items-center gap-2 shrink-0">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="输入问题，Enter 发送，Shift+Enter 换行"
                rows={1}
                className="flex-1 resize-none text-sm px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button
                onClick={send}
                disabled={loading || !input.trim()}
                className="p-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-lg transition-colors"
                aria-label="发送"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
