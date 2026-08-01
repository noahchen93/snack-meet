'use client';

import React, { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';
import { appDataDir } from '@tauri-apps/api/path';
import { toast } from 'sonner';
import { recordingService } from '@/services/recordingService';

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
 *     → app-exit: auto-stop.
 *     → window-gone: native dialog "检测到会议结束，是否停止录音？" → on OK stop,
 *       on dismiss keep recording (matches Snack Record's showStopReminder).
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
}

interface MeetingEndedPayload {
  reason: string; // "app-exit" | "window-gone"
  bundle_id: string | null;
}

/** "Snack Meet-YYYYMMDD-HHMMSS.txt" — local-time timestamp that rename_meeting_folder
 *  parses (rsplitn(3,'-') → time, date) for the real meeting start. */
function timestampedMeetingName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `Snack Meet-${ts}.txt`;
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

  useEffect(() => {
    let unlistenDetected: (() => void) | undefined;
    let unlistenEnded: (() => void) | undefined;

    const setup = async () => {
      unlistenDetected = await listen<MeetingDetectedPayload>('meeting-detected', async (event) => {
        const { app_name, bundle_id } = event.payload;
        if (dialogInProgress.current || (await isCurrentlyRecording())) return;
        dialogInProgress.current = true;
        try {
          const ok = await confirm(`已检测到 ${app_name} 开启，是否自动录音？`, {
            title: 'Snack Meet',
            kind: 'warning',
            okLabel: '开始录音',
            cancelLabel: '取消',
          });
          if (!ok) return;
          if (await isCurrentlyRecording()) return; // user started manually meanwhile
          // Flag → useRecordingStop auto-summarizes after save → smart folder rename.
          sessionStorage.setItem('snackmeet_auto_summarize', '1');
          const name = timestampedMeetingName();
          await recordingService.startRecordingWithDevices(null, null, name);
          // null mic/system → Rust uses the configured preferred devices.
          await invoke('meeting_detector_set_recording_active', { active: true, bundleId: bundle_id });
          toast.success('已开始录音', { description: `${app_name} 会议` });
        } catch (e) {
          console.error('[Snack Meet] auto-record start failed:', e);
          sessionStorage.removeItem('snackmeet_auto_summarize');
          toast.error('自动录音启动失败', { description: e instanceof Error ? e.message : String(e) });
        } finally {
          dialogInProgress.current = false;
        }
      });

      unlistenEnded = await listen<MeetingEndedPayload>('meeting-ended', async (event) => {
        const { reason, bundle_id } = event.payload;
        if (!(await isCurrentlyRecording())) return;
        if (reason === 'app-exit') {
          // App fully exited → stop without asking (matches Snack Record).
          await stopAndSave(bundle_id);
          return;
        }
        // window-gone: ask before stopping; dismiss = keep recording.
        if (dialogInProgress.current) return;
        dialogInProgress.current = true;
        try {
          const ok = await confirm('检测到会议结束，是否停止录音？', {
            title: 'Snack Meet',
            kind: 'warning',
            okLabel: '停止录音',
            cancelLabel: '继续录音',
          });
          if (ok) {
            await stopAndSave(bundle_id);
          }
        } finally {
          dialogInProgress.current = false;
        }
      });
    };

    setup();

    return () => {
      unlistenDetected?.();
      unlistenEnded?.();
    };
  }, []);

  return <>{children}</>;
}