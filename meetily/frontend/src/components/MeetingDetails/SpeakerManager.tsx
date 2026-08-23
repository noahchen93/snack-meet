'use client';

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Users, Sparkles, Pencil, Check, X, RefreshCw, Loader2, ChevronDown, ChevronUp } from 'lucide-react';

interface DistinctSpeaker {
  speaker: string;
  count: number;
  sample_text: string;
}

interface SuggestedSpeakerName {
  speaker: string;
  suggested_name: string;
  reason: string;
}

interface SpeakerManagerProps {
  meetingId: string;
  /** Increment to force a reload (e.g. after a segment was reassigned). */
  refreshTrigger?: number;
  /** Called whenever the set of speaker names changes. */
  onSpeakersChange?: (speakers: string[]) => void;
  /** Called when the per-segment edit mode toggles. */
  onEditingChange?: (editing: boolean) => void;
}

export function SpeakerManager({ meetingId, refreshTrigger = 0, onSpeakersChange, onEditingChange }: SpeakerManagerProps) {
  const [speakers, setSpeakers] = useState<DistinctSpeaker[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestedSpeakerName[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    // Speaker tools can grow tall, so every meeting opens with transcript space
    // prioritised. The one-line header remains available for quick expansion.
    setCollapsed(true);
  }, [meetingId]);

  const loadSpeakers = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invoke<DistinctSpeaker[]>('api_get_distinct_speakers', { meetingId });
      setSpeakers(list);
      onSpeakersChange?.(list.map((s) => s.speaker));
    } catch (error) {
      console.error('Failed to load speakers:', error);
      toast.error('加载说话人失败', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, [meetingId, onSpeakersChange]);

  useEffect(() => {
    loadSpeakers();
  }, [loadSpeakers, refreshTrigger]);

  const toggleEditing = (next: boolean) => {
    setEditing(next);
    onEditingChange?.(next);
  };

  const handleSuggest = async () => {
    if (suggesting) return;
    setSuggesting(true);
    try {
      const result = await invoke<SuggestedSpeakerName[]>('api_suggest_speaker_names', { meetingId });
      setSuggestions(result);
      setSuggestionsOpen(true);
      if (result.length === 0) {
        toast.info('AI 未给出可用的说话人命名建议');
      }
    } catch (error) {
      console.error('Failed to suggest speaker names:', error);
      toast.error('AI 说话人命名失败', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setSuggesting(false);
    }
  };

  const applyRename = async (from: string, to: string) => {
    if (!to.trim()) {
      toast.warning('说话人名称不能为空');
      return;
    }
    setRenaming(from);
    try {
      const affected = await invoke<number>('api_rename_speaker', { meetingId, fromSpeaker: from, toSpeaker: to });
      toast.success(`已将「${from}」重命名为「${to}」（${affected} 段）`);
      setRenameDraft((d) => ({ ...d, [from]: '' }));
      await loadSpeakers();
    } catch (error) {
      toast.error('重命名失败', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setRenaming(null);
    }
  };

  const applySuggestion = async (suggestion: SuggestedSpeakerName) => {
    await applyRename(suggestion.speaker, suggestion.suggested_name);
  };

  return (
    <div className="border-t border-gray-200 bg-slate-50/70">
      <div className="px-3 py-2">
        <div className={`flex items-center justify-between gap-2 ${collapsed ? '' : 'mb-2'}`}>
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-expanded={!collapsed}
            aria-controls="speaker-manager-content"
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-sm font-semibold text-slate-800 outline-none hover:text-indigo-700 focus-visible:ring-2 focus-visible:ring-indigo-300"
          >
            <Users className="w-4 h-4 text-slate-500" />
            说话人
            {speakers.length > 0 && <span className="rounded-full bg-indigo-100 px-1.5 text-xs text-indigo-700">{speakers.length}</span>}
            <span className="ml-1 text-xs font-normal text-slate-500">{collapsed ? '展开' : '收起'}</span>
            {collapsed ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronUp className="h-4 w-4 text-slate-400" />}
          </button>
          {!collapsed && <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={handleSuggest}
              disabled={suggesting || speakers.length === 0}
              className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
            >
              {suggesting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              AI 命名
            </button>
            <label className="ml-1 inline-flex cursor-pointer items-center gap-1 text-xs text-slate-600" title="在每段转写上显示说话人下拉框，可把某句话指定给其他说话人">
              <input
                type="checkbox"
                checked={editing}
                onChange={(e) => toggleEditing(e.target.checked)}
                className="accent-indigo-600"
              />
              编辑段落
            </label>
          </div>}
        </div>

        {!collapsed && (
          <div id="speaker-manager-content">
            {editing && (
              <p className="mb-2 text-[11px] text-indigo-600">
                已开启段落编辑：在每条转写上选择说话人，可将某句话重新指定给其他说话人。
              </p>
            )}

            {loading ? (
              <div className="flex items-center gap-2 py-3 text-sm text-slate-400">
                <RefreshCw className="w-3 h-3 animate-spin" /> 加载说话人…
              </div>
            ) : speakers.length === 0 ? (
              <p className="py-2 text-xs text-slate-400">当前会议尚未识别出多说话人。需支持说话人分离的转写结果。</p>
            ) : (
              <ul className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                {speakers.map((s) => {
                  const isRenaming = renaming === s.speaker;
                  const draft = renameDraft[s.speaker] ?? '';
                  return (
                    <li key={s.speaker} className="rounded-md border border-slate-200 bg-white px-2 py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex max-w-[45%] items-center gap-1 truncate text-xs font-medium text-slate-800">
                          <span className="truncate">{s.speaker}</span>
                          <span className="shrink-0 rounded-full bg-slate-100 px-1 text-[10px] text-slate-500">{s.count}</span>
                        </span>
                        <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                          <Pencil className="w-3 h-3" />
                          <input
                            value={draft}
                            onChange={(e) => setRenameDraft((d) => ({ ...d, [s.speaker]: e.target.value }))}
                            placeholder="重命名"
                            className="w-24 rounded border border-slate-200 px-1.5 py-0.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-indigo-400"
                          />
                          <button
                            type="button"
                            onClick={() => applyRename(s.speaker, draft || s.speaker)}
                            disabled={isRenaming}
                            className="rounded bg-indigo-600 px-1.5 py-0.5 text-[11px] font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                          >
                            {isRenaming ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                          </button>
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-1 text-[11px] text-slate-400" title={s.sample_text}>
                        “{s.sample_text}”
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}

            {suggestionsOpen && suggestions.length > 0 && (
              <div className="mt-2 rounded-md border border-violet-200 bg-violet-50/70 p-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-violet-800">AI 建议命名</span>
                  <button
                    type="button"
                    onClick={() => setSuggestionsOpen(false)}
                    className="rounded p-0.5 text-violet-500 hover:bg-violet-100"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <ul className="space-y-1">
                  {suggestions.map((sg) => (
                    <li key={sg.speaker + sg.suggested_name} className="flex items-center justify-between gap-2 text-[11px] text-violet-900">
                      <span className="truncate">
                        {sg.speaker} → <b>{sg.suggested_name}</b>
                        <span className="ml-1 text-violet-400">（{sg.reason}）</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => applySuggestion(sg)}
                        disabled={renaming === sg.speaker}
                        className="shrink-0 rounded bg-violet-600 px-1.5 py-0.5 font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                      >
                        {renaming === sg.speaker ? <Loader2 className="w-3 h-3 animate-spin" /> : '应用'}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
