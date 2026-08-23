'use client';

import { Languages } from 'lucide-react';
import { useLocale } from '@/contexts/LocaleContext';

export function LanguageToggle({ compact = false }: { compact?: boolean }) {
  const { locale, toggleLocale } = useLocale();
  return (
    <button
      onClick={toggleLocale}
      className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 shadow-sm transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"
      title={locale === 'zh-CN' ? 'Switch to English' : '切换为中文'}
    >
      <Languages className="h-4 w-4" />
      {!compact && (locale === 'zh-CN' ? 'EN' : '中文')}
    </button>
  );
}
