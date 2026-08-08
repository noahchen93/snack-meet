"use client";

import { useEffect, useMemo, useState } from 'react';
import { CheckSquare, Square, ListChecks, Trash2 } from 'lucide-react';
import { Summary } from '@/types';
import { toast } from 'sonner';

interface ActionItemsPanelProps {
  meetingId: string;
  aiSummary: Summary | null;
}

interface ActionItem {
  id: string;
  text: string;
  done: boolean;
}

const STORAGE_PREFIX = 'snackmeet_action_items_';

function loadItems(meetingId: string): ActionItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + meetingId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

function saveItems(meetingId: string, items: ActionItem[]) {
  try {
    localStorage.setItem(STORAGE_PREFIX + meetingId, JSON.stringify(items));
  } catch (e) {
    console.error('Failed to save action items:', e);
  }
}

/**
 * Extract action-item strings from the AI summary. The summary is a map of
 * section key -> { title, blocks }. We look for the section whose key or title
 * mentions "action" (action_items / Action Items), and fall back to any section
 * whose blocks look like tasks.
 */
function extractActionItems(aiSummary: Summary | null): string[] {
  if (!aiSummary) return [];

  const candidates: string[] = [];

  for (const [key, section] of Object.entries(aiSummary)) {
    if (!section || typeof section !== 'object') continue;
    const title = (section.title || '').toLowerCase();
    const keyLower = key.toLowerCase();

    const isActionSection =
      keyLower.includes('action') ||
      title.includes('action') ||
      title.includes('待办') ||
      title.includes('行动项') ||
      title.includes('todo');

    if (isActionSection && Array.isArray(section.blocks)) {
      for (const block of section.blocks) {
        const text = (block?.content || '').trim();
        if (text) candidates.push(text);
      }
    }
  }

  // Fallback: if no explicit action section found, scan all blocks for
  // task-like lines (start with a verb-ish marker or contain "should/need/待/要").
  if (candidates.length === 0) {
    for (const section of Object.values(aiSummary)) {
      if (!section || typeof section !== 'object' || !Array.isArray(section.blocks)) continue;
      for (const block of section.blocks) {
        const text = (block?.content || '').trim();
        if (!text) continue;
        if (/^(待|要|需|请|should|need|must|todo|action)/i.test(text)) {
          candidates.push(text);
        }
      }
    }
  }

  return candidates;
}

export function ActionItemsPanel({ meetingId, aiSummary }: ActionItemsPanelProps) {
  const [items, setItems] = useState<ActionItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Load persisted items once per meeting
  useEffect(() => {
    setItems(loadItems(meetingId));
    setLoaded(true);
  }, [meetingId]);

  // When the summary changes and we haven't persisted anything yet, seed from it
  const extracted = useMemo(() => extractActionItems(aiSummary), [aiSummary]);

  useEffect(() => {
    if (!loaded) return;
    // Only seed if there are no persisted items at all
    if (items.length === 0 && extracted.length > 0) {
      const seeded: ActionItem[] = extracted.map((text, i) => ({
        id: `seed-${i}-${Date.now()}`,
        text,
        done: false,
      }));
      setItems(seeded);
      saveItems(meetingId, seeded);
    }
  }, [loaded, extracted, items.length, meetingId]);

  const toggleItem = (id: string) => {
    setItems((prev) => {
      const next = prev.map((it) => (it.id === id ? { ...it, done: !it.done } : it));
      saveItems(meetingId, next);
      return next;
    });
  };

  const removeItem = (id: string) => {
    setItems((prev) => {
      const next = prev.filter((it) => it.id !== id);
      saveItems(meetingId, next);
      return next;
    });
  };

  const clearAll = () => {
    setItems([]);
    saveItems(meetingId, []);
    toast.success('已清空行动项');
  };

  const doneCount = items.filter((it) => it.done).length;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-indigo-500" />
          <h3 className="text-sm font-semibold text-gray-900">行动项</h3>
          {items.length > 0 && (
            <span className="text-xs text-gray-400">
              {doneCount}/{items.length} 已完成
            </span>
          )}
        </div>
        {items.length > 0 && (
          <button
            onClick={clearAll}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-red-500 transition-colors"
            title="清空行动项"
          >
            <Trash2 className="w-3.5 h-3.5" />
            清空
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-gray-400 py-2">
          {extracted.length > 0
            ? '正在生成行动项…'
            : '暂无行动项。生成会议总结后，行动项会自动出现在这里。'}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.id} className="group flex items-start gap-2">
              <button
                onClick={() => toggleItem(item.id)}
                className="mt-0.5 flex-shrink-0 text-gray-400 hover:text-indigo-500 transition-colors"
                title={item.done ? '标记为未完成' : '标记为已完成'}
              >
                {item.done ? (
                  <CheckSquare className="w-4 h-4 text-green-500" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
              </button>
              <span
                className={`text-sm flex-1 ${
                  item.done ? 'text-gray-400 line-through' : 'text-gray-700'
                }`}
              >
                {item.text}
              </span>
              <button
                onClick={() => removeItem(item.id)}
                className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-all"
                title="删除"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
