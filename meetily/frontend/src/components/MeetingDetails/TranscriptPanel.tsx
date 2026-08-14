"use client";

import { Transcript, TranscriptSegmentData } from '@/types';
import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { TranscriptButtonGroup } from './TranscriptButtonGroup';
import { useCallback, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { AudioTranscriptPlayer } from './AudioTranscriptPlayer';
import { SpeakerManager } from './SpeakerManager';

interface TranscriptPanelProps {
  transcripts: Transcript[];
  customPrompt: string;
  onPromptChange: (value: string) => void;
  onCopyTranscript: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  isRecording: boolean;
  disableAutoScroll?: boolean;

  // Optional pagination props (when using virtualization)
  usePagination?: boolean;
  segments?: TranscriptSegmentData[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;

  // Retranscription props
  meetingId?: string;
  meetingFolderPath?: string | null;
  audioPath?: string | null;
  onRefetchTranscripts?: () => Promise<void>;
}

export function TranscriptPanel({
  transcripts,
  customPrompt,
  onPromptChange,
  onCopyTranscript,
  onOpenMeetingFolder,
  isRecording,
  disableAutoScroll = false,
  usePagination = false,
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
  meetingId,
  meetingFolderPath,
  audioPath,
  onRefetchTranscripts,
}: TranscriptPanelProps) {
  const [playbackTime, setPlaybackTime] = useState(0);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [seekRequest, setSeekRequest] = useState<number | null>(null);
  // Speaker management state
  const [speakerOptions, setSpeakerOptions] = useState<string[]>([]);
  const [editingSpeakers, setEditingSpeakers] = useState(false);
  const [speakerRefresh, setSpeakerRefresh] = useState(0);
  const handleAudioTimeChange = useCallback((seconds: number) => setPlaybackTime(seconds), []);
  const handlePlayingChange = useCallback((playing: boolean) => setIsAudioPlaying(playing), []);
  const seekToSubtitle = useCallback((seconds: number) => {
    setSeekRequest(null);
    requestAnimationFrame(() => setSeekRequest(seconds));
  }, []);

  // Reassign a single transcript segment to another speaker.
  const handleSegmentSpeakerChange = useCallback(async (segmentId: string, speaker: string) => {
    if (!meetingId) return;
    try {
      await invoke('api_update_transcript_speaker', {
        meetingId,
        transcriptId: segmentId,
        speaker,
      });
      toast.success('该段说话人已更新');
      setSpeakerRefresh((k) => k + 1);
      if (onRefetchTranscripts) await onRefetchTranscripts();
    } catch (error) {
      console.error('Failed to update segment speaker:', error);
      toast.error('更新说话人失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [meetingId, onRefetchTranscripts]);
  // Convert transcripts to segments if pagination is not used but we want virtualization
  const convertedSegments = useMemo(() => {
    if (usePagination && segments) {
      return segments;
    }
    // Convert transcripts to segments for virtualization
    return transcripts.map(t => ({
      id: t.id,
      timestamp: t.audio_start_time ?? 0,
      endTime: t.audio_end_time,
      text: t.text,
      confidence: t.confidence,
      speaker: t.speaker,
    }));
  }, [transcripts, usePagination, segments]);

  return (
    <div className="flex h-1/2 w-full min-w-0 shrink-0 flex-col border-b border-gray-200 bg-white md:h-auto md:w-1/4 md:border-b-0 md:border-r lg:w-1/3">
      {/* Title area */}
      <div className="p-4 border-b border-gray-200">
        <TranscriptButtonGroup
          transcriptCount={usePagination ? (totalCount ?? convertedSegments.length) : (transcripts?.length || 0)}
          onCopyTranscript={onCopyTranscript}
          onOpenMeetingFolder={onOpenMeetingFolder}
          meetingId={meetingId}
          meetingFolderPath={meetingFolderPath}
          onRefetchTranscripts={onRefetchTranscripts}
        />
        {audioPath && (
          <AudioTranscriptPlayer
            audioPath={audioPath}
            onTimeChange={handleAudioTimeChange}
            onPlayingChange={handlePlayingChange}
            seekRequest={seekRequest}
          />
        )}
      </div>

      {/* Transcript content - use virtualized view for better performance */}
      <div className="flex-1 overflow-hidden pb-4 flex flex-col min-h-0">
        {meetingId && convertedSegments.some((s) => s.speaker) && (
          <div className="shrink-0">
            <SpeakerManager
              meetingId={meetingId}
              refreshTrigger={speakerRefresh}
              onSpeakersChange={setSpeakerOptions}
              onEditingChange={setEditingSpeakers}
            />
          </div>
        )}
        <div className="flex-1 overflow-hidden">
          <VirtualizedTranscriptView
            segments={convertedSegments}
            isRecording={isRecording}
            isPaused={false}
            isProcessing={false}
            isStopping={false}
            enableStreaming={false}
            showConfidence={true}
            disableAutoScroll={disableAutoScroll}
            hasMore={hasMore}
            isLoadingMore={isLoadingMore}
            totalCount={totalCount}
            loadedCount={loadedCount}
            onLoadMore={onLoadMore}
            playbackTime={audioPath ? playbackTime : undefined}
            isAudioPlaying={isAudioPlaying}
            onSeekTo={audioPath ? seekToSubtitle : undefined}
            speakerOptions={speakerOptions}
            editingSpeakers={editingSpeakers}
            onSegmentSpeakerChange={handleSegmentSpeakerChange}
          />
        </div>
      </div>

      {/* Summary-style instruction. Sent only with the next generated summary. */}
      {!isRecording && convertedSegments.length > 0 && (
        <div className="border-t border-gray-200 bg-slate-50/70 p-3">
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-semibold text-slate-800">定制总结 Prompt</label>
            <span className="text-xs text-slate-500">仅影响下一次生成</span>
          </div>
          <textarea
            placeholder="例如：用投资备忘录风格总结；先写结论；重点关注风险与待办；语气简洁专业。"
            aria-label="定制总结 Prompt"
            className="w-full min-h-[88px] resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            value={customPrompt}
            onChange={(e) => onPromptChange(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
