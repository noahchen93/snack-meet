'use client';

import React, { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';
import { appDataDir } from '@tauri-apps/api/path';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { recordingService } from '@/services/recordingService';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { meetingNameFromDetection } from '@/lib/smartMeetingName';

// Tauri event listeners can briefly overlap during a webview reload or React
// remount. Keep the start-dialog guard at module scope so duplicate provider
// instances cannot show multiple native prompts for the same detection event.
let globalDialogInProgress = false;
let lastDetectedKey = '';
let lastDetectedAt = 0;
const DETECTION_DEDUPE_MS = 5_000;

/**
 * MeetingDetectorProvider
 *
 * Bridges the Rust meeting-window detector (meeting_detector.rs) to the UI +
 * recording orchestration. The detector owns the Snack Record state machine and
 * emits high-level Tauri events; this provider listens, shows NATIVE confirmation
 * dialogs (visible above a fullscreen meeting, unlike an in-app web modal), and
 * drives meetily's existing start/stop/save path — so no new DB-row or recording
 * logic is created here.
 *
 *   meeting-detected { app_name, bundle_id, window_title }
 *     → native dialog "已检测到 {appName} 开启，是否自动录音？"
 *     → on OK: start recording (timestamped name → feeds rename_meeting_folder),
 *              set the detector to recording-watch mode, set a sessionStorage flag
 *              so useRecordingStop auto-summarizes (→ smart folder rename) on save.
 *
 *   meeting-ended { reason: "app-exit" | "window-gone", bundle_id }
 *     → stop and save automatically. The Rust detector debounces a missing
 *       meeting window before emitting the window-gone event.
 *
 * On stop it reuses the proven in-app-button path: invoke `stop_recording` (which
 * emits `recording-stopped` → useRecordingStop sets the sessionStorage
 * folder/meeting name), then call `window.handleRecordingStop(true)` (exposed
 * globally by useRecordingStop via RecordingPostProcessingProvider) to run the
 * full save → navigate → analytics flow.
 */
interface MeetingDetectedPayload {
  bundle_id: string;
  app_name: string;
  window_title: string;
  trigger: 'microphone' | 'meeting';
}

interface MeetingEndedPayload {
  reason: string; // "app-exit" | "window-gone"
  bundle_id: string | null;
}

interface TranscriptionReadiness {
  ready: boolean;
  provider: string;
  configured_model: string;
  current_model?: string;
  available_models: string[];
  error?: string;
}

async function buildSavePath(): Promise<string> {
  const dataDir = await appDataDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${dataDir}/recording-${timestamp}.wav`;
}

async function isCurrentlyRecording(): Promise<boolean> {
  try {
    const s = await recordingService.getRecordingState();
    return !!s.is_recording;
  } catch {
    return false;
  }
}

/** Stop the recording and trigger the existing post-processing/save flow. */
async function stopAndSave(bundleId: string | null): Promise<void> {
  if (!(await isCurrentlyRecording())) {
    // Nothing to stop (user stopped manually). Just clear detector recording state.
    await invoke('meeting_detector_set_recording_active', { active: false, bundleId: null })
      .catch((e) => console.warn('[Snack Meet] set_recording_active(false) failed:', e));
    return;
  }
  const savePath = await buildSavePath();
  try {
    // Mirrors RecordingControls.stopRecordingAction: stop_recording emits
    // `recording-stopped` (with folder_path + meeting_name) BEFORE it resolves,
    // so the sessionStorage values are ready for handleRecordingStop.
    await recordingService.stopRecording(savePath);
  } catch (e) {
    console.warn('[Snack Meet] stop_recording failed:', e);
  }
  const fn = (window as unknown as { handleRecordingStop?: (callApi: boolean) => void }).handleRecordingStop;
  if (typeof fn === 'function') {
    fn(true);
  } else {
    console.warn('[Snack Meet] window.handleRecordingStop not available; falling back to recording-stop-complete event');
    // Fallback: route through the same event the tray uses.
    const { emit } = await import('@tauri-apps/api/event');
    await emit('recording-stop-complete', true);
  }
  await invoke('meeting_detector_set_recording_active', { active: false, bundleId: null })
    .catch((e) => console.warn('[Snack Meet] set_recording_active(false) failed:', e));
}

export function MeetingDetectorProvider({ children }: { children: React.ReactNode }) {
  // Guards against overlapping native dialogs (a start prompt + a stop prompt
  // landing within the same poll, or rapid repeated events).
  const dialogInProgress = useRef(false);
  const { setMeetingTitle } = useTranscripts();
  const router = useRouter();

  useEffect(() => {
    let unlistenDetected: (() => void) | undefined;
    let unlistenEnded: (() => void) | undefined;
    let disposed = false;

    const setup = async () => {
      const detectedListener = await listen<MeetingDetectedPayload>('meeting-detected', async (event) => {
        if (disposed) return;
        const { app_name, bundle_id, window_title, trigger } = event.payload;
        const detectionKey = `${bundle_id}:${trigger}:${window_title}`;
        const now = Date.now();
        if (
          dialogInProgress.current
          || globalDialogInProgress
          || (now - lastDetectedAt < DETECTION_DEDUPE_MS && detectionKey === lastDetectedKey)
          || (await isCurrentlyRecording())
        ) return;
        lastDetectedKey = detectionKey;
        lastDetectedAt = now;
        globalDialogInProgress = true;
        dialogInProgress.current = true;
        try {
          // Make sure the configured transcription provider actually has a usable
          // model before we offer to start (or silently start) a recording.
          const readiness = await invoke<TranscriptionReadiness>('check_transcription_readiness');
          if (!readiness.ready) {
            toast.error('无法自动录音：转录模型未就绪', {
              description: readiness.error || '请下载模型或切换转录引擎',
              action: {
                label: '前往设置',
                onClick: () => router.push('/settings?tab=Transcriptionmodels'),
              },
            });
            return;
          }

          // Always prompt the user before recording (a fast confirm dialog), so
          // they stay in control. This applies to both window- and mic-triggered
          // meetings (腾讯会议 etc.) — the dialog appears immediately on detection.
          const ok = await confirm(`已检测到 ${app_name} 开启，是否自动录音？`, {
            title: 'Snack Meet',
            kind: 'warning',
            okLabel: '开始录音',
            cancelLabel: '取消',
          });
          if (!ok) return;
          if (await isCurrentlyRecording()) return; // user started manually meanwhile
          // Only the explicitly confirmed meeting-window path may enter the
          // existing AI summary flow. A microphone-triggered recording remains
          // local and uses its source/date name unless the user summarizes later.
          if (trigger === 'meeting') {
            sessionStorage.setItem('snackmeet_auto_summarize', '1');
          } else {
            sessionStorage.removeItem('snackmeet_auto_summarize');
          }
          const name = meetingNameFromDetection(app_name, window_title);
          setMeetingTitle(name);
          await recordingService.startRecordingWithDevices(null, null, name);
          // null mic/system → Rust uses the configured preferred devices.
          await invoke('meeting_detector_set_recording_active', { active: true, bundleId: bundle_id });
          toast.success('已开始录音', {
            description: trigger === 'microphone'
              ? `${app_name} 正在使用麦克风`
              : `${app_name} 会议`,
          });
        } catch (e) {
          console.error('[Snack Meet] auto-record start failed:', e);
          sessionStorage.removeItem('snackmeet_auto_summarize');
          toast.error('自动录音启动失败', { description: e instanceof Error ? e.message : String(e) });
        } finally {
          dialogInProgress.current = false;
          globalDialogInProgress = false;
        }
      });
      if (disposed) {
        detectedListener();
        return;
      }
      unlistenDetected = detectedListener;

      const endedListener = await listen<MeetingEndedPayload>('meeting-ended', async (event) => {
        if (disposed) return;
        const { reason, bundle_id } = event.payload;
        if (!(await isCurrentlyRecording())) return;
        if (reason === 'app-exit' || reason === 'window-gone') {
          // App fully exited or the meeting window stayed gone long enough to
          // confirm an end → stop and save without an extra confirmation.
          await stopAndSave(bundle_id);
          return;
        }
      });
      if (disposed) {
        endedListener();
        return;
      }
      unlistenEnded = endedListener;

      // Tauri events are not retained for listeners that have not mounted yet.
      // Tell Rust it may emit only after both handlers above are active, and force
      // a fresh scan for meetings that were already open when Snack Meet launched.
      await invoke('meeting_detector_ui_ready');
    };

    setup().catch((error) => {
      console.error('[Snack Meet] Failed to initialize meeting detector UI bridge:', error);
    });

    return () => {
      // Mark the async setup as disposed before invoking the listeners we have
      // already acquired. If listen() resolves after cleanup, setup() will
      // immediately unregister that late listener instead of leaking it.
      disposed = true;
      unlistenDetected?.();
      unlistenEnded?.();
    };
  }, [setMeetingTitle]);

  return <>{children}</>;
}
