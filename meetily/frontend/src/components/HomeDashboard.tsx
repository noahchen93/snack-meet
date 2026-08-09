'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSidebar, CurrentMeeting } from '@/components/Sidebar/SidebarProvider';
import {
  Mic2,
  ChevronRight,
  Clock,
  FileText,
  RefreshCw,
  MoreVertical,
  Pencil,
  Trash2,
  Check,
  Search,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { VisuallyHidden } from '@/components/ui/visually-hidden';

interface HomeMeeting extends CurrentMeeting {}

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const isThisYear = d.getFullYear() === now.getFullYear();
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `今天 ${time}`;
  if (isThisYear) return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function HomeDashboard() {
  const { meetings, setMeetings, refetchMeetings } = useSidebar();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  // Multi-select state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Rename dialog state
  const [renameTarget, setRenameTarget] = useState<HomeMeeting | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [savingRename, setSavingRename] = useState(false);
  // Delete confirm dialog (single card)
  const [deleteTarget, setDeleteTarget] = useState<HomeMeeting | null>(null);
  const [deleteFiles, setDeleteFiles] = useState(false);
  // Bulk delete confirm
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleteFiles, setBulkDeleteFiles] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Search/filter
  const [query, setQuery] = useState('');

  useEffect(() => {
    refetchMeetings().finally(() => setLoading(false));
  }, [refetchMeetings]);

  // Scan the recordings folder for newly synced transcripts.json files
  const handleScan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const prefs = await invoke<{ save_folder?: string }>('get_recording_preferences');
      const folderPath = prefs.save_folder;
      if (!folderPath) {
        toast.warning('未设置录音保存文件夹', {
          description: '请先在 设置 → Recordings 中配置保存位置。',
        });
        return;
      }
      const result = await invoke<{
        scanned: number;
        imported: number;
        updated: number;
        skipped: number;
        failed: number;
      }>('scan_and_import_transcripts', { folderPath });
      if (result.imported > 0 || result.updated > 0) {
        toast.success(`已导入 ${result.imported} 个新会议，更新 ${result.updated} 个`, {
          description: `扫描 ${result.scanned} 个文件夹，跳过 ${result.skipped} 个，失败 ${result.failed} 个。`,
        });
      } else {
        toast.info('没有新的转写可导入', {
          description: `扫描 ${result.scanned} 个文件夹，跳过 ${result.skipped} 个，失败 ${result.failed} 个。`,
        });
      }
      await refetchMeetings();
    } catch (error) {
      console.error('Failed to scan and import transcripts:', error);
      toast.error('扫描导入失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setScanning(false);
    }
  };

  // Toggle a single meeting's selection
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (prev.size === recent.length) return new Set();
      return new Set(recent.map((m) => m.id));
    });
  };

  // Rename a single meeting
  const startRename = (m: HomeMeeting) => {
    setRenameTarget(m);
    setRenameValue(m.title || '');
  };

  const confirmRename = async () => {
    if (!renameTarget) return;
    const title = renameValue.trim();
    if (!title) {
      toast.error('会议名称不能为空');
      return;
    }
    setSavingRename(true);
    try {
      await invoke('api_save_meeting_title', {
        meetingId: renameTarget.id,
        title,
      });
      setMeetings(
        meetings.map((m) => (m.id === renameTarget.id ? { ...m, title } : m))
      );
      toast.success('会议名称已更新');
      setRenameTarget(null);
    } catch (error) {
      console.error('Failed to rename meeting:', error);
      toast.error('重命名失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSavingRename(false);
    }
  };

  // Delete a single meeting (optionally with files)
  const confirmSingleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      if (deleteFiles) {
        await invoke('api_delete_meeting_with_files', { meetingId: deleteTarget.id });
      } else {
        await invoke('api_delete_meeting', { meetingId: deleteTarget.id });
      }
      setMeetings(meetings.filter((m) => m.id !== deleteTarget.id));
      toast.success(deleteFiles ? '会议和文件已删除' : '会议已删除');
      setDeleteTarget(null);
      setDeleteFiles(false);
    } catch (error) {
      console.error('Failed to delete meeting:', error);
      toast.error('删除失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDeleting(false);
    }
  };

  // Bulk delete selected meetings
  const confirmBulkDelete = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setDeleting(true);
    try {
      await invoke('api_delete_meetings', {
        meetingIds: ids,
        deleteFiles: bulkDeleteFiles,
      });
      const remaining = meetings.filter((m) => !selected.has(m.id));
      setMeetings(remaining);
      setSelected(new Set());
      setBulkDeleteOpen(false);
      setBulkDeleteFiles(false);
      toast.success(bulkDeleteFiles ? `已删除 ${ids.length} 个会议及文件` : `已删除 ${ids.length} 个会议`);
    } catch (error) {
      console.error('Failed to bulk delete meetings:', error);
      toast.error('批量删除失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDeleting(false);
    }
  };

  // Most recent first (backend already orders by created_at DESC).
  // Show ALL meetings (merged into this page), optionally filtered by search query.
  const q = query.trim().toLowerCase();
  const visible = q
    ? meetings.filter((m) => (m.title || '').toLowerCase().includes(q))
    : meetings;
  const recent = visible;
  const allSelected = recent.length > 0 && selected.size === recent.length;

  // Group meetings by their recording date (day label). Used to render the
  // list partitioned by day, like a downloads folder (今天/昨天/具体日期).
  function groupByDay(list: HomeMeeting[]): Array<{ label: string; key: string; meetings: HomeMeeting[] }> {
    const groups: Array<{ label: string; key: string; meetings: HomeMeeting[] }> = [];
    const seen = new Map<string, number>();
    for (const m of list) {
      const key = dayKey(m.createdAt);
      const idx = seen.get(key);
      if (idx === undefined) {
        seen.set(key, groups.length);
        groups.push({ key, label: dayLabel(m.createdAt), meetings: [m] });
      } else {
        groups[idx].meetings.push(m);
      }
    }
    return groups;
  }

  function dayKey(iso?: string): string {
    if (!iso) return 'unknown';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'unknown';
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function dayLabel(iso?: string): string {
    if (!iso) return '其他日期';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '其他日期';
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();
    if (isToday) return '今天';
    if (isYesterday) return '昨天';
    const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    if (d.getFullYear() === now.getFullYear()) {
      return `${d.getMonth() + 1}月${d.getDate()}日 ${weekday}`;
    }
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${weekday}`;
  }

  const grouped = groupByDay(recent);

  return (
    <div className="w-full max-w-5xl mx-auto px-6 py-6">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">会议记录</h1>
          <p className="text-sm text-gray-500 mt-1">管理、总览和翻阅你的全部会议记录</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="relative">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索会议标题…"
              className="w-56 pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>
          <button
            onClick={handleScan}
            disabled={scanning}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${scanning ? 'animate-spin' : ''}`} />
            {scanning ? '扫描中…' : '更新扫描'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-32 rounded-xl bg-gray-100 animate-pulse"></div>
          ))}
        </div>
      ) : recent.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 rounded-full bg-indigo-50 flex items-center justify-center mb-4">
            <Mic2 className="w-8 h-8 text-indigo-400" />
          </div>
          {q ? (
            <>
              <p className="text-lg font-medium text-gray-700">没有找到匹配的会议</p>
              <p className="text-sm text-gray-400 mt-1">换个关键词试试</p>
            </>
          ) : (
            <>
              <p className="text-lg font-medium text-gray-700">还没有录音记录</p>
              <p className="text-sm text-gray-400 mt-1">开启录音后，你的会议记录会显示在这里</p>
            </>
          )}
        </div>
      ) : (
        <div>
          {/* Selection toolbar */}
          <div className="mb-4 flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                className="w-4 h-4 text-indigo-600"
              />
              全选（{selected.size}/{recent.length}）
            </label>
            {selected.size > 0 && (
              <button
                onClick={() => setBulkDeleteOpen(true)}
                className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                批量删除（{selected.size}）
              </button>
            )}
          </div>

          <div className="space-y-8">
            {grouped.map((group) => (
              <section key={group.key}>
                {/* Day partition header */}
                <div className="mb-3 flex items-center gap-3">
                  <h2 className="text-sm font-semibold text-gray-700">{group.label}</h2>
                  <div className="h-px flex-1 bg-gray-200"></div>
                  <span className="text-xs text-gray-400">{group.meetings.length} 个会议</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {group.meetings.map((meeting) => {
                    const isSelected = selected.has(meeting.id);
                    return (
                      <div
                        key={meeting.id}
                        className={`group relative text-left rounded-xl border bg-white p-4 transition-all hover:shadow-md ${
                          isSelected ? 'border-indigo-400 ring-2 ring-indigo-200' : 'border-gray-200 hover:border-indigo-300'
                        }`}
                      >
                        {/* Selection checkbox */}
                        <div className="absolute top-3 left-3 z-10">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleSelect(meeting.id)}
                            className="w-4 h-4 text-indigo-600"
                          />
                        </div>

                        {/* Card clickable area */}
                        <div
                          onClick={() => router.push(`/meeting-details?id=${meeting.id}`)}
                          className="cursor-pointer"
                        >
                          <div className="flex items-start justify-between gap-2 pl-8">
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-gray-800 truncate group-hover:text-indigo-600 transition-colors">
                                {meeting.title || '未命名会议'}
                              </p>
                              <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {formatDate(meeting.createdAt)}
                              </p>
                            </div>
                            <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-indigo-400 shrink-0 mt-1" />
                          </div>
                          <div className="flex items-center gap-1.5 mt-3">
                            <span className="inline-flex items-center gap-1 rounded-md bg-gray-50 px-2 py-0.5 text-[10px] text-gray-500">
                              <FileText className="w-3 h-3" />
                              查看记录
                            </span>
                          </div>
                        </div>

                        {/* Dropdown menu */}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              onClick={(e) => e.stopPropagation()}
                              className="absolute top-3 right-3 p-1.5 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 z-10"
                              aria-label="更多操作"
                            >
                              <MoreVertical className="w-4 h-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem onClick={() => startRename(meeting)}>
                              <Pencil className="w-4 h-4 mr-2" /> 重命名
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-red-600 focus:text-red-700"
                              onClick={() => setDeleteTarget(meeting)}
                            >
                              <Trash2 className="w-4 h-4 mr-2" /> 删除
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}

      {/* Rename Dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => { if (!open) setRenameTarget(null); }}>
        <DialogContent className="sm:max-w-[425px]">
          <VisuallyHidden>
            <DialogTitle>重命名会议</DialogTitle>
          </VisuallyHidden>
          <div className="py-4">
            <h3 className="text-lg font-semibold mb-4">重命名会议</h3>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="输入新的会议名称"
              autoFocus
            />
          </div>
          <DialogFooter>
            <button
              onClick={() => setRenameTarget(null)}
              className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-md"
            >
              取消
            </button>
            <button
              onClick={confirmRename}
              disabled={savingRename}
              className="px-4 py-2 text-sm bg-indigo-600 text-white hover:bg-indigo-700 rounded-md disabled:opacity-50"
            >
              {savingRename ? '保存中…' : '保存'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Single delete confirm Dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteFiles(false); } }}>
        <DialogContent className="sm:max-w-[425px]">
          <VisuallyHidden>
            <DialogTitle>删除会议</DialogTitle>
          </VisuallyHidden>
          <div className="py-4">
            <h3 className="text-lg font-semibold mb-2">删除会议</h3>
            <p className="text-sm text-gray-600 mb-4">
              确定要删除「{deleteTarget?.title || '未命名会议'}」吗？
            </p>
            <label className="flex items-start gap-2 p-3 bg-red-50 rounded-md cursor-pointer">
              <input
                type="checkbox"
                checked={deleteFiles}
                onChange={(e) => setDeleteFiles(e.target.checked)}
                className="mt-0.5 w-4 h-4 text-red-600"
              />
              <span className="text-sm text-red-700">
                同时彻底删除原始录音文件（音频和整个会议文件夹，释放磁盘空间）
              </span>
            </label>
          </div>
          <DialogFooter>
            <button
              onClick={() => { setDeleteTarget(null); setDeleteFiles(false); }}
              className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-md"
            >
              取消
            </button>
            <button
              onClick={confirmSingleDelete}
              disabled={deleting}
              className="px-4 py-2 text-sm bg-red-600 text-white hover:bg-red-700 rounded-md disabled:opacity-50"
            >
              {deleting ? '删除中…' : deleteFiles ? '彻底删除' : '删除'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk delete confirm Dialog */}
      <Dialog open={bulkDeleteOpen} onOpenChange={(open) => { if (!open) { setBulkDeleteOpen(false); setBulkDeleteFiles(false); } }}>
        <DialogContent className="sm:max-w-[425px]">
          <VisuallyHidden>
            <DialogTitle>批量删除会议</DialogTitle>
          </VisuallyHidden>
          <div className="py-4">
            <h3 className="text-lg font-semibold mb-2">批量删除会议</h3>
            <p className="text-sm text-gray-600 mb-4">
              确定要删除选中的 {selected.size} 个会议吗？
            </p>
            <label className="flex items-start gap-2 p-3 bg-red-50 rounded-md cursor-pointer">
              <input
                type="checkbox"
                checked={bulkDeleteFiles}
                onChange={(e) => setBulkDeleteFiles(e.target.checked)}
                className="mt-0.5 w-4 h-4 text-red-600"
              />
              <span className="text-sm text-red-700">
                同时彻底删除这些会议的原始录音文件（释放磁盘空间）
              </span>
            </label>
          </div>
          <DialogFooter>
            <button
              onClick={() => { setBulkDeleteOpen(false); setBulkDeleteFiles(false); }}
              className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-md"
            >
              取消
            </button>
            <button
              onClick={confirmBulkDelete}
              disabled={deleting}
              className="px-4 py-2 text-sm bg-red-600 text-white hover:bg-red-700 rounded-md disabled:opacity-50"
            >
              {deleting ? '删除中…' : bulkDeleteFiles ? '彻底删除' : '删除'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
