'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSidebar, CurrentMeeting } from '@/components/Sidebar/SidebarProvider';
import { Mic2, ChevronRight, Clock, FileText, Search } from 'lucide-react';

interface HomeMeeting extends CurrentMeeting {}

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const isThisYear = d.getFullYear() === now.getFullYear();
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `今天 ${time}`;
  if (isThisYear) return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function HomeDashboard() {
  const { meetings, refetchMeetings } = useSidebar();
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    refetchMeetings().finally(() => setLoading(false));
  }, [refetchMeetings]);

  // Most recent first (backend already orders by created_at DESC)
  const recent = meetings.slice(0, 8);

  return (
    <div className="w-full max-w-5xl mx-auto px-6 py-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">最近的会议</h1>
        <p className="text-sm text-gray-500 mt-1">快速查看和回听你的录音记录</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-32 rounded-xl bg-gray-100 animate-pulse"></div>
          ))}
        </div>
      ) : recent.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 rounded-full bg-indigo-50 flex items-center justify-center mb-4">
            <Mic2 className="w-8 h-8 text-indigo-400" />
          </div>
          <p className="text-lg font-medium text-gray-700">还没有录音记录</p>
          <p className="text-sm text-gray-400 mt-1">开启录音后，你的会议记录会显示在这里</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {recent.map((meeting) => (
            <button
              key={meeting.id}
              onClick={() => router.push(`/meeting-details?id=${meeting.id}`)}
              className="group text-left rounded-xl border border-gray-200 bg-white p-4 hover:border-indigo-300 hover:shadow-md transition-all"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-800 truncate group-hover:text-indigo-600 transition-colors">
                    {meeting.title || '未命名会议'}
                  </p>
                  <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {formatDate(meeting.createdAt)}
                  </p>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-indigo-400 shrink-0 mt-1" />
              </div>
              <div className="flex items-center gap-1.5 mt-3">
                <span className="inline-flex items-center gap-1 rounded-md bg-gray-50 px-2 py-0.5 text-[10px] text-gray-500">
                  <FileText className="w-3 h-3" />
                  查看记录
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {recent.length > 8 && (
        <div className="mt-6 text-center">
          <button
            onClick={() => router.push('/')}
            className="inline-flex items-center gap-1 text-sm text-indigo-600 hover:text-indigo-500"
          >
            在侧边栏查看全部记录
          </button>
        </div>
      )}
    </div>
  );
}
