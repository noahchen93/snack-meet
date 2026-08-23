'use client';

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { FileText, RotateCcw, History } from 'lucide-react';

const MAX_LENGTH = 2000;

const DEFAULT_PROMPT = `你是一名专业的会议记录整理助手。请根据提供的会议转写内容，生成结构清晰、要点明确的会议总结，包括议程、关键决策、待办事项和结束语。使用简洁、客观、分点的表达方式，保留关键数据、人名和具体信息。`;

export function SummarySystemPromptSettings() {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const loadPrompt = useCallback(async () => {
    try {
      const value = await invoke<string>('api_get_global_summary_prompt');
      setPrompt(value || '');
    } catch (error) {
      console.error('Failed to load global summary prompt:', error);
      toast.error('加载全局总结提示词失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPrompt();
  }, [loadPrompt]);

  const handleSave = async () => {
    if (prompt.trim().length > MAX_LENGTH) {
      toast.error(`提示词超过字数限制（${MAX_LENGTH} 字）`);
      return;
    }
    setSaving(true);
    try {
      await invoke('api_set_global_summary_prompt', { prompt });
      setDirty(false);
      toast.success('全局总结提示词已保存');
    } catch (error) {
      console.error('Failed to save global summary prompt:', error);
      toast.error('保存全局总结提示词失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleResetDefault = () => {
    setPrompt(DEFAULT_PROMPT);
    setDirty(true);
  };

  const handleClear = () => {
    setPrompt('');
    setDirty(true);
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <FileText size={18} className="text-gray-500" />
        <h3 className="text-lg font-semibold text-gray-900">全局总结系统提示词</h3>
      </div>
      <p className="text-sm text-gray-600 mb-4">
        为所有会议总结设置全局 System Prompt。它会附加在模板生成的系统提示词之后，作用于所有新生成和重新生成的总结。
        留空表示使用默认提示词。
      </p>

      <textarea
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value.slice(0, MAX_LENGTH));
          setDirty(true);
        }}
        disabled={loading}
        placeholder="例如：请始终使用简洁、分点的中文格式输出总结。"
        rows={6}
        maxLength={MAX_LENGTH}
        className="w-full rounded-lg border border-gray-200 p-3 text-sm font-mono text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 resize-y"
      />

      <div className="mt-1 flex items-center justify-between text-xs text-gray-400">
        <span className={prompt.trim().length >= MAX_LENGTH ? 'text-red-500 font-medium' : ''}>
          {prompt.length.toLocaleString()} / {MAX_LENGTH.toLocaleString()} 字
          {prompt.trim().length >= MAX_LENGTH && '（已达上限）'}
        </span>
        {!loading && prompt.trim().length > 0 && (
          <span>当前已配置，长度 {prompt.trim().length.toLocaleString()} 字</span>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={handleResetDefault}
            disabled={loading || saving}
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 disabled:opacity-50"
            title="恢复为默认提示词"
          >
            <History size={14} /> 恢复默认
          </button>
          <button
            onClick={handleClear}
            disabled={loading || saving || !prompt}
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 disabled:opacity-50"
          >
            <RotateCcw size={14} /> 清空
          </button>
        </div>
        <button
          onClick={handleSave}
          disabled={loading || saving || !dirty}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}
