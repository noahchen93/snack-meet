'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Activity,
  BarChart3,
  BrainCircuit,
  Check,
  Edit3,
  FileText,
  Hash,
  Loader2,
  LockKeyhole,
  MessageCircleQuestion,
  RefreshCw,
  Search,
  ShieldCheck,
  Tags,
  Trash2,
  Type,
} from 'lucide-react';
import { toast } from 'sonner';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useLocale } from '@/contexts/LocaleContext';
import { LanguageToggle } from '@/components/LanguageToggle';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';

interface TagStat {
  name: string;
  meetingCount: number;
  percentage: number;
  lastUsedAt?: string | null;
}

interface TagDashboard {
  tags: TagStat[];
  taggedMeetingCount: number;
  summarizedMeetingCount: number;
}

interface WordFrequency {
  word: string;
  count: number;
  meetingCount: number;
}

interface ChartBucket {
  label: string;
  meetingCount: number;
  characterCount: number;
}

interface HabitMetric {
  label: string;
  count: number;
  perTenThousandChars: number;
}

interface CorpusAnalysisResult {
  overview: {
    meetingCount: number;
    characterCount: number;
    termCount: number;
    uniqueTermCount: number;
    averageCharactersPerMeeting: number;
    questionCount: number;
    lexicalDiversity: number;
  };
  words: WordFrequency[];
  monthlyActivity: ChartBucket[];
  weekdayActivity: ChartBucket[];
  timeOfDayActivity: ChartBucket[];
  habits: HabitMetric[];
  analysisEngine: 'fast' | 'local-ai';
  aiRefinement?: {
    provider: string;
    isLocal: boolean;
    insights: string[];
  } | null;
  generatedAt: string;
}

interface CorpusAiStatus {
  configured: boolean;
  provider?: string | null;
  model?: string | null;
  isLocal: boolean;
}

const CONSENT_KEY = 'snack-meet-local-corpus-analysis-consent-v1';

