'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type UiLocale = 'zh-CN' | 'en';

const messages = {
  'zh-CN': {
    language: '语言', chinese: '中文', english: 'English',
    meetings: '会议记录', meetingsSubtitle: '管理、总览和翻阅你的全部会议记录',
    searchMeetings: '搜索会议标题…', globalSearchPlaceholder: '搜索标题、转写全文、原文和总结…',
    searching: '正在搜索…', noSearchResults: '没有找到匹配的会议', tryAnotherKeyword: '换个关键词试试',
    matchedTitle: '标题', matchedTranscript: '转写全文', matchedOriginal: '原文', matchedSummary: '总结',
    matchingSegments: '个内容片段命中', refresh: '更新扫描', refreshing: '扫描中…',
    selectAll: '全选', deleteAudio: '删除音频', delete: '删除', rename: '重命名',
    audioKept: '音频已保留', documentsOnly: '仅文档', viewRecord: '查看记录',
    importAudio: '导入音频', selectAudio: '选择一个或多个音频文件', chooseDifferent: '重新选择文件',
    importDescription: '支持一次选择一个或多个音频；多个文件会排队保存到同步文件夹，不会自动转写',
    meetingTitle: '会议名称', cancel: '取消', settings: '设置', back: '返回',
    general: '通用', recordings: '录音', transcription: '转写', summary: '总结', beta: '实验功能',
    startTranscription: '开始转写', retranscribe: '重新转译', localModel: '本地模型',
    batchTranscribe: '批量转写', batchSummarize: '批量总结',
    allMeetings: '全部会议', inbox: '未分类', favorites: '收藏', archived: '已归档', myFolders: '我的文件夹',
    newFolder: '新建文件夹', renameFolder: '重命名文件夹', deleteFolder: '删除文件夹', folderName: '文件夹名称',
    createFirstFolder: '创建第一个文件夹', save: '保存', saving: '保存中…', folderSaveFailed: '保存文件夹失败',
    folderDeleteFailed: '删除文件夹失败', folderDeletedMeetingsMoved: '文件夹已删除，其中的会议已移回未分类',
    deleteFolderDescription: '确定删除「{name}」吗？会议和录音不会被删除，将自动移回未分类。', deleteFolderOnly: '只删除文件夹',
    moveTo: '移动到', moveSelected: '移动已选', moveSuccess: '会议已移动', moveFailed: '移动会议失败',
    addFavorite: '添加收藏', removeFavorite: '取消收藏', archive: '归档', restoreArchive: '恢复到资料库',
    corpusAnalytics: '语料与标签分析',
  },
  en: {
    language: 'Language', chinese: '中文', english: 'English',
    meetings: 'Meetings', meetingsSubtitle: 'Manage, review, and revisit every meeting.',
    searchMeetings: 'Search meetings…', globalSearchPlaceholder: 'Search titles, full transcripts, original text, and summaries…',
    searching: 'Searching…', noSearchResults: 'No matching meetings found', tryAnotherKeyword: 'Try another keyword',
    matchedTitle: 'Title', matchedTranscript: 'Full transcript', matchedOriginal: 'Original text', matchedSummary: 'Summary',
    matchingSegments: 'matching content segments', refresh: 'Refresh', refreshing: 'Scanning…',
    selectAll: 'Select all', deleteAudio: 'Delete audio', delete: 'Delete', rename: 'Rename',
    audioKept: 'Audio kept', documentsOnly: 'Documents only', viewRecord: 'View record',
    importAudio: 'Import audio', selectAudio: 'Select one or more audio files', chooseDifferent: 'Choose files again',
    importDescription: 'Select one or many audio files. Multiple files are queued and saved to the sync folder without automatic transcription.',
    meetingTitle: 'Meeting title', cancel: 'Cancel', settings: 'Settings', back: 'Back',
    general: 'General', recordings: 'Recordings', transcription: 'Transcription', summary: 'Summary', beta: 'Beta',
    startTranscription: 'Start transcription', retranscribe: 'Retranscribe', localModel: 'Local model',
    batchTranscribe: 'Batch transcribe', batchSummarize: 'Batch summarize',
    allMeetings: 'All meetings', inbox: 'Unfiled', favorites: 'Favorites', archived: 'Archived', myFolders: 'My folders',
    newFolder: 'New folder', renameFolder: 'Rename folder', deleteFolder: 'Delete folder', folderName: 'Folder name',
    createFirstFolder: 'Create your first folder', save: 'Save', saving: 'Saving…', folderSaveFailed: 'Could not save folder',
    folderDeleteFailed: 'Could not delete folder', folderDeletedMeetingsMoved: 'Folder deleted; its meetings were moved to Unfiled',
    deleteFolderDescription: 'Delete “{name}”? Meetings and recordings will not be deleted; they will move to Unfiled.', deleteFolderOnly: 'Delete folder only',
    moveTo: 'Move to', moveSelected: 'Move selected', moveSuccess: 'Meetings moved', moveFailed: 'Could not move meetings',
    addFavorite: 'Add to favorites', removeFavorite: 'Remove favorite', archive: 'Archive', restoreArchive: 'Restore to library',
    corpusAnalytics: 'Corpus & tag analytics',
  },
} as const;

type TranslationKey = keyof typeof messages['zh-CN'];
interface LocaleContextValue {
  locale: UiLocale;
  setLocale: (locale: UiLocale) => void;
  toggleLocale: () => void;
  t: (key: TranslationKey) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<UiLocale>(() =>
    typeof window !== 'undefined' && localStorage.getItem('snackmeet-ui-locale') === 'en' ? 'en' : 'zh-CN'
  );
  const setLocale = useCallback((next: UiLocale) => setLocaleState(next), []);
  const toggleLocale = useCallback(() => setLocaleState(current => current === 'zh-CN' ? 'en' : 'zh-CN'), []);

  useEffect(() => {
    localStorage.setItem('snackmeet-ui-locale', locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale, toggleLocale, t: (key: TranslationKey) => messages[locale][key] }), [locale, setLocale, toggleLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) throw new Error('useLocale must be used within LocaleProvider');
  return context;
}
