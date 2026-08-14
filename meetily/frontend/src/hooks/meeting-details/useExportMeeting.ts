import { useCallback, RefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Transcript, Summary } from '@/types';
import { BlockNoteSummaryViewRef } from '@/components/AISummary/BlockNoteSummaryView';
import { toast } from 'sonner';

interface UseExportMeetingProps {
  meeting: {
    id: string;
    title: string;
    created_at: string;
  };
  meetingTitle: string;
  aiSummary: Summary | null;
  blockNoteSummaryRef: RefObject<BlockNoteSummaryViewRef>;
}

/**
 * Export a meeting (transcript + summary) to a Markdown file.
 * The backend opens the native save dialog and writes only to the path that
 * the user grants through that dialog.
 */
export function useExportMeeting({
  meeting,
  meetingTitle,
  aiSummary,
  blockNoteSummaryRef,
}: UseExportMeetingProps) {
  // Fetch ALL transcripts from the database (not just the paginated slice)
  const fetchAllTranscripts = useCallback(async (meetingId: string): Promise<Transcript[]> => {
    try {
      const firstPage = await invoke('api_get_meeting_transcripts', {
        meetingId,
        limit: 1,
        offset: 0,
      }) as { transcripts: Transcript[]; total_count: number; has_more: boolean };

      const totalCount = firstPage.total_count;
      if (totalCount === 0) return [];

      const allData = await invoke('api_get_meeting_transcripts', {
        meetingId,
        limit: totalCount,
        offset: 0,
      }) as { transcripts: Transcript[]; total_count: number; has_more: boolean };

      return allData.transcripts;
    } catch (error) {
      console.error('❌ Error fetching all transcripts for export:', error);
      return [];
    }
  }, []);

  // Build the summary markdown section (mirrors useCopyOperations logic)
  const buildSummaryMarkdown = useCallback(async (): Promise<string> => {
    let summaryMarkdown = '';

    if (blockNoteSummaryRef.current?.getMarkdown) {
      summaryMarkdown = await blockNoteSummaryRef.current.getMarkdown();
    }

    const summaryRecord = aiSummary as unknown as Record<string, unknown> | null;
    if (!summaryMarkdown && typeof summaryRecord?.markdown === 'string') {
      summaryMarkdown = summaryRecord.markdown;
    }

    if (!summaryMarkdown && summaryRecord) {
      const sections = Object.entries(summaryRecord)
        .filter(([key]) => {
          return key !== 'markdown' && key !== 'summary_json' && key !== '_section_order' && key !== 'MeetingName';
        })
        .map(([, section]) => {
          if (section && typeof section === 'object' && 'title' in section && 'blocks' in section) {
            const candidate = section as { title: unknown; blocks: unknown };
            if (typeof candidate.title !== 'string' || !Array.isArray(candidate.blocks)) return '';

            const sectionTitle = `## ${candidate.title}\n\n`;
            const sectionContent = candidate.blocks
              .map((block: unknown) => {
                if (!block || typeof block !== 'object' || !('content' in block)) return '';
                const content = (block as { content: unknown }).content;
                return typeof content === 'string' ? `- ${content}` : '';
              })
              .filter(Boolean)
              .join('\n');
            return sectionTitle + sectionContent;
          }
          return '';
        })
        .filter(s => s.trim())
        .join('\n\n');
      summaryMarkdown = sections;
    }

    return summaryMarkdown.trim();
  }, [aiSummary, blockNoteSummaryRef]);

  // Format a transcript timestamp as recording-relative [MM:SS]
  const formatTime = useCallback((seconds: number | undefined, fallbackTimestamp: string): string => {
    if (seconds === undefined) return fallbackTimestamp;
    const totalSecs = Math.floor(seconds);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `[${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
  }, []);

  const handleExportMarkdown = useCallback(async () => {
    try {
      const allTranscripts = await fetchAllTranscripts(meeting.id);
      const summaryMarkdown = await buildSummaryMarkdown();

      if (allTranscripts.length === 0 && !summaryMarkdown) {
        toast.error('Nothing to export — no transcript or summary available');
        return;
      }

      // Sanitize title for filename
      const safeTitle = (meetingTitle || meeting.title || 'meeting')
        .replace(/[\\/:*?"<>|]/g, '-')
        .trim() || 'meeting';

      // Build the full markdown document
      const lines: string[] = [];
      lines.push(`# ${meetingTitle || meeting.title || '未命名会议'}`);
      lines.push('');
      lines.push(`> 会议 ID: ${meeting.id}`);
      lines.push(`> 日期: ${new Date(meeting.created_at).toLocaleString('zh-CN')}`);
      lines.push(`> 导出时间: ${new Date().toLocaleString('zh-CN')}`);
      lines.push('');

      if (summaryMarkdown) {
        lines.push('---');
        lines.push('');
        lines.push('## 会议总结');
        lines.push('');
        lines.push(summaryMarkdown);
        lines.push('');
      }

      if (allTranscripts.length > 0) {
        lines.push('---');
        lines.push('');
        lines.push('## 完整转写');
        lines.push('');
        allTranscripts.forEach((t) => {
          const speaker = t.speaker ? `**[${t.speaker}]** ` : '';
          lines.push(`${formatTime(t.audio_start_time, t.timestamp)} ${speaker}${t.text}`);
        });
        lines.push('');
      }

      const content = lines.join('\n');

      const filePath = await invoke<string | null>('save_transcript', {
        suggestedName: safeTitle,
        content,
      });

      if (!filePath) return; // user cancelled the native save dialog

      toast.success('会议已导出为 Markdown', {
        description: filePath,
      });
    } catch (error) {
      console.error('❌ Failed to export meeting:', error);
      toast.error('导出失败', {
        description: error instanceof Error ? error.message : '未知错误',
      });
    }
  }, [meeting, meetingTitle, fetchAllTranscripts, buildSummaryMarkdown, formatTime]);

  return { handleExportMarkdown };
}
