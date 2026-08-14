import { useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { storageService } from '@/services/storageService';
import {
  applyPinnedSummaryLanguageToMeeting,
  detectAndCacheSummaryLanguage,
} from '@/lib/summary-language-preferences';
import { useConfig } from '@/contexts/ConfigContext';
import {
  forgetDeferredTranscription,
  rememberDeferredTranscription,
} from '@/lib/deferred-transcription';
import {
  isAutoTranscriptionProvider,
  readAutoTranscriptionPreferences,
} from '@/lib/auto-transcription-preferences';

type SummaryStatus = 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';

interface UseRecordingStopReturn {
  handleRecordingStop: (callApi: boolean) => Promise<void>;
  isStopping: boolean;
  isProcessingTranscript: boolean;
  isSavingTranscript: boolean;
  summaryStatus: SummaryStatus;
  setIsStopping: (value: boolean) => void;
}

/**
 * Custom hook for managing recording stop lifecycle.
 * Handles the post-capture sequence: buffer flush → SQLite save → navigation.
 *
 * Features:
 * - Backend-owned transcription finalization (no duplicate frontend polling)
 * - Transcript buffer flush coordination
 * - SQLite meeting save with folder_path from sessionStorage
 * - Auto-navigation to meeting details
 * - Toast notifications for success/error
 * - Window exposure for Rust callbacks
 */
export function useRecordingStop(
  setIsRecording: (value: boolean) => void,
  setIsRecordingDisabled: (value: boolean) => void
): UseRecordingStopReturn {
  // USE global state instead
  const recordingState = useRecordingState();
  const {
    status,
    setStatus,
    isStopping,
    isProcessing: isProcessingTranscript,
    isSaving: isSavingTranscript
  } = recordingState;

  const {
    transcriptsRef,
    flushBuffer,
    clearTranscripts,
    meetingTitle,
    markMeetingAsSaved,
  } = useTranscripts();

  const {
    refetchMeetings,
    setCurrentMeeting,
    setIsMeetingActive,
  } = useSidebar();

  const router = useRouter();
  const { transcriptModelConfig, selectedLanguage } = useConfig();

  // Guard to prevent duplicate/concurrent stop calls (e.g., from UI and tray simultaneously)
  const stopInProgressRef = useRef(false);

  // Promise to track recording-stopped event data (fixes race condition with recording-stop-complete)
  const recordingStoppedDataRef = useRef<Promise<void> | null>(null);

  // Set up recording-stopped listener for meeting navigation
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;

    const setupRecordingStoppedListener = async () => {
      try {
        console.log('Setting up recording-stopped listener for navigation...');
        unlistenFn = await listen<{
          message: string;
          folder_path?: string;
          meeting_name?: string;
        }>('recording-stopped', async (event) => {
          // Create promise that resolves when sessionStorage is set (prevents race condition)
          recordingStoppedDataRef.current = (async () => {
            const { folder_path, meeting_name } = event.payload;

            // Store folder_path and meeting_name for later use in handleRecordingStop
            if (folder_path) {
              sessionStorage.setItem('last_recording_folder_path', folder_path);
            }
            if (meeting_name) {
              sessionStorage.setItem('last_recording_meeting_name', meeting_name);
            }
          })();

        });
        console.log('Recording stopped listener setup complete');
      } catch (error) {
        console.error('Failed to setup recording stopped listener:', error);
      }
    };

    setupRecordingStoppedListener();

    return () => {
      console.log('Cleaning up recording stopped listener...');
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, [router]);

  // Main recording stop handler
  const handleRecordingStop = useCallback(async (isCallApi: boolean) => {
    if (recordingStoppedDataRef.current) {
      await recordingStoppedDataRef.current;
    }

    // Guard: prevent duplicate/concurrent stop calls
    if (stopInProgressRef.current) {
      return;
    }
    stopInProgressRef.current = true;

    // Set status to STOPPING immediately
    setStatus(RecordingStatus.STOPPING);
    setIsRecording(false);
    setIsRecordingDisabled(true);
    const stopStartTime = Date.now();

    try {
      console.log('Post-stop processing (new implementation)...', {
        stop_initiated_at: new Date(stopStartTime).toISOString(),
        current_transcript_count: transcriptsRef.current.length
      });

      // Note: stop_recording is already called by RecordingControls.stopRecordingAction
      // This function only handles post-stop processing (transcription wait, API call, navigation)
      console.log('Recording already stopped by RecordingControls, processing transcription...');

      // stop_recording already drains the backend worker before it resolves.
      // A second frontend polling state machine previously added up to 64 seconds
      // of artificial delay and queried a contradictory status endpoint.
      setStatus(RecordingStatus.PROCESSING_TRANSCRIPTS, 'Finalizing transcript...');
      const transcriptionComplete = true;

      // Final buffer flush: process ALL remaining transcripts regardless of timing
      const flushStartTime = Date.now();
      console.log('🔄 Final buffer flush: forcing processing of any remaining transcripts...', {
        flush_started_at: new Date(flushStartTime).toISOString(),
        time_since_stop: flushStartTime - stopStartTime,
        current_transcript_count: transcriptsRef.current.length
      });
      setStatus(RecordingStatus.PROCESSING_TRANSCRIPTS, 'Flushing transcript buffer...');
      flushBuffer();
      const flushEndTime = Date.now();
      console.log('✅ Final buffer flush completed', {
        flush_duration: flushEndTime - flushStartTime,
        total_time_since_stop: flushEndTime - stopStartTime,
        final_transcript_count: transcriptsRef.current.length
      });

      // NOTE: Status remains PROCESSING_TRANSCRIPTS until we start saving

      // Wait a bit more to ensure all transcript state updates have been processed
      console.log('Waiting for transcript state updates to complete...');
      await new Promise(resolve => setTimeout(resolve, 500));

      // Save to SQLite
      // NOTE: enabled to save COMPLETE transcripts after frontend receives all updates
      // This ensures user sees all transcripts streaming in before database save
      if (isCallApi && transcriptionComplete == true) {

        setStatus(RecordingStatus.SAVING, 'Saving meeting to database...');

        // Get fresh transcript state (ALL transcripts including late ones)
        const freshTranscripts = [...transcriptsRef.current];

        // Get folder_path and meeting_name from recording-stopped event
        const folderPath = sessionStorage.getItem('last_recording_folder_path');
        const savedMeetingName = sessionStorage.getItem('last_recording_meeting_name');

        console.log('💾 Saving COMPLETE transcripts to database...', {
          transcript_count: freshTranscripts.length,
          meeting_name: savedMeetingName || meetingTitle,
          folder_path: folderPath,
          sample_text: freshTranscripts.length > 0 ? freshTranscripts[0].text.substring(0, 50) + '...' : 'none',
          last_transcript: freshTranscripts.length > 0 ? freshTranscripts[freshTranscripts.length - 1].text.substring(0, 30) + '...' : 'none',
        });

        try {
          const responseData = await storageService.saveMeeting(
            savedMeetingName || meetingTitle || 'New Meeting',  // PREFER savedMeetingName (backend source)
            freshTranscripts,
            folderPath
          );

          const meetingId = responseData.meeting_id;
          if (!meetingId) {
            console.error('No meeting_id in response:', responseData);
            throw new Error('No meeting ID received from save operation');
          }

          const autoSummarizeRequested =
            sessionStorage.getItem('snackmeet_auto_summarize') === '1';
          sessionStorage.removeItem('snackmeet_auto_summarize');

          const autoTranscriptionPreferences = readAutoTranscriptionPreferences({
            provider: isAutoTranscriptionProvider(transcriptModelConfig.provider)
              ? transcriptModelConfig.provider
              : 'localWhisper',
            model: transcriptModelConfig.model,
          });
          const hasSavedTranscripts = freshTranscripts.length > 0;
          const autoTranscriptionRequested =
            autoTranscriptionPreferences.enabled && !hasSavedTranscripts;

          let deferredTranscriptionStarted = false;
          if (autoTranscriptionRequested && folderPath) {
            try {
              rememberDeferredTranscription({
                meetingId,
                autoSummarize: autoSummarizeRequested,
              });
              await invoke('start_retranscription_command', {
                meetingId,
                meetingFolderPath: folderPath,
                language:
                  autoTranscriptionPreferences.provider === 'parakeet' || selectedLanguage === 'auto'
                    ? null
                    : selectedLanguage,
                model: autoTranscriptionPreferences.model || null,
                provider: autoTranscriptionPreferences.provider,
              });
              deferredTranscriptionStarted = true;
              toast.info('录音已保存，自动转译将在后台进行', {
                description: `${autoTranscriptionPreferences.provider} · ${autoTranscriptionPreferences.model}`,
              });
            } catch (error) {
              forgetDeferredTranscription(meetingId);
              console.error('Failed to start automatic post-recording transcription:', error);
              toast.warning('录音已保存，但后台转写未能启动', {
                description: error instanceof Error ? error.message : String(error),
              });
            }
          } else if (autoTranscriptionRequested) {
            toast.warning('录音已保存，但找不到音频目录', {
              description: '自动转译没有启动；你仍可稍后在会议记录中手动重新转译。',
            });
          }

          // Snack Meet: if this recording was auto-triggered by the meeting-window
          // detector, kick off background summary + smart folder rename. This mirrors
          // the --import path (which auto-summarizes); the normal manual-stop path does
          // not. The flag is set by MeetingDetectorProvider when the user confirms the
          // auto-record dialog. auto_summarize_meeting_command runs fully headless and
          // ends by calling rename_meeting_folder → "<topic>_<start>--<end>".
          if (autoSummarizeRequested && hasSavedTranscripts) {
            invoke('auto_summarize_meeting_command', { meetingId })
              .catch((e) => console.warn('[Snack Meet] auto_summarize_meeting_command failed:', e));
          }

          let shouldDetectSummaryLanguage = false;
          if (hasSavedTranscripts) {
            try {
              shouldDetectSummaryLanguage = !(await applyPinnedSummaryLanguageToMeeting(meetingId));
            } catch (error) {
              console.warn('Failed to apply pinned summary language preference for new meeting:', error);
              toast.warning('Could not apply default summary language', {
                description: 'The meeting was saved, but the default summary language was not applied.',
              });
            }
          }

          if (shouldDetectSummaryLanguage) {
            try {
              await detectAndCacheSummaryLanguage(
                meetingId,
                freshTranscripts.map(t => t.text)
              );
            } catch (error) {
              console.warn('Failed to detect summary language for new meeting:', error);
              toast.warning('Could not detect summary language', {
                description: 'The meeting was saved, but Auto could not detect the summary language.',
              });
            }
          }

          console.log('✅ Successfully saved COMPLETE meeting with ID:', meetingId);
          console.log('   Transcripts:', freshTranscripts.length);
          console.log('   folder_path:', folderPath);

          // Mark meeting as saved in IndexedDB (for recovery system)
          await markMeetingAsSaved();

          // Clean up session storage
          sessionStorage.removeItem('last_recording_folder_path');
          sessionStorage.removeItem('last_recording_meeting_name');
          // Clean up IndexedDB meeting ID (redundant with markMeetingAsSaved cleanup, but ensures cleanup)
          sessionStorage.removeItem('indexeddb_current_meeting_id');

          // Refetch meetings and set current meeting
          await refetchMeetings();

          try {
            const meetingData = await storageService.getMeeting(meetingId);
            if (meetingData) {
              setCurrentMeeting({
                id: meetingId,
                title: meetingData.title
              });
              console.log('✅ Current meeting set:', meetingData.title);
            }
          } catch (error) {
            console.warn('Could not fetch meeting details, using ID only:', error);
            setCurrentMeeting({ id: meetingId, title: savedMeetingName || meetingTitle || 'New Meeting' });
          }

          // Mark as completed
          setStatus(RecordingStatus.COMPLETED);

          // Show success toast with navigation option
          toast.success('Recording saved successfully!', {
            description: deferredTranscriptionStarted
              ? 'Audio saved. Automatic transcription is running in the background.'
              : hasSavedTranscripts
                ? `${freshTranscripts.length} transcript segments saved.`
                : autoTranscriptionPreferences.enabled
                  ? 'Audio saved. Automatic transcription could not be started.'
                  : 'Audio saved. Automatic transcription is off.',
            action: {
              label: 'View Meeting',
              onClick: () => {
                router.push(`/meeting-details?id=${meetingId}`);
              }
            },
            duration: 10000,
          });

          // Auto-navigate after a short delay with source parameter
          setTimeout(() => {
            router.push(`/meeting-details?id=${meetingId}&source=recording`);
            clearTranscripts()

            // Reset to IDLE after navigation
            setStatus(RecordingStatus.IDLE);
          }, 2000);

        } catch (saveError) {
          console.error('Failed to save meeting to database:', saveError);
          setStatus(RecordingStatus.ERROR, saveError instanceof Error ? saveError.message : 'Unknown error');
          toast.error('Failed to save meeting', {
            description: saveError instanceof Error ? saveError.message : 'Unknown error'
          });
          throw saveError;
        }
      } else {
        // No save needed, go back to IDLE
        setStatus(RecordingStatus.IDLE);
      }

      setIsMeetingActive(false);
      // isRecording already set to false at function start
      setIsRecordingDisabled(false);
    } catch (error) {
      console.error('Error in handleRecordingStop:', error);
      setStatus(RecordingStatus.ERROR, error instanceof Error ? error.message : 'Unknown error');
      // isRecording already set to false at function start
      setIsRecordingDisabled(false);
    } finally {
      // Always reset the guard flag when done
      stopInProgressRef.current = false;
    }
  }, [
    setIsRecording,
    setIsRecordingDisabled,
    setStatus,
    transcriptsRef,
    flushBuffer,
    clearTranscripts,
    meetingTitle,
    markMeetingAsSaved,
    refetchMeetings,
    setCurrentMeeting,
    setIsMeetingActive,
    router,
    selectedLanguage,
    transcriptModelConfig,
  ]);

  // Expose handleRecordingStop function to window for Rust callbacks
  const handleRecordingStopRef = useRef(handleRecordingStop);
  useEffect(() => {
    handleRecordingStopRef.current = handleRecordingStop;
  });

  useEffect(() => {
    (window as any).handleRecordingStop = (callApi: boolean = true) => {
      handleRecordingStopRef.current(callApi);
    };

    // Cleanup on unmount
    return () => {
      delete (window as any).handleRecordingStop;
    };
  }, []);

  // Derive summaryStatus from RecordingStatus for backward compatibility
  const summaryStatus: SummaryStatus = status === RecordingStatus.PROCESSING_TRANSCRIPTS ? 'processing' : 'idle';

  return {
    handleRecordingStop,
    isStopping,
    isProcessingTranscript,
    isSavingTranscript,
    summaryStatus,
    setIsStopping: (value: boolean) => {
      setStatus(value ? RecordingStatus.STOPPING : RecordingStatus.IDLE);
    },
  };
}
