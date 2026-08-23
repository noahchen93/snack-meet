'use client';

import { convertFileSrc } from '@tauri-apps/api/core';
import { Pause, Play, RotateCcw, Volume2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

interface AudioTranscriptPlayerProps {
  audioPath: string;
  onTimeChange: (seconds: number) => void;
  onPlayingChange: (playing: boolean) => void;
  seekRequest?: number | null;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    : `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export function AudioTranscriptPlayer({ audioPath, onTimeChange, onPlayingChange, seekRequest }: AudioTranscriptPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const source = useMemo(() => convertFileSrc(audioPath), [audioPath]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || seekRequest == null || !Number.isFinite(seekRequest)) return;
    audio.currentTime = Math.max(0, Math.min(seekRequest, audio.duration || seekRequest));
    setCurrentTime(audio.currentTime);
    onTimeChange(audio.currentTime);
  }, [seekRequest, onTimeChange]);

  useEffect(() => () => onPlayingChange(false), [onPlayingChange]);

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      if (audio.paused) await audio.play();
      else audio.pause();
    } catch (playError) {
      console.error('Failed to play meeting audio:', playError);
      setError('无法播放该音频，请确认原始音频仍然存在。');
    }
  };

  const seek = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = seconds;
    setCurrentTime(seconds);
    onTimeChange(seconds);
  };

  const changePlaybackRate = () => {
    const rates = [1, 1.25, 1.5, 2];
    const next = rates[(rates.indexOf(playbackRate) + 1) % rates.length];
    setPlaybackRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  return (
    <div className="mt-3 rounded-xl border border-indigo-100 bg-indigo-50/60 p-3">
      <audio
        ref={audioRef}
        src={source}
        preload="metadata"
        onLoadedMetadata={(event) => { setDuration(event.currentTarget.duration || 0); setError(null); }}
        onTimeUpdate={(event) => { const time = event.currentTarget.currentTime; setCurrentTime(time); onTimeChange(time); }}
        onPlay={() => { setIsPlaying(true); onPlayingChange(true); }}
        onPause={() => { setIsPlaying(false); onPlayingChange(false); }}
        onEnded={() => { setIsPlaying(false); onPlayingChange(false); }}
        onError={() => setError('音频加载失败或该格式暂不受系统播放器支持。')}
      />
      <div className="flex items-center gap-2">
        <button type="button" onClick={togglePlayback} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white shadow-sm hover:bg-indigo-700" aria-label={isPlaying ? '暂停' : '播放'}>
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 translate-x-px" />}
        </button>
        <button type="button" onClick={() => seek(Math.max(0, currentTime - 10))} className="rounded-md p-1.5 text-indigo-700 hover:bg-indigo-100" aria-label="后退 10 秒" title="后退 10 秒">
          <RotateCcw className="h-4 w-4" />
        </button>
        <Volume2 className="h-4 w-4 shrink-0 text-indigo-500" />
        <input type="range" min={0} max={duration || 0} step={0.1} value={Math.min(currentTime, duration || 0)} onChange={(event) => seek(Number(event.target.value))} className="min-w-0 flex-1 accent-indigo-600" aria-label="音频播放进度" />
        <button type="button" onClick={changePlaybackRate} className="w-10 rounded-md px-1 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-100" title="播放速度">{playbackRate}×</button>
      </div>
      <div className="mt-1 flex justify-between pl-[76px] text-[11px] tabular-nums text-slate-500">
        <span>{formatTime(currentTime)}</span><span>{formatTime(duration)}</span>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
