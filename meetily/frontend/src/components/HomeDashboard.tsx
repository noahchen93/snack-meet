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
  Volume2,
  FileX2,
  AlignLeft,
  Tags,
  Timer,
  FileAudio2,
  Sparkles,
  Loader2,
  X,
  FolderInput,
  Inbox,
  Archive,
  ArchiveRestore,
  Star,
  LayoutGrid,
  List,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { VisuallyHidden } from '@/components/ui/visually-hidden';
import { useLocale } from '@/contexts/LocaleContext';
import { LanguageToggle } from '@/components/LanguageToggle';
import { CopilotChat } from '@/components/MeetingDetails/CopilotChat';

type HomeMeeting = CurrentMeeting;

interface BatchProgressEvent {
  mode: string;
  index: number;
  total: number;
  meeting_id: string;
  title: string;
  status: string;
  error?: string | null;
}

interface BatchCompleteEvent {
  mode: string;
  total: number;
  succeeded: number;
  failed: number;
  cancelled: boolean;
}

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

function formatBytes(bytes?: number): string {
  const value = bytes || 0;
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(seconds?: number): string {
  const value = Math.max(0, Math.round(seconds || 0));
  if (value < 60) return `${value} 秒`;
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`;
}

function BatchItemBadge({ status }: { status: 'queued' | 'processing' | 'done' | 'failed' }) {
  if (status === 'processing') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
        <Loader2 className="w-3 h-3 animate-spin" />
        批量处理中
      </span>
    );
  }
  if (status === 'queued') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">
        <Clock className="w-3 h-3" />
        排队中
      </span>
    );
  }
  if (status === 'done') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
        <Check className="w-3 h-3" />
        处理完成
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-700">
      <X className="w-3 h-3" />
      处理失败
    </span>
  );
}

export function HomeDashboard() {
  const {
    meetings,
    setMeetings,
    refetchMeetings,
    searchTranscripts,
    searchResults,
    isSearching,
    collections,
    refetchCollections,
    libraryView,
  } = useSidebar();
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
  // Audio-only deletion keeps the meeting, its transcript and its documents.
  const [audioDeleteOpen, setAudioDeleteOpen] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => {
    if (typeof window === 'undefined') return 'grid';
    return localStorage.getItem('snack-meet-library-view-mode') === 'list' ? 'list' : 'grid';
  });
  // Batch queue (transcribe / summarize)
  const [batchMode, setBatchMode] = useState<'transcribe' | 'summarize' | null>(null);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number; currentTitle: string } | null>(null);
  const [batchItemStatus, setBatchItemStatus] = useState<Record<string, 'queued' | 'processing' | 'done' | 'failed'>>({});
  // Search/filter
  const [query, setQuery] = useState('');
  const [submittedSearchQuery, setSubmittedSearchQuery] = useState('');
  const { t } = useLocale();

  useEffect(() => {
    refetchMeetings().finally(() => setLoading(false));
  }, [refetchMeetings]);

  useEffect(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      setSubmittedSearchQuery('');
      void searchTranscripts('');
      return;
    }
    const timer = setTimeout(() => {
      setSubmittedSearchQuery(normalizedQuery);
      void searchTranscripts(query.trim());
    }, 250);
    return () => clearTimeout(timer);
  }, [query, searchTranscripts]);

  useEffect(() => {
    setSelected(new Set());
  }, [libraryView]);

  useEffect(() => {
    localStorage.setItem('snack-meet-library-view-mode', viewMode);
  }, [viewMode]);

  // Support a ?batch=<meetingId> entry from the meeting-details page: pre-select
  // that meeting so the user can continue building a batch in the toolbar.
  // Read from window.location (static export) instead of useSearchParams to avoid
  // requiring a Suspense boundary.
  const pendingBatchRef = React.useRef<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const batchId = new URLSearchParams(window.location.search).get('batch');
    if (batchId) pendingBatchRef.current = batchId;
    const id = pendingBatchRef.current;
    if (!id) return;
    if (!meetings.some((m) => m.id === id)) return; // wait until meetings are loaded
    setSelected((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    toast.info('已从会议详情加入批量处理', {
      description: '可继续勾选其他会议，再点击「批量转写 / 批量总结」。',
    });
    pendingBatchRef.current = null;
    router.replace('/', { scroll: false });
  }, [meetings, router]);

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

  const confirmDeleteAudio = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setDeleting(true);
    try {
      const result = await invoke<{ deleted: number; missing: number; freed_bytes: number }>(
        'api_delete_meeting_audio_files',
        { meetingIds: ids }
      );
      const selectedIds = new Set(ids);
      setMeetings(meetings.map((meeting) => selectedIds.has(meeting.id)
        ? { ...meeting, audioExists: false, audioSizeBytes: 0 }
        : meeting));
      setSelected(new Set());
      setAudioDeleteOpen(false);
      toast.success(`已删除 ${result.deleted} 个会议的音频`, {
        description: result.freed_bytes > 0 ? `已释放 ${formatBytes(result.freed_bytes)}；会议记录和文档仍会保留。` : '会议记录和文档仍会保留。',
      });
    } catch (error) {
      console.error('Failed to delete meeting audio:', error);
      toast.error('删除音频失败', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setDeleting(false);
    }
  };

  // Filter selected meetings by what the chosen batch mode can actually process.
  const getEligibleForBatch = (mode: 'transcribe' | 'summarize'): HomeMeeting[] => {
    const selectedMeetings = meetings.filter((m) => selected.has(m.id));
    if (mode === 'transcribe') {
      // Needs original audio and no transcript yet.
      return selectedMeetings.filter((m) => m.audioExists && (m.transcriptSegmentCount || 0) === 0);
    }
    // Summarize needs a transcript and no completed summary yet.
    return selectedMeetings.filter((m) => (m.transcriptSegmentCount || 0) > 0 && !m.hasSummary);
  };

  const openBatchConfirm = (mode: 'transcribe' | 'summarize') => {
    const eligible = getEligibleForBatch(mode);
    if (eligible.length === 0) {
      toast.warning(mode === 'transcribe' ? '没有可选会议：请选择包含音频且尚未转写的会议' : '没有可选会议：请选择已转写但未总结的会议');
      return;
    }
    setBatchMode(mode);
    setBatchConfirmOpen(true);
  };

  const confirmBatch = async () => {
    if (!batchMode) return;
    const eligible = getEligibleForBatch(batchMode);
    if (eligible.length === 0) return;
    const ids = eligible.map((m) => m.id);
    setBatchConfirmOpen(false);
    setBatchRunning(true);
    setBatchProgress({ done: 0, total: ids.length, currentTitle: '准备中…' });
    setBatchItemStatus(Object.fromEntries(ids.map((id) => [id, 'queued'])));

    const cleanUp = () => {
      unlistenRef.current.forEach((fn) => fn());
      unlistenRef.current = [];
    };
    try {
      const unProgress = await listen<BatchProgressEvent>('batch-progress', (event) => {
        if (event.payload.mode !== batchModeRef.current) return;
        const payload = event.payload;
        const finished = payload.status === 'done' || payload.status === 'failed';
        setBatchProgress((prev) => ({
          done: finished ? Math.min(payload.index + 1, payload.total) : (prev?.total ? payload.index : 0),
          total: payload.total,
          currentTitle: finished ? '' : payload.title || '',
        }));
        setBatchItemStatus((prev) => {
          if (!prev[payload.meeting_id]) return prev;
          const next =
            payload.status === 'done' ? 'done' :
            payload.status === 'failed' ? 'failed' : 'processing';
          return { ...prev, [payload.meeting_id]: next };
        });
      });
      unlistenRef.current.push(unProgress);

      const unComplete = await listen<BatchCompleteEvent>('batch-complete', async (event) => {
        if (event.payload.mode !== batchModeRef.current) return;
        cleanUp();
        setBatchRunning(false);
        setBatchProgress(null);
        setBatchItemStatus({});
        setSelected(new Set());
        await refetchMeetings();
        if (event.payload.cancelled) {
          toast.info('批量任务已取消', { description: `已完成 ${event.payload.succeeded} 项，剩余已跳过。` });
        } else if (event.payload.failed > 0) {
          toast.warning(`批量${batchModeRef.current === 'transcribe' ? '转写' : '总结'}完成`, {
            description: `成功 ${event.payload.succeeded} 项，失败 ${event.payload.failed} 项。`,
          });
        } else {
          toast.success(`批量${batchModeRef.current === 'transcribe' ? '转写' : '总结'}完成`, {
            description: `成功处理 ${event.payload.succeeded} 个会议。`,
          });
        }
      });
      unlistenRef.current.push(unComplete);

      await invoke('api_batch_process', { mode: batchMode, meetingIds: ids });
      setBatchProgress({ done: 0, total: ids.length, currentTitle: '排队中…' });
    } catch (error) {
      cleanUp();
      setBatchRunning(false);
      setBatchProgress(null);
      setBatchItemStatus({});
      toast.error('批量任务启动失败', { description: error instanceof Error ? error.message : String(error) });
    }
  };

  const cancelBatch = async () => {
    try {
      await invoke('api_cancel_batch');
      toast.info('正在取消批量任务…');
    } catch (error) {
      toast.error('取消失败', { description: error instanceof Error ? error.message : String(error) });
    }
  };

  // Keep the current mode available to event listeners.
  const batchModeRef = React.useRef<typeof batchMode>(null);
  batchModeRef.current = batchMode;

  // Ensure batch event listeners are removed if the component unmounts.
  const unlistenRef = React.useRef<Array<() => void>>([]);
  React.useEffect(() => {
    return () => {
      unlistenRef.current.forEach((fn) => fn());
      unlistenRef.current = [];
    };
  }, []);

  // Most recent first (backend already orders by created_at DESC).
  // Show ALL meetings (merged into this page), optionally filtered by search query.
  const q = query.trim().toLowerCase();
  const searchPending = Boolean(q) && (submittedSearchQuery !== q || isSearching);
  const currentSearchResults = submittedSearchQuery === q ? searchResults : [];
  const meetingById = new Map(meetings.map((meeting) => [meeting.id, meeting]));
  const searchResultByMeeting = new Map(currentSearchResults.map((result) => [result.id, result]));
  const searchFiltered = q
    ? currentSearchResults
        .map((result) => meetingById.get(result.id))
        .filter((meeting): meeting is CurrentMeeting => Boolean(meeting))
    : meetings;
  const visible = searchFiltered.filter((meeting) => {
    switch (libraryView.kind) {
      case 'inbox':
        return !meeting.isArchived && !meeting.collectionId;
      case 'favorites':
        return !meeting.isArchived && Boolean(meeting.isFavorite);
      case 'archived':
        return Boolean(meeting.isArchived);
      case 'collection':
        return !meeting.isArchived && meeting.collectionId === libraryView.collectionId;
      default:
        return !meeting.isArchived;
    }
  });
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
  const activeCollection = libraryView.kind === 'collection'
    ? collections.find((collection) => collection.id === libraryView.collectionId)
    : null;
  const viewTitle = activeCollection?.name || (
    libraryView.kind === 'inbox' ? t('inbox') :
      libraryView.kind === 'favorites' ? t('favorites') :
        libraryView.kind === 'archived' ? t('archived') : t('meetings')
  );

  const moveMeetings = async (meetingIds: string[], collectionId: string | null) => {
    if (organizing || meetingIds.length === 0) return;
    setOrganizing(true);
    try {
      await invoke('api_move_meetings_to_collection', { meetingIds, collectionId });
      await Promise.all([refetchMeetings(), refetchCollections()]);
      setSelected(new Set());
      toast.success(t('moveSuccess'));
    } catch (error) {
      toast.error(t('moveFailed'), { description: String(error) });
    } finally {
      setOrganizing(false);
    }
  };

  const setArchived = async (meetingIds: string[], archived: boolean) => {
    if (organizing || meetingIds.length === 0) return;
    setOrganizing(true);
    try {
      await invoke('api_set_meeting_archived', { meetingIds, archived });
      await Promise.all([refetchMeetings(), refetchCollections()]);
      setSelected(new Set());
    } catch (error) {
      toast.error(String(error));
    } finally {
      setOrganizing(false);
    }
  };

  const setFavorite = async (meeting: HomeMeeting) => {
    if (organizing) return;
    setOrganizing(true);
    try {
      await invoke('api_set_meeting_favorite', { meetingId: meeting.id, favorite: !meeting.isFavorite });
      await refetchMeetings();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setOrganizing(false);
    }
  };

  return (
    <div className="w-full max-w-5xl mx-auto px-6 py-6">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{viewTitle}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {activeCollection ? `${activeCollection.meetingCount} ${t('meetings')}` : t('meetingsSubtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="relative">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('globalSearchPlaceholder')}
              aria-label={t('globalSearchPlaceholder')}
              className="w-72 pl-9 pr-9 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
            {searchPending && (
              <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-indigo-500" />
            )}
          </div>
          <button
            onClick={handleScan}
            disabled={scanning}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${scanning ? 'animate-spin' : ''}`} />
            {scanning ? t('refreshing') : t('refresh')}
          </button>
          <LanguageToggle />
          <div className="flex rounded-lg border border-gray-200 bg-white p-0.5" aria-label="会议显示方式">
            <button
              onClick={() => setViewMode('list')}
              className={`rounded-md p-1.5 ${viewMode === 'list' ? 'bg-indigo-50 text-indigo-600' : 'text-gray-400 hover:text-gray-600'}`}
              aria-label="列表视图"
              title="列表视图"
            >
              <List className="h-4 w-4" />
            </button>
            <button
              onClick={() => setViewMode('grid')}
              className={`rounded-md p-1.5 ${viewMode === 'grid' ? 'bg-indigo-50 text-indigo-600' : 'text-gray-400 hover:text-gray-600'}`}
              aria-label="卡片视图"
              title="卡片视图"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
          </div>
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
            searchPending ? (
              <>
                <Loader2 className="mb-3 h-6 w-6 animate-spin text-indigo-500" />
                <p className="text-lg font-medium text-gray-700">{t('searching')}</p>
              </>
            ) : (
              <>
                <p className="text-lg font-medium text-gray-700">{t('noSearchResults')}</p>
                <p className="text-sm text-gray-400 mt-1">{t('tryAnotherKeyword')}</p>
              </>
            )
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
          <div className="sticky top-0 z-30 -mx-2 mb-4 flex items-center justify-between rounded-xl border border-transparent bg-gray-50/95 px-2 py-3 backdrop-blur supports-[backdrop-filter]:bg-gray-50/80">
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                className="w-4 h-4 text-indigo-600"
              />
              {t('selectAll')}（{selected.size}/{recent.length}）
            </label>
            {selected.size > 0 && (
              <div className="flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button disabled={organizing} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                      <FolderInput className="h-4 w-4" /> {t('moveSelected')}（{selected.size}）
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem onClick={() => moveMeetings([...selected], null)}>
                      <Inbox className="h-4 w-4" /> {t('inbox')}
                    </DropdownMenuItem>
                    {collections.length > 0 && <DropdownMenuSeparator />}
                    {collections.map((collection) => (
                      <DropdownMenuItem key={collection.id} onClick={() => moveMeetings([...selected], collection.id)}>
                        <FolderInput className="h-4 w-4" /> {collection.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <button
                  onClick={() => setArchived([...selected], libraryView.kind !== 'archived')}
                  disabled={organizing}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {libraryView.kind === 'archived' ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                  {libraryView.kind === 'archived' ? t('restoreArchive') : t('archive')}
                </button>
                <button
                  onClick={() => openBatchConfirm('transcribe')}
                  disabled={batchRunning}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <FileAudio2 className="w-4 h-4" />
                  {t('batchTranscribe')}（{getEligibleForBatch('transcribe').length}）
                </button>
                <button
                  onClick={() => openBatchConfirm('summarize')}
                  disabled={batchRunning}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-violet-700 bg-violet-50 border border-violet-200 rounded-lg hover:bg-violet-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Sparkles className="w-4 h-4" />
                  {t('batchSummarize')}（{getEligibleForBatch('summarize').length}）
                </button>
                <button
                  onClick={() => setAudioDeleteOpen(true)}
                  disabled={batchRunning}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <FileX2 className="w-4 h-4" />
                  {t('deleteAudio')}（{selected.size}）
                </button>
                <button
                  onClick={() => setBulkDeleteOpen(true)}
                  disabled={batchRunning}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Trash2 className="w-4 h-4" />
                  {t('delete')}（{selected.size}）
                </button>
              </div>
            )}
          </div>

          {/* Batch progress banner */}
          {batchRunning && batchProgress && (
            <div className="mb-4 rounded-xl border border-indigo-200 bg-indigo-50/80 p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <Loader2 className="h-5 w-5 animate-spin text-indigo-600 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-indigo-900">
                      批量{batchMode === 'transcribe' ? '转写' : '总结'}中 {batchProgress.done}/{batchProgress.total}
                    </p>
                    {batchProgress.currentTitle && (
                      <p className="text-xs text-indigo-600 truncate mt-0.5">正在处理：{batchProgress.currentTitle}</p>
                    )}
                  </div>
                </div>
                <button
                  onClick={cancelBatch}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                >
                  <X className="w-3 h-3" /> 取消
                </button>
              </div>
              <div className="mt-2 h-1.5 rounded-full bg-indigo-100 overflow-hidden">
                <div
                  className="h-full bg-indigo-600 transition-all"
                  style={{ width: `${batchProgress.total > 0 ? (batchProgress.done / batchProgress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          <div className="space-y-8">
            {grouped.map((group) => (
              <section key={group.key}>
                {/* Day partition header */}
                <div className="mb-3 flex items-center gap-3">
                  <h2 className="text-sm font-semibold text-gray-700">{group.label}</h2>
                  <div className="h-px flex-1 bg-gray-200"></div>
                  <span className="text-xs text-gray-400">{group.meetings.length} 个会议</span>
                </div>

                <div className={viewMode === 'list' ? 'grid grid-cols-1 gap-2' : 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'}>
                  {group.meetings.map((meeting) => {
                    const isSelected = selected.has(meeting.id);
                    const searchMatch = searchResultByMeeting.get(meeting.id);
                    return (
                      <div
                        key={meeting.id}
                        draggable={!batchRunning}
                        onDragStart={(event) => {
                          const meetingIds = selected.has(meeting.id) ? [...selected] : [meeting.id];
                          const payload = JSON.stringify(meetingIds);
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('application/x-snack-meeting-ids', payload);
                          event.dataTransfer.setData('text/plain', payload);
                        }}
                        className={`group relative text-left rounded-xl border bg-white ${viewMode === 'list' ? 'p-3' : 'p-4'} transition-all hover:shadow-md [content-visibility:auto] [contain-intrinsic-size:220px] ${
                          isSelected ? 'border-indigo-400 ring-2 ring-indigo-200' : 'border-gray-200 hover:border-indigo-300'
                        }`}
                      >
                        {/* Selection checkbox */}
                        <div className="absolute top-3 left-3 z-10">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={batchRunning}
                            aria-label={`选择会议：${meeting.title || '未命名会议'}`}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleSelect(meeting.id)}
                            className="w-4 h-4 text-indigo-600 disabled:opacity-50"
                          />
                        </div>

                        {/* Card clickable area */}
                        <button
                          type="button"
                          onClick={() => router.push(`/meeting-details?id=${meeting.id}`)}
                          className={`w-full cursor-pointer rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 ${viewMode === 'list' ? 'grid grid-cols-[minmax(220px,1.4fr)_auto_auto] items-center gap-4 pl-8 pr-8' : ''}`}
                          aria-label={`查看会议：${meeting.title || '未命名会议'}`}
                        >
                          <div className={`flex items-start justify-between gap-2 ${viewMode === 'list' ? '' : 'pl-8'}`}>
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
                          <div className={`flex items-center gap-1.5 ${viewMode === 'list' ? '' : 'mt-3'}`}>
                            <span className="inline-flex items-center gap-1 rounded-md bg-gray-50 px-2 py-0.5 text-[10px] text-gray-500">
                              <FileText className="w-3 h-3" />
                              {t('viewRecord')}
                            </span>
                            {meeting.audioExists ? (
                              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700">
                                <Volume2 className="w-3 h-3" />
                                {t('audioKept')} · {formatBytes(meeting.audioSizeBytes)}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500">
                                <FileX2 className="w-3 h-3" />
                                {t('documentsOnly')}
                              </span>
                            )}
                          </div>
                          <div className={`${viewMode === 'list' ? '' : 'mt-3'} flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500`}>
                            <span className="inline-flex items-center gap-1" title="转写文档字数">
                              <AlignLeft className="h-3 w-3" />
                              {(meeting.transcriptCharCount || 0).toLocaleString()} 字
                            </span>
                            <span className="inline-flex items-center gap-1" title="字幕段落数">
                              <FileText className="h-3 w-3" />
                              {meeting.transcriptSegmentCount || 0} 段
                            </span>
                            {(meeting.durationSeconds || 0) > 0 && (
                              <span className="inline-flex items-center gap-1" title="录音时长">
                                <Timer className="h-3 w-3" />
                                {formatDuration(meeting.durationSeconds)}
                              </span>
                            )}
                          </div>
                          {batchItemStatus[meeting.id] && (
                            <div className={`${viewMode === 'list' ? 'col-span-full' : ''} mt-2`}>
                              <BatchItemBadge status={batchItemStatus[meeting.id]} />
                            </div>
                          )}
                          {(meeting.keywords || []).length > 0 && (
                            <div className={`${viewMode === 'list' ? 'col-span-full' : ''} mt-2 flex flex-wrap gap-1`} aria-label="会议关键词">
                              {(meeting.keywords || []).slice(0, 5).map((keyword) => (
                                <span key={keyword} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
                                  <Tags className="h-2.5 w-2.5" />{keyword}
                                </span>
                              ))}
                            </div>
                          )}
                          {q && searchMatch && (
                            <div className={`${viewMode === 'list' ? 'col-span-full' : ''} mt-3 rounded-lg border border-amber-100 bg-amber-50/80 p-2.5`}>
                              <div className="mb-1.5 flex flex-wrap items-center gap-1">
                                {searchMatch.matchTypes.map((type) => (
                                  <span key={type} className="rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
                                    {type === 'title'
                                      ? t('matchedTitle')
                                      : type === 'transcript'
                                        ? t('matchedTranscript')
                                        : type === 'original'
                                          ? t('matchedOriginal')
                                          : t('matchedSummary')}
                                  </span>
                                ))}
                                {searchMatch.matchCount > 1 && (
                                  <span className="text-[10px] text-amber-600">
                                    {searchMatch.matchCount} {t('matchingSegments')}
                                  </span>
                                )}
                              </div>
                              <p className="line-clamp-3 text-[11px] leading-5 text-slate-600">
                                {searchMatch.matchContext}
                              </p>
                            </div>
                          )}
                        </button>

                        {/* Dropdown menu */}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              onClick={(e) => e.stopPropagation()}
                              disabled={batchRunning}
                              className="absolute top-3 right-3 p-1.5 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 z-10 disabled:opacity-40 disabled:cursor-not-allowed"
                              aria-label="更多操作"
                            >
                              <MoreVertical className="w-4 h-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger>
                                <FolderInput className="w-4 h-4" /> {t('moveTo')}
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent className="w-48">
                                <DropdownMenuItem onClick={() => moveMeetings([meeting.id], null)}>
                                  <Inbox className="h-4 w-4" /> {t('inbox')}
                                </DropdownMenuItem>
                                {collections.length > 0 && <DropdownMenuSeparator />}
                                {collections.map((collection) => (
                                  <DropdownMenuItem key={collection.id} onClick={() => moveMeetings([meeting.id], collection.id)}>
                                    <FolderInput className="h-4 w-4" /> {collection.name}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                            <DropdownMenuItem onClick={() => setFavorite(meeting)}>
                              <Star className={`w-4 h-4 ${meeting.isFavorite ? 'fill-amber-400 text-amber-500' : ''}`} />
                              {meeting.isFavorite ? t('removeFavorite') : t('addFavorite')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setArchived([meeting.id], !meeting.isArchived)}>
                              {meeting.isArchived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
                              {meeting.isArchived ? t('restoreArchive') : t('archive')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => startRename(meeting)}>
                              <Pencil className="w-4 h-4 mr-2" /> {t('rename')}
                            </DropdownMenuItem>
                            {meeting.audioExists && (
                              <DropdownMenuItem
                                className="text-amber-700 focus:text-amber-800"
                                onClick={() => {
                                  setSelected(new Set([meeting.id]));
                                  setAudioDeleteOpen(true);
                                }}
                              >
                                <FileX2 className="w-4 h-4 mr-2" /> {t('deleteAudio')}
                              </DropdownMenuItem>
                            )}
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

      {/* Audio-only deletion confirmation */}
      <Dialog open={audioDeleteOpen} onOpenChange={(open) => { if (!open) setAudioDeleteOpen(false); }}>
        <DialogContent className="sm:max-w-[425px]">
          <VisuallyHidden><DialogTitle>删除会议音频</DialogTitle></VisuallyHidden>
          <div className="py-4">
            <h3 className="text-lg font-semibold mb-2">删除原始音频</h3>
            <p className="text-sm text-gray-600">
              将删除选中 {selected.size} 个会议的音频文件，释放磁盘空间。会议记录、转写、摘要和文档会完整保留，之后不能直接播放或重新转写这些音频。
            </p>
          </div>
          <DialogFooter>
            <button onClick={() => setAudioDeleteOpen(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-md">取消</button>
            <button onClick={confirmDeleteAudio} disabled={deleting} className="px-4 py-2 text-sm bg-amber-600 text-white hover:bg-amber-700 rounded-md disabled:opacity-50">
              {deleting ? '删除中…' : '删除音频，保留记录'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Batch confirm Dialog */}
      <Dialog open={batchConfirmOpen} onOpenChange={(open) => { if (!open) setBatchConfirmOpen(false); }}>
        <DialogContent className="sm:max-w-[425px]">
          <VisuallyHidden>
            <DialogTitle>批量处理确认</DialogTitle>
          </VisuallyHidden>
          <div className="py-4">
            <h3 className="text-lg font-semibold mb-2">
              {batchMode === 'transcribe' ? '批量转写' : '批量总结'}
            </h3>
            {batchMode === 'transcribe' ? (
              <p className="text-sm text-gray-600 mb-3">
                将按顺序为 <b>{getEligibleForBatch('transcribe').length}</b> 个已选中、含音频且尚未转写的会议执行转写。
              </p>
            ) : (
              <p className="text-sm text-gray-600 mb-3">
                将按顺序为 <b>{getEligibleForBatch('summarize').length}</b> 个已选中、已转写且尚未总结的会议生成总结。
              </p>
            )}
            <p className="text-xs text-gray-400">任务逐个排队执行，可随时取消。已处理过的会议会被自动跳过。</p>
          </div>
          <DialogFooter>
            <button onClick={() => setBatchConfirmOpen(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-md">取消</button>
            <button onClick={confirmBatch} className="px-4 py-2 text-sm bg-indigo-600 text-white hover:bg-indigo-700 rounded-md">
              开始排队处理
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
      <CopilotChat />
    </div>
  );
}
