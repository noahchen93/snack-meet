const PLACEHOLDER_PATTERNS = [
  /^\+ New Call$/i,
  /^Meeting \d{2}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}$/,
  /^Snack Meet-\d{8}-\d{6}(?:\.txt)?$/,
];

export function createSmartMeetingName(date = new Date(), source?: string): string {
  const day = new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(date);
  const time = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  const cleanSource = source?.trim().replace(/\.(txt|md)$/i, '');
  return `${cleanSource || '会议'} · ${day} ${time}`;
}

export function isPlaceholderMeetingName(name?: string | null): boolean {
  const value = name?.trim();
  return !value || PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

export function meetingNameFromDetection(appName: string, windowTitle: string): string {
  const title = windowTitle.trim();
  const genericTitles = new Set([
    '',
    'TencentMeeting',
    'Tencent Meeting',
    '腾讯会议',
    'Zoom Meeting',
    'zoom.us',
  ]);
  return createSmartMeetingName(new Date(), genericTitles.has(title) ? appName : title);
}