const copy = {
  'zh-CN': {
    title: '语料分析', subtitle: '从会议文字中发现常用表达、主题分布和沟通习惯',
    analysis: '分析面板', tags: '标签管理', privacyTitle: '先授权本机语料分析',
    privacyBody: 'Snack Meet 将读取你选择范围内的转写文字，并仅在这台 Mac 上计算聚合统计。原文不会发送给 AI、云端或第三方，分析结果也不会自动上传。',
    privacyPoint1: '只有点击“开始分析”时才读取文字', privacyPoint2: '只返回词频和图表等聚合结果',
    privacyPoint3: '可随时撤销授权并清除当前结果', authorize: '授权本机分析', revoke: '撤销授权',
    scope: '分析范围', all: '全部会议', folder: '指定文件夹', tag: '指定标签',
    textSource: '文字来源', translated: '转写全文', original: '原始分段', both: '两者合并',
    engine: '分析方式', fastEngine: '快速本机统计', fastEngineHint: '强化停用词与碎片过滤，不调用模型',
    localAiEngine: '本地 AI 精炼', localAiHint: '由内置模型或真正的本地 Ollama 筛选并解读',
    summaryAiEngine: '总结模型/API', summaryAiHint: '需要你另行授权发送节选后才能启用',
    notLocalModel: '当前总结模型不是纯本地模型', configureLocal: '请在设置中选择内置模型或本地 Ollama 模型',
    aiInsights: 'AI 发现的表达规律',
    start: '开始分析', analyzing: '正在本机分析…', refresh: '重新分析', chooseFolder: '选择文件夹', chooseTag: '选择标签',
    meetings: '纳入会议', characters: '文字总量', vocabulary: '候选词汇', questions: '疑问句',
    wordWall: '词频墙', wordWallHint: '词越大，出现频率越高；悬停可查看次数和覆盖会议数。',
    topWords: '高频词排行', monthly: '月度文字活动', weekdays: '星期分布', timeOfDay: '会议时段',
    habits: '表达习惯', habitsHint: '口头填充词按每一万字归一化，便于跨范围比较。',
    noData: '当前范围没有可分析的文字', noTags: '还没有智能标签。完成会议总结后，标签会出现在这里。',
    tagStats: '标签总览', taggedMeetings: '有标签的会议', summarizedMeetings: '已总结会议', tagKinds: '标签种类',
    searchTags: '搜索标签…', rename: '重命名或合并', delete: '删除标签',
    renameHelp: '如果输入一个已经存在的标签名称，两者会自动合并。所有相关会议都会同步更新。',
    newName: '新标签名称', cancel: '取消', save: '保存', confirmDelete: '确认删除',
    deleteHelp: '将从所有会议总结的标签列表中移除“{name}”。总结正文不会被删除。',
    coverage: '覆盖', meetingsUnit: '条会议', occurrences: '次', localOnly: '完全本机处理',
  },
  en: {
    title: 'Corpus Analytics', subtitle: 'Discover recurring language, topic patterns, and communication habits',
    analysis: 'Analytics', tags: 'Tag manager', privacyTitle: 'Authorize on-device corpus analysis',
    privacyBody: 'Snack Meet will read transcripts in the selected scope and compute aggregate statistics only on this Mac. Source text is never sent to AI, the cloud, or third parties, and results are not uploaded.',
    privacyPoint1: 'Text is read only after you click Analyze', privacyPoint2: 'Only aggregate word and chart data is returned',
    privacyPoint3: 'Revoke access and clear results at any time', authorize: 'Authorize on-device analysis', revoke: 'Revoke access',
    scope: 'Scope', all: 'All meetings', folder: 'Folder', tag: 'Tag',
    textSource: 'Text source', translated: 'Full transcript', original: 'Original segments', both: 'Combine both',
    engine: 'Analysis method', fastEngine: 'Fast local statistics', fastEngineHint: 'Enhanced stop-word and fragment filtering; no model used',
    localAiEngine: 'Local AI refinement', localAiHint: 'Uses Built-in AI or a genuinely local Ollama model',
    summaryAiEngine: 'Summary model / API', summaryAiHint: 'Requires separate consent before excerpts can be sent',
    notLocalModel: 'The configured summary model is not fully local', configureLocal: 'Choose Built-in AI or a local Ollama model in Settings',
    aiInsights: 'Patterns identified by AI',
    start: 'Analyze', analyzing: 'Analyzing on this Mac…', refresh: 'Analyze again', chooseFolder: 'Choose a folder', chooseTag: 'Choose a tag',
    meetings: 'Meetings', characters: 'Characters', vocabulary: 'Candidate terms', questions: 'Questions',
    wordWall: 'Word cloud', wordWallHint: 'Larger terms occur more often. Hover to see occurrences and meeting coverage.',
    topWords: 'Top terms', monthly: 'Monthly text activity', weekdays: 'Weekday pattern', timeOfDay: 'Meeting times',
    habits: 'Speech habits', habitsHint: 'Fillers are normalized per 10,000 characters for easier comparison.',
    noData: 'No analyzable text in this scope', noTags: 'No smart tags yet. Tags appear after meetings are summarized.',
    tagStats: 'Tag overview', taggedMeetings: 'Tagged meetings', summarizedMeetings: 'Summarized meetings', tagKinds: 'Unique tags',
    searchTags: 'Search tags…', rename: 'Rename or merge', delete: 'Delete tag',
    renameHelp: 'Entering an existing tag name merges both tags and updates every related meeting.',
    newName: 'New tag name', cancel: 'Cancel', save: 'Save', confirmDelete: 'Delete tag',
    deleteHelp: 'Remove “{name}” from every meeting summary. Summary content will remain unchanged.',
    coverage: 'Coverage', meetingsUnit: 'meetings', occurrences: 'times', localOnly: 'On-device only',
  },
} as const;

function formatNumber(value: number, locale: string) {
  return new Intl.NumberFormat(locale).format(value);
}

