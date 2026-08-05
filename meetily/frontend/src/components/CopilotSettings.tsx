'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Window } from '@tauri-apps/api/window';
import { Bot, ExternalLink, Trash2, Cloud, Save } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';

interface CopilotCloudConfig {
  endpoint?: string;
  apiKey?: string;
  model?: string;
}

interface RecordingPreferences {
  auto_detect_meetings: boolean;
}

export function CopilotSettings() {
  const [doc, setDoc] = useState('');
  const [cloud, setCloud] = useState<CopilotCloudConfig>({});
  const [saving, setSaving] = useState(false);
  const [autoDetect, setAutoDetect] = useState(false);
  const [loading, setLoading] = useState(true);

  // Load existing config on mount.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [d, c, prefs] = await Promise.all([
          invoke<string>('copilot_get_context_document').catch(() => ''),
          invoke<CopilotCloudConfig>('copilot_get_cloud_config').catch(() => ({})),
          invoke<RecordingPreferences>('get_recording_preferences').catch(() => ({ auto_detect_meetings: false } as RecordingPreferences)),
        ]);
        if (!mounted) return;
        setDoc(d ?? '');
        setCloud(c ?? {});
        setAutoDetect(!!prefs.auto_detect_meetings);
      } catch (e) {
        console.error('Failed to load copilot settings:', e);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const openCopilotWindow = useCallback(async () => {
    try {
      const win = await Window.getByLabel('ai-copilot');
      if (!win) {
        toast.error('未找到 Copilot 窗口');
        return;
      }
      await win.show();
      await win.setFocus();
    } catch (e) {
      toast.error('无法打开 Copilot 窗口', { description: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const saveAll = useCallback(async () => {
    setSaving(true);
    try {
      await invoke('copilot_save_context_document', { content: doc });
      await invoke('copilot_save_cloud_config', { config: cloud });
      toast.success('已保存 Copilot 设置');
    } catch (e) {
      toast.error('保存失败', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }, [doc, cloud]);

  const handleAutoDetectToggle = useCallback(async (enabled: boolean) => {
    const prev = autoDetect;
    setAutoDetect(enabled);
    try {
      const prefs = await invoke<RecordingPreferences>('get_recording_preferences').catch(
        () => ({ auto_detect_meetings: false } as RecordingPreferences)
      );
      await invoke('set_recording_preferences', { preferences: { ...prefs, auto_detect_meetings: enabled } });
      if (enabled) {
        const alreadyGranted = await invoke<boolean>('preflight_screen_capture').catch(() => false);
        const granted = alreadyGranted
          ? true
          : await invoke<boolean>('request_screen_capture').catch(() => false);
        if (!granted) {
          toast.warning('需要屏幕录制权限', {
            description: '请在 系统设置 → 隐私与安全 → 屏幕录制 中授权 Snack Meet，然后重启应用。',
          });
          setAutoDetect(false);
          return;
        }
        await invoke('meeting_detector_start');
        toast.success('已开启会议自动检测');
      } else {
        await invoke('meeting_detector_stop');
        toast.success('已关闭会议自动检测');
      }
    } catch (e) {
      setAutoDetect(prev);
      toast.error('切换失败', { description: e instanceof Error ? e.message : String(e) });
    }
  }, [autoDetect]);

  if (loading) {
    return <div className="animate-pulse space-y-4"><div className="h-8 bg-gray-200 rounded w-1/3"></div><div className="h-32 bg-gray-200 rounded"></div></div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-1">AI Copilot（实验）</h3>
        <p className="text-sm text-gray-600 mb-4">
          边录音边基于会议内容自动提醒，或随时向 AI 提问。可提供背景资料，并可选云端模型以获得更快响应。
        </p>
      </div>

      {/* Open window */}
      <div className="p-4 border rounded-lg bg-gradient-to-r from-indigo-50 to-violet-50 flex items-center justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 font-medium">
            <Bot className="w-4 h-4 text-indigo-600" /> 打开 AI 副驾窗口
          </div>
          <div className="text-sm text-gray-600 mt-1">在悬浮窗中查看自动提醒、随时提问</div>
        </div>
        <button
          onClick={openCopilotWindow}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm hover:bg-indigo-500 transition-colors"
        >
          <ExternalLink className="w-4 h-4" /> 打开
        </button>
      </div>

      {/* Auto-detect meetings */}
      <div className="flex items-center justify-between p-4 border rounded-lg">
        <div className="flex-1">
          <div className="font-medium">自动检测会议 / 语音通话</div>
          <div className="text-sm text-gray-600">
            自动检测腾讯会议 / Zoom / 微信 / WhatsApp 语音等并提示录音。需屏幕录制权限。
          </div>
        </div>
        <Switch checked={autoDetect} onCheckedChange={handleAutoDetectToggle} />
      </div>

      {/* Context document */}
      <div className="p-4 border rounded-lg">
        <div className="flex items-center justify-between mb-2">
          <div className="font-medium">语境 / 背景资料</div>
          <button
            onClick={() => setDoc('')}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-rose-500"
          >
            <Trash2 className="w-3 h-3" /> 清空
          </button>
        </div>
        <textarea
          value={doc}
          onChange={(e) => setDoc(e.target.value)}
          rows={5}
          placeholder="粘贴你的背景、目标、项目资料等，AI 回答时会结合这些语境。"
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none placeholder:text-gray-400 focus:border-indigo-300"
        />
        <p className="text-xs text-gray-400 mt-1">保存在 app 数据目录的 copilot_context.md</p>
      </div>

      {/* Cloud config */}
      <div className="p-4 border rounded-lg">
        <div className="flex items-center gap-2 font-medium mb-2">
          <Cloud className="w-4 h-4 text-indigo-600" /> 云端模型（可选，更快）
        </div>
        <div className="space-y-2">
          <input
            value={cloud.endpoint ?? ''}
            onChange={(e) => setCloud((c) => ({ ...c, endpoint: e.target.value }))}
            placeholder="API 地址，如 https://api.openai.com/v1"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none placeholder:text-gray-400 focus:border-indigo-300"
          />
          <input
            value={cloud.model ?? ''}
            onChange={(e) => setCloud((c) => ({ ...c, model: e.target.value }))}
            placeholder="模型名，如 gpt-4o-mini"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none placeholder:text-gray-400 focus:border-indigo-300"
          />
          <input
            value={cloud.apiKey ?? ''}
            onChange={(e) => setCloud((c) => ({ ...c, apiKey: e.target.value }))}
            placeholder="API Key（留空则用设置里的 LLM）"
            type="password"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none placeholder:text-gray-400 focus:border-indigo-300"
          />
          <p className="text-xs text-gray-400">
            配置云端模型后优先使用；留空则复用「设置 → LLM」的配置。
          </p>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={saveAll}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2 rounded-lg bg-indigo-600 text-white text-sm hover:bg-indigo-500 transition-colors disabled:opacity-40"
        >
          <Save className="w-4 h-4" /> {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}
