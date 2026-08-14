'use client';

import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { useRecordingState } from '@/contexts/RecordingStateContext';


interface SidebarItem {
  id: string;
  title: string;
  type: 'folder' | 'file';
  children?: SidebarItem[];
  is_imported?: boolean;
  is_read?: boolean;
}

export interface CurrentMeeting {
  id: string;
  title: string;
  createdAt?: string;
  is_imported?: boolean;
  is_read?: boolean;
  audioExists?: boolean;
  audioSizeBytes?: number;
  transcriptCharCount?: number;
  transcriptSegmentCount?: number;
  durationSeconds?: number;
  keywords?: string[];
  hasSummary?: boolean;
  collectionId?: string | null;
  isArchived?: boolean;
  isFavorite?: boolean;
}

export interface LibraryCollection {
  id: string;
  name: string;
  color?: string | null;
  sortOrder: number;
  meetingCount: number;
}

export type LibraryView =
  | { kind: 'all' }
  | { kind: 'inbox' }
  | { kind: 'favorites' }
  | { kind: 'archived' }
  | { kind: 'collection'; collectionId: string };

// One de-duplicated global-search result per meeting.
export interface TranscriptSearchResult {
  id: string;
  title: string;
  matchContext: string;
  timestamp: string;
  matchTypes: Array<'title' | 'transcript' | 'original' | 'summary'>;
  matchCount: number;
}

interface SidebarContextType {
  currentMeeting: CurrentMeeting | null;
  setCurrentMeeting: (meeting: CurrentMeeting | null) => void;
  sidebarItems: SidebarItem[];
  isCollapsed: boolean;
  toggleCollapse: () => void;
  meetings: CurrentMeeting[];
  setMeetings: (meetings: CurrentMeeting[]) => void;
  isMeetingActive: boolean;
  setIsMeetingActive: (active: boolean) => void;
  handleRecordingToggle: () => void;
  searchTranscripts: (query: string) => Promise<void>;
  searchResults: TranscriptSearchResult[];
  isSearching: boolean;
  collections: LibraryCollection[];
  refetchCollections: () => Promise<void>;
  libraryView: LibraryView;
  setLibraryView: (view: LibraryView) => void;
  setServerAddress: (address: string) => void;
  serverAddress: string;
  transcriptServerAddress: string;
  setTranscriptServerAddress: (address: string) => void;
  // Summary polling management
  startSummaryPolling: (meetingId: string, processId: string, onUpdate: (result: any) => void) => void;
  stopSummaryPolling: (meetingId: string) => void;
  // Refetch meetings from backend
  refetchMeetings: () => Promise<void>;

}

const SidebarContext = createContext<SidebarContextType | null>(null);

