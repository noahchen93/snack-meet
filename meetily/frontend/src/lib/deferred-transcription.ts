export interface DeferredTranscriptionJob {
  meetingId: string;
  autoSummarize: boolean;
}

const PREFIX = 'snackmeet_deferred_transcription:';

function key(meetingId: string): string {
  return `${PREFIX}${meetingId}`;
}

export function rememberDeferredTranscription(job: DeferredTranscriptionJob): void {
  sessionStorage.setItem(key(job.meetingId), JSON.stringify(job));
}

export function forgetDeferredTranscription(meetingId: string): void {
  sessionStorage.removeItem(key(meetingId));
}

export function takeDeferredTranscription(meetingId: string): DeferredTranscriptionJob | null {
  const storageKey = key(meetingId);
  const raw = sessionStorage.getItem(storageKey);
  if (!raw) return null;
  sessionStorage.removeItem(storageKey);

  try {
    return JSON.parse(raw) as DeferredTranscriptionJob;
  } catch {
    return null;
  }
}