function MiniBarChart({ data, metric = 'characterCount' }: { data: ChartBucket[]; metric?: 'characterCount' | 'meetingCount' }) {
  const visible = data.slice(-12);
  const max = Math.max(1, ...visible.map((item) => item[metric]));
  return (
    <div className="flex h-44 items-end gap-2 pt-5">
      {visible.map((item) => {
        const value = item[metric];
        const height = value === 0 ? 3 : Math.max(8, (value / max) * 132);
        return (
          <div key={item.label} className="group flex min-w-0 flex-1 flex-col items-center gap-2">
            <div className="relative flex h-32 w-full items-end justify-center">
              <div className="absolute -top-5 hidden whitespace-nowrap rounded bg-gray-900 px-2 py-1 text-[10px] text-white group-hover:block">
                {value.toLocaleString()}
              </div>
              <div className="w-full max-w-10 rounded-t-md bg-gradient-to-t from-indigo-500 to-violet-400 transition-all" style={{ height }} />
            </div>
            <span className="max-w-full truncate text-[10px] text-gray-500">{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function WordCloud({ words }: { words: WordFrequency[] }) {
  const visible = words.slice(0, 60);
  const max = Math.max(1, ...visible.map((word) => word.count));
  const palette = ['text-indigo-700', 'text-violet-600', 'text-blue-600', 'text-emerald-600', 'text-rose-600', 'text-amber-600'];
  return (
    <div className="flex min-h-64 flex-wrap content-center items-center justify-center gap-x-5 gap-y-3 rounded-2xl bg-gradient-to-br from-indigo-50 via-white to-violet-50 p-7">
      {visible.map((item, index) => {
        const size = 13 + Math.sqrt(item.count / max) * 34;
        return (
          <span
            key={item.word}
            className={`${palette[index % palette.length]} cursor-default font-semibold leading-none transition-transform hover:scale-110`}
            style={{ fontSize: `${size}px`, opacity: 0.7 + (item.count / max) * 0.3 }}
            title={`${item.count} 次 · ${item.meetingCount} 条会议`}
          >
            {item.word}
          </span>
        );
      })}
    </div>
  );
}

export function CorpusAnalytics() {
  const { locale } = useLocale();
  const text = copy[locale];
  const { collections, refetchMeetings } = useSidebar();
  const [authorized, setAuthorized] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [tab, setTab] = useState<'analysis' | 'tags'>('analysis');
  const [tags, setTags] = useState<TagDashboard | null>(null);
  const [tagSearch, setTagSearch] = useState('');
  const [scope, setScope] = useState<'all' | 'collection' | 'tag'>('all');
  const [collectionId, setCollectionId] = useState('');
  const [tag, setTag] = useState('');
  const [textSource, setTextSource] = useState<'translated' | 'original' | 'both'>('translated');
  const [analysisEngine, setAnalysisEngine] = useState<'fast' | 'local-ai'>('fast');
  const [aiStatus, setAiStatus] = useState<CorpusAiStatus | null>(null);
  const [result, setResult] = useState<CorpusAnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [tagLoading, setTagLoading] = useState(false);
  const [renameTarget, setRenameTarget] = useState<TagStat | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<TagStat | null>(null);

  useEffect(() => {
    setAuthorized(localStorage.getItem(CONSENT_KEY) === 'granted');
  }, []);

  const loadTags = async () => {
    try {
      setTagLoading(true);
      setTags(await invoke<TagDashboard>('api_get_tag_dashboard'));
    } catch (error) {
      toast.error(String(error));
    } finally {
      setTagLoading(false);
    }
  };

  useEffect(() => {
    if (authorized) {
      void loadTags();
      void invoke<CorpusAiStatus>('api_get_corpus_ai_status').then(setAiStatus).catch(() => setAiStatus(null));
    }
  }, [authorized]);

  const authorize = () => {
    if (!consentChecked) return;
    localStorage.setItem(CONSENT_KEY, 'granted');
    setAuthorized(true);
  };

  const revoke = () => {
    localStorage.removeItem(CONSENT_KEY);
    setAuthorized(false);
    setConsentChecked(false);
    setResult(null);
    setTags(null);
  };

  const analyze = async () => {
    if (scope === 'collection' && !collectionId) return toast.error(text.chooseFolder);
    if (scope === 'tag' && !tag) return toast.error(text.chooseTag);
    try {
      setLoading(true);
      const data = await invoke<CorpusAnalysisResult>('api_analyze_corpus', {
        consent: true,
        scope,
        collectionId: scope === 'collection' ? collectionId : null,
        tag: scope === 'tag' ? tag : null,
        textSource,
        analysisEngine,
      });
      setResult(data);
      if (data.overview.meetingCount === 0) toast.info(text.noData);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setLoading(false);
    }
  };

  const saveRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    try {
      await invoke('api_rename_tag', { oldName: renameTarget.name, newName: renameValue.trim() });
      toast.success(locale === 'zh-CN' ? '标签已更新' : 'Tag updated');
      setRenameTarget(null);
      setRenameValue('');
      await Promise.all([loadTags(), refetchMeetings()]);
      setResult(null);
    } catch (error) {
      toast.error(String(error));
    }
  };

  const deleteTag = async () => {
    if (!deleteTarget) return;
    try {
      await invoke('api_delete_tag', { name: deleteTarget.name });
      toast.success(locale === 'zh-CN' ? '标签已删除' : 'Tag deleted');
      setDeleteTarget(null);
      await Promise.all([loadTags(), refetchMeetings()]);
      setResult(null);
    } catch (error) {
      toast.error(String(error));
    }
  };

  const filteredTags = useMemo(() => {
    const query = tagSearch.trim().toLowerCase();
    return (tags?.tags || []).filter((item) => !query || item.name.toLowerCase().includes(query));
  }, [tagSearch, tags]);

  if (!authorized) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 p-8">
        <div className="w-full max-w-2xl rounded-3xl border border-indigo-100 bg-white p-9 shadow-sm">
          <div className="mb-6 flex items-start justify-between">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-100 text-indigo-700"><LockKeyhole className="h-7 w-7" /></div>
            <LanguageToggle />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{text.privacyTitle}</h1>
          <p className="mt-3 leading-7 text-gray-600">{text.privacyBody}</p>
          <div className="my-7 space-y-3 rounded-2xl bg-emerald-50 p-5 text-sm text-emerald-900">
            {[text.privacyPoint1, text.privacyPoint2, text.privacyPoint3].map((item) => (
              <div key={item} className="flex items-center gap-3"><ShieldCheck className="h-5 w-5 shrink-0" />{item}</div>
            ))}
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 p-4 text-sm text-gray-700">
            <input type="checkbox" checked={consentChecked} onChange={(event) => setConsentChecked(event.target.checked)} className="mt-0.5 h-4 w-4 accent-indigo-600" />
            <span>{locale === 'zh-CN' ? '我理解并同意 Snack Meet 在本机读取所选会议文字并生成聚合分析。' : 'I understand and allow Snack Meet to read selected meeting text on this Mac for aggregate analysis.'}</span>
          </label>
          <button onClick={authorize} disabled={!consentChecked} className="mt-5 w-full rounded-xl bg-indigo-600 px-5 py-3 font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">
            {text.authorize}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen overflow-y-auto bg-gray-50">
      <div className="mx-auto max-w-7xl px-8 py-8">
        <header className="mb-7 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3"><div className="rounded-xl bg-indigo-100 p-2.5 text-indigo-700"><BarChart3 className="h-6 w-6" /></div><h1 className="text-3xl font-bold text-gray-900">{text.title}</h1></div>
            <p className="mt-2 text-gray-500">{text.subtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700"><ShieldCheck className="h-4 w-4" />{text.localOnly}</span>
            <LanguageToggle />
            <button onClick={revoke} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-500 hover:text-red-600">{text.revoke}</button>
          </div>
        </header>

        <div className="mb-6 inline-flex rounded-xl bg-gray-200/70 p-1">
          <button onClick={() => setTab('analysis')} className={`flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-medium ${tab === 'analysis' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-600'}`}><Activity className="h-4 w-4" />{text.analysis}</button>
          <button onClick={() => setTab('tags')} className={`flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-medium ${tab === 'tags' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-600'}`}><Tags className="h-4 w-4" />{text.tags}</button>
        </div>

        {tab === 'analysis' ? (
          <div className="space-y-6">
            <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="grid gap-4 lg:grid-cols-[1fr_1fr_1fr_auto]">
                <label className="text-sm font-medium text-gray-700">{text.scope}
                  <select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)} className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 font-normal">
                    <option value="all">{text.all}</option><option value="collection">{text.folder}</option><option value="tag">{text.tag}</option>
                  </select>
                </label>
                {scope === 'collection' ? (
                  <label className="text-sm font-medium text-gray-700">{text.folder}
                    <select value={collectionId} onChange={(event) => setCollectionId(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 font-normal">
                      <option value="">{text.chooseFolder}</option>{collections.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.meetingCount})</option>)}
                    </select>
                  </label>
                ) : scope === 'tag' ? (
                  <label className="text-sm font-medium text-gray-700">{text.tag}
                    <select value={tag} onChange={(event) => setTag(event.target.value)} className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 font-normal">
                      <option value="">{text.chooseTag}</option>{(tags?.tags || []).map((item) => <option key={item.name} value={item.name}>{item.name} ({item.meetingCount})</option>)}
                    </select>
                  </label>
                ) : <div />}
                <label className="text-sm font-medium text-gray-700">{text.textSource}
                  <select value={textSource} onChange={(event) => setTextSource(event.target.value as typeof textSource)} className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 font-normal">
                    <option value="translated">{text.translated}</option><option value="original">{text.original}</option><option value="both">{text.both}</option>
                  </select>
                </label>
                <button onClick={analyze} disabled={loading} className="mt-auto inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-5 text-sm font-medium text-white disabled:opacity-50">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : result ? <RefreshCw className="h-4 w-4" /> : <BarChart3 className="h-4 w-4" />}{loading ? text.analyzing : result ? text.refresh : text.start}
                </button>
              </div>
              <div className="mt-5 border-t border-gray-100 pt-5">
                <div className="mb-3 text-sm font-medium text-gray-700">{text.engine}</div>
                <div className="grid gap-3 lg:grid-cols-3">
                  <button onClick={() => setAnalysisEngine('fast')} className={`rounded-xl border p-4 text-left transition ${analysisEngine === 'fast' ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500' : 'border-gray-200 hover:border-gray-300'}`}>
                    <div className="flex items-center gap-2 font-medium text-gray-900"><BarChart3 className="h-4 w-4 text-indigo-600" />{text.fastEngine}{analysisEngine === 'fast' && <Check className="ml-auto h-4 w-4 text-indigo-600" />}</div>
                    <p className="mt-2 text-xs leading-5 text-gray-500">{text.fastEngineHint}</p>
                  </button>
                  <button disabled={!aiStatus?.isLocal} onClick={() => setAnalysisEngine('local-ai')} className={`rounded-xl border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-55 ${analysisEngine === 'local-ai' ? 'border-violet-500 bg-violet-50 ring-1 ring-violet-500' : 'border-gray-200 hover:border-gray-300'}`}>
                    <div className="flex items-center gap-2 font-medium text-gray-900"><BrainCircuit className="h-4 w-4 text-violet-600" />{text.localAiEngine}{analysisEngine === 'local-ai' && <Check className="ml-auto h-4 w-4 text-violet-600" />}</div>
                    <p className="mt-2 text-xs leading-5 text-gray-500">{aiStatus?.isLocal ? `${text.localAiHint} · ${aiStatus.model || aiStatus.provider}` : `${text.notLocalModel} · ${text.configureLocal}`}</p>
                  </button>
                  <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-4 text-left opacity-70">
                    <div className="flex items-center gap-2 font-medium text-gray-700"><LockKeyhole className="h-4 w-4" />{text.summaryAiEngine}</div>
                    <p className="mt-2 text-xs leading-5 text-gray-500">{text.summaryAiHint}</p>
                  </div>
                </div>
              </div>
            </section>

            {result && (
              <>
                <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  {[
                    { label: text.meetings, value: result.overview.meetingCount, Icon: FileText, iconClass: 'bg-indigo-50 text-indigo-600' },
                    { label: text.characters, value: formatNumber(result.overview.characterCount, locale), Icon: Type, iconClass: 'bg-violet-50 text-violet-600' },
                    { label: text.vocabulary, value: formatNumber(result.overview.uniqueTermCount, locale), Icon: Hash, iconClass: 'bg-emerald-50 text-emerald-600' },
                    { label: text.questions, value: formatNumber(result.overview.questionCount, locale), Icon: MessageCircleQuestion, iconClass: 'bg-amber-50 text-amber-600' },
                  ].map(({ label, value, Icon, iconClass }) => (
                    <div key={label} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                      <div className={`mb-4 inline-flex rounded-lg p-2 ${iconClass}`}><Icon className="h-5 w-5" /></div>
                      <div className="text-2xl font-bold text-gray-900">{value}</div><div className="mt-1 text-sm text-gray-500">{label}</div>
                    </div>
                  ))}
                </section>

                {result.aiRefinement?.insights?.length ? (
                  <section className="rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white p-6 shadow-sm">
                    <h2 className="flex items-center gap-2 text-lg font-semibold text-violet-900"><BrainCircuit className="h-5 w-5" />{text.aiInsights}</h2>
                    <div className="mt-4 grid gap-3 md:grid-cols-2">{result.aiRefinement.insights.map((insight, index) => (
                      <div key={`${index}-${insight}`} className="rounded-xl border border-violet-100 bg-white p-4 text-sm leading-6 text-gray-700"><span className="mr-2 font-semibold text-violet-500">{index + 1}.</span>{insight}</div>
                    ))}</div>
                  </section>
                ) : null}

                {result.words.length > 0 ? (
                  <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                    <h2 className="text-lg font-semibold text-gray-900">{text.wordWall}</h2><p className="mb-5 mt-1 text-sm text-gray-500">{text.wordWallHint}</p><WordCloud words={result.words} />
                  </section>
                ) : <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-12 text-center text-gray-500">{text.noData}</div>}

                <section className="grid gap-6 xl:grid-cols-2">
                  <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm"><h2 className="text-lg font-semibold">{text.monthly}</h2><MiniBarChart data={result.monthlyActivity} /></div>
                  <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm"><h2 className="text-lg font-semibold">{text.weekdays}</h2><MiniBarChart data={result.weekdayActivity} /></div>
                  <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm"><h2 className="text-lg font-semibold">{text.timeOfDay}</h2><MiniBarChart data={result.timeOfDayActivity} /></div>
                  <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                    <h2 className="text-lg font-semibold">{text.habits}</h2><p className="mt-1 text-sm text-gray-500">{text.habitsHint}</p>
                    <div className="mt-5 space-y-3">{result.habits.length ? result.habits.slice(0, 8).map((habit) => (
                      <div key={habit.label} className="flex items-center gap-3"><span className="w-20 truncate text-sm font-medium text-gray-700">{habit.label}</span><div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100"><div className="h-full rounded-full bg-rose-400" style={{ width: `${Math.min(100, habit.perTenThousandChars * 5)}%` }} /></div><span className="w-28 text-right text-xs text-gray-500">{habit.count} {text.occurrences} · {habit.perTenThousandChars.toFixed(1)}/万字</span></div>
                    )) : <p className="text-sm text-gray-400">—</p>}</div>
                  </div>
                </section>

                <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                  <h2 className="mb-4 text-lg font-semibold">{text.topWords}</h2>
                  <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">{result.words.slice(0, 20).map((word, index) => (
                    <div key={word.word} className="flex items-center gap-3 text-sm"><span className="w-6 text-gray-400">{index + 1}</span><span className="min-w-0 flex-1 truncate font-medium text-gray-800">{word.word}</span><span className="text-gray-500">{word.count} {text.occurrences}</span><span className="w-20 text-right text-xs text-gray-400">{word.meetingCount} {text.meetingsUnit}</span></div>
                  ))}</div>
                </section>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            <section className="grid gap-4 sm:grid-cols-3">
              {[
                { label: text.tagKinds, value: tags?.tags.length || 0, Icon: Tags },
                { label: text.taggedMeetings, value: tags?.taggedMeetingCount || 0, Icon: Check },
                { label: text.summarizedMeetings, value: tags?.summarizedMeetingCount || 0, Icon: FileText },
              ].map(({ label, value, Icon }) => <div key={label} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"><Icon className="mb-3 h-5 w-5 text-indigo-600" /><div className="text-2xl font-bold">{value}</div><div className="mt-1 text-sm text-gray-500">{label}</div></div>)}
            </section>
            <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-gray-100 p-5"><div><h2 className="text-lg font-semibold">{text.tagStats}</h2><p className="mt-1 text-sm text-gray-500">{text.renameHelp}</p></div><button onClick={() => void loadTags()} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100">{tagLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <RefreshCw className="h-5 w-5" />}</button></div>
              <div className="p-5"><div className="relative mb-4"><Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" /><input value={tagSearch} onChange={(event) => setTagSearch(event.target.value)} placeholder={text.searchTags} className="w-full rounded-lg border border-gray-200 py-2 pl-9 pr-3 text-sm" /></div>
                {filteredTags.length ? <div className="divide-y divide-gray-100">{filteredTags.map((item) => (
                  <div key={item.name} className="group flex items-center gap-4 py-3"><span className="inline-flex rounded-full bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-700"># {item.name}</span><div className="flex-1"><div className="h-2 overflow-hidden rounded-full bg-gray-100"><div className="h-full rounded-full bg-indigo-400" style={{ width: `${Math.max(3, item.percentage)}%` }} /></div></div><span className="w-32 text-right text-xs text-gray-500">{item.meetingCount} {text.meetingsUnit} · {text.coverage} {item.percentage.toFixed(1)}%</span><button onClick={() => { setRenameTarget(item); setRenameValue(item.name); }} title={text.rename} className="rounded p-2 text-gray-400 hover:bg-indigo-50 hover:text-indigo-600"><Edit3 className="h-4 w-4" /></button><button onClick={() => setDeleteTarget(item)} title={text.delete} className="rounded p-2 text-gray-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button></div>
                ))}</div> : <div className="py-16 text-center text-sm text-gray-400">{text.noTags}</div>}
              </div>
            </section>
          </div>
        )}
      </div>

      <Dialog open={!!renameTarget} onOpenChange={(open) => { if (!open) setRenameTarget(null); }}><DialogContent><DialogTitle>{text.rename}</DialogTitle><p className="text-sm text-gray-500">{text.renameHelp}</p><label className="text-sm font-medium text-gray-700">{text.newName}<input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveRename(); }} className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2" /></label><DialogFooter><button onClick={() => setRenameTarget(null)} className="rounded-lg border px-4 py-2 text-sm">{text.cancel}</button><button onClick={() => void saveRename()} disabled={!renameValue.trim()} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white disabled:opacity-40">{text.save}</button></DialogFooter></DialogContent></Dialog>
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}><DialogContent><DialogTitle>{text.confirmDelete}</DialogTitle><p className="text-sm leading-6 text-gray-600">{text.deleteHelp.replace('{name}', deleteTarget?.name || '')}</p><DialogFooter><button onClick={() => setDeleteTarget(null)} className="rounded-lg border px-4 py-2 text-sm">{text.cancel}</button><button onClick={() => void deleteTag()} className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white">{text.confirmDelete}</button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}
