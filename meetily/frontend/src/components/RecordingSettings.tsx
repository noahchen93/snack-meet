import React, { useState, useEffect } from 'react';
import { Switch } from '@/components/ui/switch';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { DeviceSelection, SelectedDevices } from '@/components/DeviceSelection';
import Analytics from '@/lib/analytics';
import { toast } from 'sonner';

export interface RecordingPreferences {
  save_folder: string;
  auto_save: boolean;
  file_format: string;
  preferred_mic_device: string | null;
  preferred_system_device: string | null;
  /** Snack Meet: run the meeting-window auto-detector in the background. */
  auto_detect_meetings: boolean;
  /** Periodic auto-scan of the recordings folder for new synced transcripts. */
  auto_scan_enabled: boolean;
  auto_scan_interval_minutes: number | null;
  /** "all" | "today" | "custom" */
  auto_scan_mode: string | null;
  auto_scan_start: string | null;
  auto_scan_end: string | null;
}

// Convert an ISO string (or null) to the format used by <input type="datetime-local">.
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface RecordingSettingsProps {
  onSave?: (preferences: RecordingPreferences) => void;
}

export function RecordingSettings({ onSave }: RecordingSettingsProps) {
  const [preferences, setPreferences] = useState<RecordingPreferences>({
    save_folder: '',
    auto_save: true,
    file_format: 'mp4',
    preferred_mic_device: null,
    preferred_system_device: null,
    auto_detect_meetings: false,
    auto_scan_enabled: false,
    auto_scan_interval_minutes: 60,
    auto_scan_mode: 'all',
    auto_scan_start: null,
    auto_scan_end: null,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showRecordingNotification, setShowRecordingNotification] = useState(true);

  // Load recording preferences on component mount
  useEffect(() => {
    const loadPreferences = async () => {
      try {
        const prefs = await invoke<RecordingPreferences>('get_recording_preferences');
        setPreferences(prefs);
      } catch (error) {
        console.error('Failed to load recording preferences:', error);
        // If loading fails, get default folder path
        try {
          const defaultPath = await invoke<string>('get_default_recordings_folder_path');
          setPreferences(prev => ({ ...prev, save_folder: defaultPath }));
        } catch (defaultError) {
          console.error('Failed to get default folder path:', defaultError);
        }
      } finally {
        setLoading(false);
      }
    };

    loadPreferences();
  }, []);

  // Load recording notification preference
  useEffect(() => {
    const loadNotificationPref = async () => {
      try {
        const { Store } = await import('@tauri-apps/plugin-store');
        const store = await Store.load('preferences.json');
        const show = await store.get<boolean>('show_recording_notification') ?? true;
        setShowRecordingNotification(show);
      } catch (error) {
        console.error('Failed to load notification preference:', error);
      }
    };
    loadNotificationPref();
  }, []);

  const handleAutoSaveToggle = async (enabled: boolean) => {
    const newPreferences = { ...preferences, auto_save: enabled };
    setPreferences(newPreferences);
    await savePreferences(newPreferences);

    // Track auto-save setting change
    await Analytics.track('auto_save_recording_toggled', {
      enabled: enabled.toString()
    });
  };

  // Snack Meet: toggle the meeting-window auto-detector. Persisting the pref also
  // controls whether the detector auto-starts on next launch (lib.rs setup reads it).
  // At runtime we start/stop the live detector immediately. Screen Recording TCC is
  // required for SCShareableContent window enumeration, so request it on enable.
  const handleAutoDetectMeetingsToggle = async (enabled: boolean) => {
    const newPreferences = { ...preferences, auto_detect_meetings: enabled };
    setPreferences(newPreferences);
    try {
      await savePreferences(newPreferences);
      if (enabled) {
        const alreadyGranted = await invoke<boolean>('preflight_screen_capture').catch(() => false);
        const granted = alreadyGranted
          ? true
          : await invoke<boolean>('request_screen_capture').catch(() => false);
        if (!granted) {
          toast.warning('需要屏幕录制权限', {
            description: '自动检测设置已保存。请在 系统设置 → 隐私与安全 → 屏幕录制 中授权 Snack Meet，然后重启应用。',
          });
          await Analytics.track('auto_detect_meetings_toggled', { enabled: 'true' });
          return;
        }
        await invoke('meeting_detector_start');
        toast.success('已开启会议自动检测', {
          description: '检测到会议应用开启时会自动提示录音。',
        });
      } else {
        await invoke('meeting_detector_stop');
        toast.success('已关闭会议自动检测');
      }
      await Analytics.track('auto_detect_meetings_toggled', { enabled: enabled.toString() });
    } catch (e) {
      // Revert on failure.
      setPreferences(preferences);
      toast.error('切换会议自动检测失败', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleDeviceChange = async (devices: SelectedDevices) => {
    const newPreferences = {
      ...preferences,
      preferred_mic_device: devices.micDevice,
      preferred_system_device: devices.systemDevice
    };
    setPreferences(newPreferences);
    await savePreferences(newPreferences);

    // Track default device preference changes
    // Note: Individual device selection analytics are tracked in DeviceSelection component
    await Analytics.track('default_devices_changed', {
      has_preferred_microphone: (!!devices.micDevice).toString(),
      has_preferred_system_audio: (!!devices.systemDevice).toString()
    });
  };

  const handleOpenFolder = async () => {
    try {
      await invoke('open_recordings_folder');
    } catch (error) {
      console.error('Failed to open recordings folder:', error);
    }
  };

  // Open a native folder picker so the user can manually choose the recordings
  // storage location. On success, update the in-memory prefs and persist.
  const handlePickFolder = async () => {
    try {
      const picked = await invoke<string | null>('pick_and_set_recording_folder');
      if (picked) {
        setPreferences(prev => ({ ...prev, save_folder: picked }));
        toast.success('录音存储位置已更新', {
          description: picked,
        });
      }
    } catch (error) {
      console.error('Failed to pick recordings folder:', error);
      toast.error('选择存储位置失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const [scanning, setScanning] = useState(false);

  // Scan the recordings folder for meeting subfolders that contain a
  // transcripts.json (e.g. written by a desktop machine that transcribed the
  // synced audio) and import any that aren't already in the local database.
  const handleScanImport = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      // Derive the scan time window from the configured mode.
      const mode = preferences.auto_scan_mode || 'all';
      let start_time: string | null = null;
      let end_time: string | null = null;
      if (mode === 'today') {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        start_time = start.toISOString();
        end_time = now.toISOString();
      } else if (mode === 'custom') {
        start_time = preferences.auto_scan_start || null;
        end_time = preferences.auto_scan_end || null;
      }
      const result = await invoke<{
        scanned: number;
        imported: number;
        updated: number;
        skipped: number;
        failed: number;
        imported_meetings: string[];
      }>('scan_and_import_transcripts', { folderPath: preferences.save_folder, startTime: start_time, endTime: end_time });
      if (result.imported > 0 || result.updated > 0) {
        toast.success(`已导入 ${result.imported} 个、更新 ${result.updated} 个会议`, {
          description: `扫描 ${result.scanned} 个文件夹，跳过 ${result.skipped} 个，失败 ${result.failed} 个。`,
        });
      } else {
        toast.info('没有新的转写可导入', {
          description: `扫描 ${result.scanned} 个文件夹，跳过 ${result.skipped} 个，失败 ${result.failed} 个。`,
        });
      }
      await Analytics.track('scan_import_transcripts', {
        scanned: result.scanned.toString(),
        imported: result.imported.toString(),
        failed: result.failed.toString(),
      });
    } catch (error) {
      console.error('Failed to scan and import transcripts:', error);
      toast.error('扫描导入失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setScanning(false);
    }
  };

  const handleNotificationToggle = async (enabled: boolean) => {
    try {
      setShowRecordingNotification(enabled);
      const { Store } = await import('@tauri-apps/plugin-store');
      const store = await Store.load('preferences.json');
      await store.set('show_recording_notification', enabled);
      await store.save();
      toast.success('Preference saved');
      await Analytics.track('recording_notification_preference_changed', {
        enabled: enabled.toString()
      });
    } catch (error) {
      console.error('Failed to save notification preference:', error);
      toast.error('Failed to save preference');
    }
  };

  const savePreferences = async (prefs: RecordingPreferences) => {
    setSaving(true);
    try {
      await invoke('set_recording_preferences', { preferences: prefs });
      onSave?.(prefs);

      // Show success toast with device details
      const micDevice = prefs.preferred_mic_device || 'Default';
      const systemDevice = prefs.preferred_system_device || 'Default';
      toast.success("Device preferences saved", {
        description: `Microphone: ${micDevice}, System Audio: ${systemDevice}`
      });
    } catch (error) {
      console.error('Failed to save recording preferences:', error);
      toast.error("Failed to save device preferences", {
        description: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-1/4 mb-4"></div>
        <div className="h-8 bg-gray-200 rounded mb-4"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">Recording Settings</h3>
        <p className="text-sm text-gray-600 mb-6">
          Configure how your audio recordings are saved during meetings.
        </p>
      </div>

      {/* Auto Save Toggle */}
      <div className="flex items-center justify-between p-4 border rounded-lg">
        <div className="flex-1">
          <div className="font-medium">Save Audio Recordings</div>
          <div className="text-sm text-gray-600">
            Automatically save audio files when recording stops
          </div>
        </div>
        <Switch
          checked={preferences.auto_save}
          onCheckedChange={handleAutoSaveToggle}
          disabled={saving}
        />
      </div>

      {/* Folder Location - Only shown when auto_save is enabled */}
      {preferences.auto_save && (
        <div className="space-y-4">
          <div className="p-4 border rounded-lg bg-gray-50">
            <div className="font-medium mb-2">Save Location</div>
            <div className="text-sm text-gray-600 mb-3 break-all">
              {preferences.save_folder || 'Default folder'}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handlePickFolder}
                className="flex items-center gap-2 px-3 py-2 text-sm border border-indigo-300 text-indigo-700 rounded-md hover:bg-indigo-50 transition-colors"
              >
                <FolderOpen className="w-4 h-4" />
                选择存储位置
              </button>
              <button
                onClick={handleOpenFolder}
                className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              >
                <FolderOpen className="w-4 h-4" />
                Open Folder
              </button>
              <button
                onClick={handleScanImport}
                disabled={scanning}
                className="flex items-center gap-2 px-3 py-2 text-sm border border-blue-300 text-blue-700 rounded-md hover:bg-blue-50 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${scanning ? 'animate-spin' : ''}`} />
                {scanning ? '扫描中…' : '扫描并导入转写'}
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              选择存储位置用于设定录音的保存目录；扫描会在此目录下查找含 transcripts.json 的会议子文件夹
              （例如台式机转写后同步过来的），导入到本地会议列表。
            </p>
          </div>

          <div className="p-4 border rounded-lg bg-blue-50">
            <div className="text-sm text-blue-800">
              <strong>File Format:</strong> {preferences.file_format.toUpperCase()} files
            </div>
            <div className="text-xs text-blue-600 mt-1">
              Recordings are saved with timestamp: recording_YYYYMMDD_HHMMSS.{preferences.file_format}
            </div>
          </div>
        </div>
      )}

      {/* Info when auto_save is disabled */}
      {!preferences.auto_save && (
        <div className="p-4 border rounded-lg bg-yellow-50">
          <div className="text-sm text-yellow-800">
            Audio recording is disabled. Enable "Save Audio Recordings" to automatically save your meeting audio.
          </div>
        </div>
      )}

      {/* Recording Notification Toggle */}
      <div className="flex items-center justify-between p-4 border rounded-lg">
        <div className="flex-1">
          <div className="font-medium">Recording Start Notification</div>
          <div className="text-sm text-gray-600">
            Show reminder to inform participants when recording starts
          </div>
        </div>
        <Switch
          checked={showRecordingNotification}
          onCheckedChange={handleNotificationToggle}
        />
      </div>

      {/* Snack Meet — Meeting Auto-Detection Toggle */}
      <div className="flex items-center justify-between p-4 border rounded-lg">
        <div className="flex-1">
          <div className="font-medium">Auto-detect Meetings</div>
          <div className="text-sm text-gray-600">
            自动检测会议/语音通话（腾讯会议 / Zoom / 飞书 / 浏览器会议 / 微信 / WhatsApp 语音），
            检测到后提示录音。需要屏幕录制权限。
          </div>
        </div>
        <Switch
          checked={preferences.auto_detect_meetings}
          onCheckedChange={handleAutoDetectMeetingsToggle}
          disabled={saving}
        />
      </div>

      {/* Snack Meet — Auto-scan recordings folder */}
      <div className="p-4 border rounded-lg space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <div className="font-medium">自动扫描转写</div>
            <div className="text-sm text-gray-600">
              定期扫描录音存储位置，自动导入台式机转写后同步过来的 transcripts.json。
            </div>
          </div>
          <Switch
            checked={preferences.auto_scan_enabled}
            onCheckedChange={(enabled) => {
              const next = { ...preferences, auto_scan_enabled: enabled };
              setPreferences(next);
              savePreferences(next);
            }}
            disabled={saving}
          />
        </div>

        {preferences.auto_scan_enabled && (
          <div className="space-y-3 pt-1">
            {/* Interval */}
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-600 w-24 shrink-0">扫描间隔</span>
              <select
                value={preferences.auto_scan_interval_minutes ?? 60}
                onChange={(e) => {
                  const next = {
                    ...preferences,
                    auto_scan_interval_minutes: Number(e.target.value),
                  };
                  setPreferences(next);
                  savePreferences(next);
                }}
                className="px-2 py-1.5 text-sm border border-gray-300 rounded-md bg-white"
              >
                <option value={15}>15 分钟</option>
                <option value={30}>30 分钟</option>
                <option value={60}>1 小时</option>
                <option value={180}>3 小时</option>
                <option value={360}>6 小时</option>
              </select>
            </div>

            {/* Time filter mode */}
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-600 w-24 shrink-0">扫描范围</span>
              <select
                value={preferences.auto_scan_mode || 'all'}
                onChange={(e) => {
                  const next = { ...preferences, auto_scan_mode: e.target.value };
                  setPreferences(next);
                  savePreferences(next);
                }}
                className="px-2 py-1.5 text-sm border border-gray-300 rounded-md bg-white"
              >
                <option value="all">全部（扫描所有会议）</option>
                <option value="today">仅今天</option>
                <option value="custom">自定义时间范围</option>
              </select>
            </div>

            {/* Custom range inputs */}
            {preferences.auto_scan_mode === 'custom' && (
              <div className="space-y-2 pl-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-600 w-24 shrink-0">开始时间</span>
                  <input
                    type="datetime-local"
                    value={toLocalInput(preferences.auto_scan_start)}
                    onChange={(e) => {
                      const next = {
                        ...preferences,
                        auto_scan_start: e.target.value ? new Date(e.target.value).toISOString() : null,
                      };
                      setPreferences(next);
                      savePreferences(next);
                    }}
                    className="flex-1 px-2 py-1.5 text-sm border border-gray-300 rounded-md bg-white"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-600 w-24 shrink-0">结束时间</span>
                  <input
                    type="datetime-local"
                    value={toLocalInput(preferences.auto_scan_end)}
                    onChange={(e) => {
                      const next = {
                        ...preferences,
                        auto_scan_end: e.target.value ? new Date(e.target.value).toISOString() : null,
                      };
                      setPreferences(next);
                      savePreferences(next);
                    }}
                    className="flex-1 px-2 py-1.5 text-sm border border-gray-300 rounded-md bg-white"
                  />
                </div>
                <p className="text-xs text-gray-500">
                  只扫描录音创建时间在该范围内的会议。
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Device Preferences */}
      <div className="space-y-4">
        <div className="border-t pt-6">
          <h4 className="text-base font-medium text-gray-900 mb-4">Default Audio Devices</h4>
          <p className="text-sm text-gray-600 mb-4">
            Set your preferred microphone and system audio devices for recording. These will be automatically selected when starting new recordings.
          </p>

          <div className="border rounded-lg p-4 bg-gray-50">
            <DeviceSelection
              selectedDevices={{
                micDevice: preferences.preferred_mic_device,
                systemDevice: preferences.preferred_system_device
              }}
              onDeviceChange={handleDeviceChange}
              disabled={saving}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
