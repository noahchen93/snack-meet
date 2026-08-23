'use client';

import { useRef, useReducer, startTransition, useEffect, memo, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useTranscriptStreaming } from "@/hooks/useTranscriptStreaming";
import { ConfidenceIndicator } from "./ConfidenceIndicator";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { RecordingStatusBar } from "./RecordingStatusBar";
import { motion, AnimatePresence } from "framer-motion";
import { TranscriptSegmentData } from "@/types";
import { User, Monitor } from "lucide-react";

export interface VirtualizedTranscriptViewProps {
    /** Transcript segments to display */
    segments: TranscriptSegmentData[];
    /** Whether recording is in progress */
    isRecording?: boolean;
    /** Whether recording is paused */
    isPaused?: boolean;
    /** Whether processing/finalizing transcription */
    isProcessing?: boolean;
    /** Whether stopping */
    isStopping?: boolean;
    /** Enable streaming effect for latest segment */
    enableStreaming?: boolean;
    /** Show confidence indicators */
    showConfidence?: boolean;
    /** Completely disable auto-scroll behavior (for meeting details page) */
    disableAutoScroll?: boolean;

    // Pagination props (infinite scroll)
    hasMore?: boolean;
    isLoadingMore?: boolean;
    totalCount?: number;
    loadedCount?: number;
    onLoadMore?: () => void;
    /** Current meeting-audio position for subtitle synchronization. */
    playbackTime?: number;
    /** Auto-follow the active subtitle while audio is playing. */
    isAudioPlaying?: boolean;
    /** Seek audio when a transcript timestamp is clicked. */
    onSeekTo?: (seconds: number) => void;
    /** Available speaker names for per-segment reassignment. */
    speakerOptions?: string[];
    /** Whether to show per-segment speaker dropdowns. */
    editingSpeakers?: boolean;
    /** Called when a segment's speaker is reassigned. */
    onSegmentSpeakerChange?: (segmentId: string, speaker: string) => void;
}

// Threshold for enabling virtualization (below this, use simple rendering)
const VIRTUALIZATION_THRESHOLD = 10;

// Helper to map backend speaker labels to a friendly badge
// "local"/"remote" keep the fixed 你/对方 labels; any other string (e.g. a
// diarized speaker name like "张三" imported from a desktop machine) is shown
// verbatim so multi-speaker transcripts render their real names.
function getSpeakerBadge(speaker: string | undefined): { icon: React.ReactNode; label: string; color: string } | null {
    if (!speaker) return null;
    switch (speaker) {
        case 'local':
            return { icon: <User className="w-3 h-3" />, label: '你', color: 'bg-blue-100 text-blue-700 border-blue-200' };
        case 'remote':
            return { icon: <Monitor className="w-3 h-3" />, label: '对方', color: 'bg-emerald-100 text-emerald-700 border-emerald-200' };
        default:
            return { icon: <User className="w-3 h-3" />, label: speaker, color: 'bg-indigo-50 text-indigo-700 border-indigo-200' };
    }
}

// Helper function to format seconds as recording-relative time [MM:SS]
function formatRecordingTime(seconds: number | undefined): string {
    if (seconds === undefined) return '[--:--]';

    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;

    return `[${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
}

// Helper function to remove filler words and repetitions
function cleanStopWords(text: string): string {
    const stopWords = ['uh', 'um', 'er', 'ah', 'hmm', 'hm', 'eh', 'oh'];

    let cleanedText = text;
    stopWords.forEach(word => {
        const pattern = new RegExp(`\\b${word}\\b[,\\s]*`, 'gi');
        cleanedText = cleanedText.replace(pattern, ' ');
    });

    return cleanedText.replace(/\s+/g, ' ').trim();
}

// Memoized transcript segment component
const TranscriptSegment = memo(function TranscriptSegment({
    id,
    timestamp,
    text,
    confidence,
    isStreaming,
    showConfidence,
    speaker,
    isActive,
    onSeekTo,
    speakerOptions,
    editingSpeakers,
    onSpeakerChange,
}: {
    id: string;
    timestamp: number;
    text: string;
    confidence?: number;
    isStreaming: boolean;
    showConfidence: boolean;
    speaker?: string;
    isActive?: boolean;
    onSeekTo?: (seconds: number) => void;
    speakerOptions?: string[];
    editingSpeakers?: boolean;
    onSpeakerChange?: (segmentId: string, speaker: string) => void;
}) {
    const displayText = cleanStopWords(text) || (text.trim() === '' ? '[Silence]' : text);
    const badge = getSpeakerBadge(speaker);

    return (
        <div
            id={`segment-${id}`}
            className={`mb-3 rounded-lg border px-2 py-2 transition-colors ${isActive ? 'border-indigo-300 bg-indigo-50 shadow-sm' : 'border-transparent'}`}
            aria-current={isActive ? 'true' : undefined}
        >
            <div className="flex items-start gap-2">
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            onClick={() => onSeekTo?.(timestamp)}
                            disabled={!onSeekTo}
                            className={`text-xs mt-1 flex-shrink-0 min-w-[50px] text-left ${onSeekTo ? 'cursor-pointer hover:text-indigo-700' : ''} ${isActive ? 'font-semibold text-indigo-700' : 'text-gray-400'}`}
                            title={onSeekTo ? '从这里播放' : undefined}
                        >
                            {formatRecordingTime(timestamp)}
                        </button>
                    </TooltipTrigger>
                    <TooltipContent>
                        {confidence !== undefined && showConfidence && (
                            <ConfidenceIndicator confidence={confidence} showIndicator={showConfidence} />
                        )}
                    </TooltipContent>
                </Tooltip>
                <div className="flex-1">
                    {editingSpeakers && speakerOptions && speakerOptions.length > 0 ? (
                        <select
                            value={speaker || ''}
                            onChange={(e) => onSpeakerChange?.(id, e.target.value)}
                            className="mb-1 inline-block max-w-[180px] rounded border border-indigo-200 bg-white px-1.5 py-0.5 text-xs text-indigo-700 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                            title="重新指定该段说话人"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <option value="" disabled>未指定</option>
                            {speakerOptions.map((opt) => (
                                <option key={opt} value={opt}>{opt}</option>
                            ))}
                        </select>
                    ) : badge ? (
                        <div className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs border mb-1 ${badge.color}`}>
                            {badge.icon}
                            <span>{badge.label}</span>
                        </div>
                    ) : null}
                    {isStreaming ? (
                        <div className="bg-gray-100 border border-gray-200 rounded-lg px-3 py-2">
                            <p className="text-base text-gray-800 leading-relaxed">{displayText}</p>
                        </div>
                    ) : (
                        <p className="text-base text-gray-800 leading-relaxed">{displayText}</p>
                    )}
                </div>
            </div>
        </div>
    );
});

