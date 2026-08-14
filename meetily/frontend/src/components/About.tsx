'use client';

import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import Image from 'next/image';
import { ExternalLink, ShieldCheck } from 'lucide-react';

import { useLocale } from '@/contexts/LocaleContext';
import { Button } from './ui/button';

const RELEASES_URL = 'https://github.com/noahchen93/snack-meet/releases';

export function About() {
  const { locale } = useLocale();
  const zh = locale === 'zh-CN';
  const [currentVersion, setCurrentVersion] = useState('1.0.0');

  useEffect(() => {
    getVersion().then(setCurrentVersion).catch(console.error);
  }, []);

  const openReleases = () => {
    invoke('open_external_url', { url: RELEASES_URL }).catch((error) => {
      console.error('Failed to open Snack Meet releases:', error);
    });
  };

  return (
    <div className="h-[70vh] space-y-6 overflow-y-auto p-6 text-slate-800">
      <header className="text-center">
        <Image
          src="icon_128x128.png"
          alt="Snack Meet"
          width={72}
          height={72}
          className="mx-auto mb-3"
        />
        <h1 className="text-xl font-semibold">Snack Meet</h1>
        <p className="mt-1 text-sm text-slate-500">v{currentVersion}</p>
        <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-slate-600">
          {zh
            ? '本地优先的会议录音、转写与知识整理工具。你的会议资料由你掌控。'
            : 'A local-first workspace for recording, transcribing, and understanding meetings.'}
        </p>
      </header>

      <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
          <div>
            <h2 className="text-sm font-semibold text-emerald-950">
              {zh ? '独立发布渠道' : 'Independent release channel'}
            </h2>
            <p className="mt-1 text-sm leading-6 text-emerald-900/80">
              {zh
                ? 'Snack Meet 不再检查或安装任何上游 Meetily 更新。更新只通过本项目自己的发行页面提供，并采用完整 App 替换安装。'
                : 'Snack Meet never checks or installs upstream Meetily updates. Releases are distributed only by this project and replace the complete app bundle.'}
            </p>
          </div>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        {[
          zh ? ['隐私优先', '录音和本地模型处理可留在你的设备上。'] : ['Privacy first', 'Recordings and local model processing can stay on your device.'],
          zh ? ['模型自由', '可使用本地模型或你选择的 API。'] : ['Model freedom', 'Use local models or an API provider you choose.'],
          zh ? ['音频可控', '按会议决定保留原始音频或仅保留文档。'] : ['Storage control', 'Keep audio per meeting or retain documents only.'],
          zh ? ['独立演进', '功能、版本和发布节奏由 Snack Meet 自己管理。'] : ['Independent roadmap', 'Snack Meet owns its features, versions, and release cadence.'],
        ].map(([title, description]) => (
          <div key={title} className="rounded-xl border border-slate-200 bg-white p-4">
            <h3 className="text-sm font-semibold">{title}</h3>
            <p className="mt-1 text-xs leading-5 text-slate-600">{description}</p>
          </div>
        ))}
      </div>

      <footer className="border-t border-slate-200 pt-4 text-center">
        <Button type="button" variant="outline" size="sm" onClick={openReleases}>
          <ExternalLink className="mr-2 h-4 w-4" />
          {zh ? '查看 Snack Meet 独立版本' : 'View Snack Meet releases'}
        </Button>
        <p className="mt-3 text-xs text-slate-400">
          {zh ? '由 Snack Meet 项目独立维护' : 'Independently maintained by the Snack Meet project'}
        </p>
      </footer>
    </div>
  );
}
