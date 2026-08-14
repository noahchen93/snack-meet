'use client';

import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { LogicalPosition, primaryMonitor, Window } from '@tauri-apps/api/window';
import { useRecordingState } from '@/contexts/RecordingStateContext';

export function RecordingOverlayController() {
  const { isRecording } = useRecordingState();

  useEffect(() => {
    if (!isRecording) return;

    let cancelled = false;
    let frontmostTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleFrontmostRefresh = () => {
      frontmostTimer = setTimeout(async () => {
        if (cancelled) return;
        try {
          // Window ordering can be rebuilt when the active app or Space changes.
          // Reassert the native level while recording so ordinary desktop
          // windows cannot cover the indicator either.
          await invoke('recording_overlay_ensure_frontmost');
        } catch (error) {
          console.warn('[Recording overlay] Could not refresh frontmost level:', error);
        } finally {
          if (!cancelled) scheduleFrontmostRefresh();
        }
      }, 2000);
    };

    const showOverlay = async () => {
      const overlay = await Window.getByLabel('recording-overlay');
      if (!overlay || cancelled) return;

      const monitor = await primaryMonitor();
      if (monitor) {
        const scale = monitor.scaleFactor;
        const width = 340;
        const margin = 24;
        const x = monitor.position.x / scale + monitor.size.width / scale - width - margin;
        const y = monitor.position.y / scale + 44;
        await overlay.setPosition(new LogicalPosition(x, y));
      }

      // Tauri's ordinary always-on-top level is below dedicated fullscreen
      // Spaces on macOS. Reassert both the portable flags and the native AppKit
      // fullscreen overlay level immediately before every show.
      await overlay.setAlwaysOnTop(true);
      await overlay.setVisibleOnAllWorkspaces(true);
      await overlay.show();
      if (cancelled) {
        await overlay.hide();
        return;
      }
      // Apply the native AppKit level after show(), because showing a hidden
      // NSWindow can itself rebuild its ordering level.
      await invoke('recording_overlay_ensure_frontmost');
      scheduleFrontmostRefresh();
    };

    showOverlay().catch((error) => {
      console.warn('[Recording overlay] Could not show overlay:', error);
    });

    return () => {
      cancelled = true;
      if (frontmostTimer) clearTimeout(frontmostTimer);
    };
  }, [isRecording]);

  return null;
}
