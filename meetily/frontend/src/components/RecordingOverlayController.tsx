'use client';

import { useEffect } from 'react';
import { LogicalPosition, primaryMonitor, Window } from '@tauri-apps/api/window';
import { useRecordingState } from '@/contexts/RecordingStateContext';

export function RecordingOverlayController() {
  const { isRecording } = useRecordingState();

  useEffect(() => {
    if (!isRecording) return;

    const showOverlay = async () => {
      const overlay = await Window.getByLabel('recording-overlay');
      if (!overlay) return;

      const monitor = await primaryMonitor();
      if (monitor) {
        const scale = monitor.scaleFactor;
        const width = 340;
        const margin = 24;
        const x = monitor.position.x / scale + monitor.size.width / scale - width - margin;
        const y = monitor.position.y / scale + 44;
        await overlay.setPosition(new LogicalPosition(x, y));
      }
      await overlay.show();
    };

    showOverlay().catch((error) => {
      console.warn('[Recording overlay] Could not show overlay:', error);
    });
  }, [isRecording]);

  return null;
}
