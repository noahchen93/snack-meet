'use client';

import { useState } from 'react';
import { Globe, Pin, Check } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { LanguagePickerPopover } from '@/components/LanguagePickerPopover';
import { useRecentLanguages } from '@/hooks/useRecentLanguages';
import { labelForCode } from '@/lib/summary-languages';

export function SummaryLanguageSettings() {
  const { recents, pinned, addRecent, removeRecent, setPinned } = useRecentLanguages();
  const [pickerOpen, setPickerOpen] = useState(false);

  const togglePin = (code: string) => {
    setPinned(pinned === code ? null : code);
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm relative">
      <div className="flex items-center gap-2 mb-2">
        <Globe size={18} className="text-gray-500" />
        <h3 className="text-lg font-semibold text-gray-900">总结输出语言</h3>
      </div>
      <p className="text-sm text-gray-600 mb-4">
        设为“始终使用”后，所有新生成和重新生成的总结都会强制使用该语言，不再跟随会议语言。
      </p>

      <div className="grid grid-cols-3 gap-2 mb-5">
        {[
          { code: null, label: '自动识别' },
          { code: 'zh', label: '始终中文' },
          { code: 'en', label: '始终 English' },
        ].map(({ code, label }) => {
          const selected = pinned === code;
          return (
            <button
              key={label}
              type="button"
              onClick={() => setPinned(code)}
              className={`flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                selected ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {selected && <Check size={14} />}{label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {recents.map((code) => {
          const isPinned = pinned === code;
          return (
            <span
              key={code}
              className={`inline-flex items-center rounded-full border text-sm overflow-hidden ${
                isPinned
                  ? 'bg-blue-50 border-blue-200 text-blue-800'
                  : 'bg-gray-100 border-gray-200 text-gray-800'
              }`}
            >
              <button
                type="button"
                aria-label={isPinned ? `Unpin ${labelForCode(code)} as default` : `Pin ${labelForCode(code)} as default`}
                aria-pressed={isPinned}
                title={isPinned ? 'Click to unset as default' : 'Click to set as default'}
                onClick={() => togglePin(code)}
                className={`flex items-center gap-1.5 pl-3 pr-2 py-1 hover:brightness-95 active:brightness-90 ${
                  isPinned ? 'text-blue-800' : 'text-gray-800'
                }`}
              >
                <Pin
                  size={14}
                  className={isPinned ? 'text-blue-600' : 'text-gray-400'}
                  fill={isPinned ? 'currentColor' : 'none'}
                />
                {labelForCode(code)}
              </button>
              <button
                type="button"
                aria-label={`Remove ${labelForCode(code)}`}
                onClick={() => removeRecent(code)}
                className={`pr-2.5 pl-0.5 py-1 leading-none ${isPinned ? 'text-blue-400 hover:text-blue-700' : 'text-gray-400 hover:text-gray-700'}`}
              >
                ×
              </button>
            </span>
          );
        })}

        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={recents.length >= 5}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-300 px-3 py-1 text-sm text-gray-600 hover:border-gray-400 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              ＋ Add language
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-0 border-0 shadow-none bg-transparent">
            <LanguagePickerPopover
              mode="settings"
              value={null}
              onChange={(code) => {
                if (code) addRecent(code);
                setPickerOpen(false);
              }}
              onClose={() => setPickerOpen(false)}
            />
          </PopoverContent>
        </Popover>
      </div>

      <p className="text-xs text-gray-400 mt-3">
        {pinned
          ? `始终使用：${labelForCode(pinned)}。此设置会覆盖每个会议的自动语言判断。`
          : '自动模式会根据会议转写内容判断总结语言。'}
      </p>
    </div>
  );
}