export const useSidebar = () => {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider');
  }
  return context;
};

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [currentMeeting, setCurrentMeeting] = useState<CurrentMeeting | null>({ id: 'intro-call', title: '+ New Call' });
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [meetings, setMeetings] = useState<CurrentMeeting[]>([]);
  const [sidebarItems, setSidebarItems] = useState<SidebarItem[]>([]);
  const [isMeetingActive, setIsMeetingActive] = useState(false);
  const [searchResults, setSearchResults] = useState<TranscriptSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [collections, setCollections] = useState<LibraryCollection[]>([]);
  const [libraryView, setLibraryView] = useState<LibraryView>({ kind: 'all' });
  const [serverAddress, setServerAddress] = useState('');
  const [transcriptServerAddress, setTranscriptServerAddress] = useState('');
  const activeSummaryPollsRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const searchRequestIdRef = useRef(0);

  // Use recording state from RecordingStateContext (single source of truth)
  const { isRecording } = useRecordingState();

  const pathname = usePathname();
  const router = useRouter();

  // Extract fetchMeetings as a reusable function
  const fetchMeetings = React.useCallback(async () => {
    try {
        const meetings = await invoke('api_get_meetings') as Array<{ id: string, title: string, createdAt?: string, is_imported?: boolean, is_read?: boolean, audioExists?: boolean, audioSizeBytes?: number, transcriptCharCount?: number, transcriptSegmentCount?: number, durationSeconds?: number, keywords?: string[], hasSummary?: boolean, collectionId?: string | null, isArchived?: boolean, isFavorite?: boolean }>;
        const transformedMeetings = meetings.map((meeting: any) => ({
          id: meeting.id,
          title: meeting.title,
          createdAt: meeting.createdAt,
          is_imported: !!meeting.is_imported,
          is_read: !!meeting.is_read,
          audioExists: !!meeting.audioExists,
          audioSizeBytes: meeting.audioSizeBytes || 0,
          transcriptCharCount: meeting.transcriptCharCount || 0,
          transcriptSegmentCount: meeting.transcriptSegmentCount || 0,
          durationSeconds: meeting.durationSeconds || 0,
          keywords: Array.isArray(meeting.keywords) ? meeting.keywords : [],
          hasSummary: !!meeting.hasSummary,
          collectionId: meeting.collectionId || null,
          isArchived: !!meeting.isArchived,
          isFavorite: !!meeting.isFavorite,
        }));
        setMeetings(transformedMeetings);
    } catch (error) {
      console.error('Error fetching meetings:', error);
      setMeetings([]);
    }
  }, []);

  const fetchCollections = React.useCallback(async () => {
    try {
      const result = await invoke<LibraryCollection[]>('api_list_collections');
      setCollections(result);
    } catch (error) {
      console.error('Error fetching meeting folders:', error);
      setCollections([]);
    }
  }, []);

  useEffect(() => {
    fetchMeetings();
  }, [fetchMeetings]);

  useEffect(() => {
    fetchCollections();
  }, [fetchCollections]);

  useEffect(() => {
    const fetchSettings = async () => {
      setServerAddress('http://localhost:5167');
      setTranscriptServerAddress('http://127.0.0.1:8178/stream');
    };
    fetchSettings();
  }, []);

  const baseItems: SidebarItem[] = [
    {
      id: 'meetings',
      title: 'Meeting Notes',
      type: 'folder' as const,
      children: [
        ...meetings.map(meeting => ({ id: meeting.id, title: meeting.title, type: 'file' as const, is_imported: meeting.is_imported, is_read: meeting.is_read }))
      ]
    },
  ];


  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed);
  };

  // Update current meeting when on home page
  useEffect(() => {
    if (pathname === '/') {
      setCurrentMeeting({ id: 'intro-call', title: '+ New Call' });
    }
    setSidebarItems(baseItems);
  }, [pathname]);

  // Update sidebar items when meetings change
  useEffect(() => {
    setSidebarItems(baseItems);
  }, [meetings]);

  // Function to handle recording toggle from sidebar
  const handleRecordingToggle = () => {
    if (!isRecording) {
      // Check if already on home page
      if (pathname === '/') {
        // Already on home - trigger recording directly via custom event
        console.log('Triggering recording from sidebar (already on home page)');
        window.dispatchEvent(new CustomEvent('start-recording-from-sidebar'));
      } else {
        // Not on home - navigate and use auto-start mechanism
        console.log('Navigating to home page with auto-start flag');
        sessionStorage.setItem('autoStartRecording', 'true');
        router.push('/');
      }
    }
    // The actual recording start/stop is handled in the Home component
  };

  // Global search across title, complete transcript, original segments and summary.
  // The request id prevents a slower old query from replacing newer results.
  const searchTranscripts = React.useCallback(async (query: string) => {
    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    if (!query.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    try {
      setIsSearching(true);


      const results = await invoke('api_search_transcripts', { query }) as TranscriptSearchResult[];
      if (searchRequestIdRef.current === requestId) setSearchResults(results);
    } catch (error) {
      console.error('Error searching transcripts:', error);
      if (searchRequestIdRef.current === requestId) setSearchResults([]);
    } finally {
      if (searchRequestIdRef.current === requestId) setIsSearching(false);
    }
  }, []);

  // Summary polling management
  const startSummaryPolling = React.useCallback((
    meetingId: string,
    processId: string,
    onUpdate: (result: any) => void
  ) => {
    // Stop existing poll for this meeting if any
    const existing = activeSummaryPollsRef.current.get(meetingId);
    if (existing) {
      clearInterval(existing);
    }

    console.log(`📊 Starting polling for meeting ${meetingId}, process ${processId}`);

    let pollCount = 0;
    const MAX_POLLS = 180; // 15 minutes at 5-second intervals

    const pollInterval = setInterval(async () => {
      pollCount++;

      // Timeout safety: stop after 15 minutes.
      if (pollCount >= MAX_POLLS) {
        console.warn(`⏱️ Polling timeout for ${meetingId} after ${MAX_POLLS} iterations`);
        clearInterval(pollInterval);
        activeSummaryPollsRef.current.delete(meetingId);
        onUpdate({
          status: 'error',
          error: 'Summary generation timed out after 15 minutes. Please try again or check your model configuration.'
        });
        return;
      }
      try {
        const result = await invoke('api_get_summary', {
          meetingId: meetingId,
        }) as any;

        console.log(`📊 Polling update for ${meetingId}:`, result.status);

        // Call the update callback with result
        onUpdate(result);

        // Stop polling if completed, error, failed, cancelled, or idle (after initial processing)
        if (result.status === 'completed' || result.status === 'error' || result.status === 'failed' || result.status === 'cancelled') {
          console.log(`Polling completed for ${meetingId}, status: ${result.status}`);
          clearInterval(pollInterval);
          activeSummaryPollsRef.current.delete(meetingId);
        } else if (result.status === 'idle' && pollCount > 1) {
          // If we get 'idle' after polling started, process completed/disappeared
          console.log(`Process completed or not found for ${meetingId}, stopping poll`);
          clearInterval(pollInterval);
          activeSummaryPollsRef.current.delete(meetingId);
        }
      } catch (error) {
        console.error(`Polling error for ${meetingId}:`, error);
        // Report error to callback
        onUpdate({
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        clearInterval(pollInterval);
        activeSummaryPollsRef.current.delete(meetingId);
      }
    }, 5000); // Poll every 5 seconds

    activeSummaryPollsRef.current.set(meetingId, pollInterval);
  }, []);

  const stopSummaryPolling = React.useCallback((meetingId: string) => {
    const pollInterval = activeSummaryPollsRef.current.get(meetingId);
    if (pollInterval) {
      console.log(`⏹️ Stopping polling for meeting ${meetingId}`);
      clearInterval(pollInterval);
      activeSummaryPollsRef.current.delete(meetingId);
    }
  }, []);

  // Cleanup all polling intervals on unmount
  useEffect(() => {
    return () => {
      console.log('🧹 Cleaning up all summary polling intervals');
      activeSummaryPollsRef.current.forEach(interval => clearInterval(interval));
      activeSummaryPollsRef.current.clear();
    };
  }, []);



  return (
    <SidebarContext.Provider value={{
      currentMeeting,
      setCurrentMeeting,
      sidebarItems,
      isCollapsed,
      toggleCollapse,
      meetings,
      setMeetings,
      isMeetingActive,
      setIsMeetingActive,
      handleRecordingToggle,
      searchTranscripts,
      searchResults,
      isSearching,
      collections,
      refetchCollections: fetchCollections,
      libraryView,
      setLibraryView,
      setServerAddress,
      serverAddress,
      transcriptServerAddress,
      setTranscriptServerAddress,
      startSummaryPolling,
      stopSummaryPolling,
      refetchMeetings: fetchMeetings,

    }}>
      {children}
    </SidebarContext.Provider>
  );
}