export const VirtualizedTranscriptView: React.FC<VirtualizedTranscriptViewProps> = ({
    segments,
    isRecording = false,
    isPaused = false,
    isProcessing = false,
    isStopping = false,
    enableStreaming = false,
    showConfidence = true,
    disableAutoScroll = false,
    hasMore = false,
    isLoadingMore = false,
    totalCount = 0,
    loadedCount = 0,
    onLoadMore,
    playbackTime,
    isAudioPlaying = false,
    onSeekTo,
    speakerOptions,
    editingSpeakers = false,
    onSegmentSpeakerChange,
}) => {
    // Create scroll ref first - shared between virtualizer and auto-scroll hook
    const scrollRef = useRef<HTMLDivElement>(null);
    // Ref for infinite scroll trigger element
    const loadMoreTriggerRef = useRef<HTMLDivElement>(null);
    const activeSegmentIndex = useMemo(() => {
        if (playbackTime === undefined || segments.length === 0) return -1;
        return segments.findIndex((segment, index) => {
            const nextStart = segments[index + 1]?.timestamp;
            const end = segment.endTime ?? nextStart ?? Number.POSITIVE_INFINITY;
            return playbackTime >= segment.timestamp && playbackTime < end;
        });
    }, [segments, playbackTime]);

    // Force re-render without flushSync (avoids React warning)
    const [, rerender] = useReducer((x: number) => x + 1, 0);

    // Setup virtualizer for efficient rendering of large lists
    const virtualizer = useVirtualizer({
        count: segments.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 60, // Estimated height per segment
        overscan: 10, // Render extra items above/below viewport
        onChange: () => {
            startTransition(() => {
                rerender();
            });
        },
    });

    // Keep the current subtitle centered while audio is playing. Pausing leaves
    // the transcript where the user last listened, so manual reading is not
    // disrupted.
    useEffect(() => {
        if (!isAudioPlaying || activeSegmentIndex < 0) return;
        if (segments.length >= VIRTUALIZATION_THRESHOLD) {
            virtualizer.scrollToIndex(activeSegmentIndex, { align: 'center' });
        } else {
            const active = scrollRef.current?.querySelector(`#segment-${CSS.escape(segments[activeSegmentIndex].id)}`);
            active?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }, [activeSegmentIndex, isAudioPlaying, segments, virtualizer]);

    // Custom hook for auto-scrolling (supports both virtualized and non-virtualized)
    useAutoScroll({
        scrollRef,
        segments,
        isRecording,
        isPaused,
        virtualizer,
        virtualizationThreshold: VIRTUALIZATION_THRESHOLD,
        disableAutoScroll,
    });

    // Streaming text effect hook (typewriter animation for new transcripts)
    const { streamingSegmentId, getDisplayText } = useTranscriptStreaming(
        segments,
        isRecording,
        enableStreaming
    );

    // Infinite scroll: IntersectionObserver to trigger loading more
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording || segments.length === 0) {
            return;
        }

        const triggerElement = loadMoreTriggerRef.current;
        if (!triggerElement) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
            },
            {
                root: null,
                rootMargin: '100px',
                threshold: 0,
            }
        );

        observer.observe(triggerElement);

        return () => observer.disconnect();
    }, [hasMore, isLoadingMore, onLoadMore, isRecording, segments.length]);

    // Scroll-based fallback for fast scrolling
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording) return;

        const scrollElement = scrollRef.current;
        if (!scrollElement) return;

        let ticking = false;

        const handleScroll = () => {
            if (ticking || isLoadingMore || !hasMore) return;

            ticking = true;
            requestAnimationFrame(() => {
                const { scrollTop, scrollHeight, clientHeight } = scrollElement;
                const scrollBottom = scrollHeight - scrollTop - clientHeight;

                // Trigger load when within 200px of bottom
                if (scrollBottom < 200 && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
                ticking = false;
            });
        };

        scrollElement.addEventListener('scroll', handleScroll, { passive: true });
        return () => scrollElement.removeEventListener('scroll', handleScroll);
    }, [onLoadMore, hasMore, isLoadingMore, isRecording]);

    // Use simple rendering for small lists, virtualization for large lists
    const useVirtualization = segments.length >= VIRTUALIZATION_THRESHOLD;

    return (
        <div ref={scrollRef} className="flex flex-col h-full overflow-y-auto px-4 py-2">
            {/* Recording Status Bar - Sticky at top, always visible when recording */}
            <AnimatePresence>
                {isRecording && (
                    <div className="sticky top-0 z-10 bg-white pb-2">
                        <RecordingStatusBar isPaused={isPaused} />
                    </div>
                )}
            </AnimatePresence>

            {/* Content - add padding when recording to prevent overlap */}
            <div className={isRecording ? 'pt-2' : ''}>
            {segments.length === 0 ? (
                // Empty state
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-center text-gray-500 mt-8"
                >
                    {isRecording ? (
                        <>
                            <div className="flex items-center justify-center mb-3">
                                <div className={`w-3 h-3 rounded-full ${isPaused ? 'bg-orange-500' : 'bg-blue-500 animate-pulse'}`}></div>
                            </div>
                            <p className="text-sm text-gray-600">
                                {isPaused
                                    ? 'Recording paused'
                                    : enableStreaming
                                        ? 'Listening for speech...'
                                        : 'Recording audio only'}
                            </p>
                            <p className="text-xs mt-1 text-gray-400">
                                {isPaused
                                    ? 'Click resume to continue recording'
                                    : enableStreaming
                                        ? 'Speak to see live transcription'
                                        : 'Post-recording transcription follows your settings'}
                            </p>
                        </>
                    ) : (
                        <>
                            <p className="text-lg font-semibold">Welcome to Snack Meet!</p>
                            <p className="text-xs mt-1">Start recording to see live transcription</p>
                        </>
                    )}
                </motion.div>
            ) : useVirtualization ? (
                // Virtualized rendering for large lists
                <>
                    <div
                        style={{
                            height: virtualizer.getTotalSize(),
                            width: "100%",
                            position: "relative",
                        }}
                    >
                        {virtualizer.getVirtualItems().map((virtualRow) => {
                            const segment = segments[virtualRow.index];
                            const isStreaming = streamingSegmentId === segment.id;

                            return (
                                <div
                                    key={segment.id}
                                    data-index={virtualRow.index}
                                    ref={virtualizer.measureElement}
                                    style={{
                                        position: "absolute",
                                        top: 0,
                                        left: 0,
                                        width: "100%",
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        confidence={segment.confidence}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                        speaker={segment.speaker}
                                        isActive={virtualRow.index === activeSegmentIndex}
                                        onSeekTo={onSeekTo}
                                        speakerOptions={speakerOptions}
                                        editingSpeakers={editingSpeakers}
                                        onSpeakerChange={onSegmentSpeakerChange}
                                    />
                                </div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger and loading indicator */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">Loading more...</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-gray-400">
                                    Showing {loadedCount} of {totalCount} segments
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && enableStreaming && segments.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-gray-500"
                        >
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <span className="text-sm">Listening...</span>
                        </motion.div>
                    )}
                </>
            ) : (
                // Simple rendering for small lists (better animations)
                <>
                    <div className="space-y-1">
                        {segments.map((segment) => {
                            const isStreaming = streamingSegmentId === segment.id;

                            return (
                                <motion.div
                                    key={segment.id}
                                    initial={{ opacity: 0, y: 5 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.15 }}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        confidence={segment.confidence}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                        speaker={segment.speaker}
                                        isActive={segments.indexOf(segment) === activeSegmentIndex}
                                        onSeekTo={onSeekTo}
                                        speakerOptions={speakerOptions}
                                        editingSpeakers={editingSpeakers}
                                        onSpeakerChange={onSegmentSpeakerChange}
                                    />
                                </motion.div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger (for small lists that grow) */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">Loading more...</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-gray-400">
                                    Showing {loadedCount} of {totalCount} segments
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-gray-500"
                        >
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <span className="text-sm">Listening...</span>
                        </motion.div>
                    )}
                </>
            )}
            </div>
        </div>
    );
};
