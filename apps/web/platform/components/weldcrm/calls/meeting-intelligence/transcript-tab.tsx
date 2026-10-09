
import { useCallback, memo } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyStateIllustration } from '@/components/entity-list';
import {
  Loader2,
  User,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatSegmentTime, parseSpeakerId } from './utils';
import { getSpeakerColor } from './speaker-colors';
import { TranscriptionProgress } from './transcription-progress';
import type { TranscriptionSegment, WordTiming } from './types';
import { useTranslations } from '@weldsuite/i18n/client';

const WordSpan = memo(function WordSpan({
  word,
  isActive,
  isSearchMatch,
  onSeek,
}: {
  word: WordTiming;
  isActive: boolean;
  isSearchMatch: boolean;
  onSeek: (time: number) => void;
}) {
  return (
    <>
      {/* Word-level seeking is a pointer shortcut; keyboard users seek by
          segment through the speaker button above, so words stay out of the
          tab order. */}
      <button
        type="button"
        tabIndex={-1}
        onClick={() => onSeek(word.start)}
        className={cn(
          "inline cursor-pointer select-text rounded-[2px] px-[1px] text-left transition-colors duration-75",
          isActive && "bg-yellow-200/70 dark:bg-yellow-700/40 text-yellow-900 dark:text-yellow-100 ring-1 ring-yellow-300/60 dark:ring-yellow-600/40",
          isSearchMatch && !isActive && "bg-yellow-200 dark:bg-yellow-800/60",
          !isActive && !isSearchMatch && "hover:bg-gray-200/70 dark:hover:bg-gray-700/50"
        )}
      >
        {word.text}
      </button>{' '}
    </>
  );
});

interface TranscriptTabProps {
  segments: TranscriptionSegment[] | undefined;
  isLoading: boolean;
  isTranscribing: boolean;
  /** The last transcription attempt failed; the empty state offers a retry. */
  transcriptionFailed?: boolean;
  transcriptionProgress: number;
  hasTranscription: boolean;
  activeSegmentId: string | null;
  autoScroll: boolean;
  onAutoScrollChange: (value: boolean) => void;
  onSeekToSegment: (startTime: number) => void;
  onTranscribe?: () => void;
  /** Replaces the "transcribe to see the conversation" line of the empty state. */
  emptyHint?: string;
  segmentRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
}
export function TranscriptTabContent({
  segments,
  isLoading,
  isTranscribing,
  transcriptionFailed = false,
  transcriptionProgress,
  activeSegmentId,
  activeWordIndex = -1,
  searchQuery,
  onSeekToSegment,
  onSeekToTime,
  onTranscribe,
  emptyHint,
  segmentRefs,
}: Omit<TranscriptTabProps, 'autoScroll' | 'onAutoScrollChange'> & {
  searchQuery: string;
  activeWordIndex?: number;
  onSeekToTime?: (time: number) => void;
}) {
  const t = useTranslations();
  const highlightText = useCallback((text: string) => {
    if (!searchQuery) return text;
    const regex = new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)})`, 'gi');
    const parts = text.split(regex);
    if (parts.length === 1) return text;
    // Key each match by its offset in the text.
    let offset = 0;
    return parts.map((part) => {
      const at = offset;
      offset += part.length;
      return regex.test(part) ? <mark key={at} className="bg-yellow-200 dark:bg-yellow-800/60 text-inherit rounded-sm px-0.5">{part}</mark> : part;
    });
  }, [searchQuery]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t('sweep.weldcrm.transcriptTab.loading')}</span>
      </div>
    );
  }

  if (segments && segments.length > 0) {
    const filtered = segments.filter((segment) => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      const text = (segment.text || '').toLowerCase();
      const speaker = (segment.speakerName || segment.speaker || '').toLowerCase();
      return text.includes(q) || speaker.includes(q);
    });

    return (
      <div className="divide-y divide-gray-100 dark:divide-border py-2">
        {filtered.map((segment, index) => {
          const speakerId = parseSpeakerId(segment.speaker || `${index}`);
          const colors = getSpeakerColor(speakerId);
          const isActive = segment.id === activeSegmentId;

          return (
            <div
              key={segment.id}
              ref={(el) => {
                if (el) segmentRefs.current.set(segment.id, el);
              }}
              className={cn(
                "group flex gap-3 py-4 px-4 transition-colors duration-200",
                isActive
                  ? "bg-blue-50/50 dark:bg-blue-950/20"
                  : "hover:bg-gray-50 dark:hover:bg-background/50"
              )}
            >
              <div className="flex-1 min-w-0">
                <button
                  type="button"
                  onClick={() => onSeekToSegment(segment.start)}
                  className="flex w-full cursor-pointer items-center gap-2 mb-1 text-left"
                >
                  <span className={cn(
                    "h-5 w-5 rounded-md flex-shrink-0 flex items-center justify-center text-xs font-semibold text-white",
                    colors.bg
                  )}>
                    <User className="h-3 w-3" />
                  </span>
                  <span className={cn(
                    "text-sm font-semibold",
                    isActive ? "text-blue-600" : "text-gray-900 dark:text-foreground"
                  )}>
                    {segment.speakerName || segment.speaker || t('sweep.weldcrm.transcriptTab.speakerNumber', { number: speakerId })}
                  </span>
                  <span className="ml-auto text-xs font-mono text-gray-400 dark:text-muted-foreground">
                    {segment.timestamp || formatSegmentTime(segment.start)}
                  </span>
                </button>
                {segment.words && segment.words.length > 0 ? (
                  <p className={cn(
                    "text-sm leading-relaxed",
                    isActive
                      ? "text-gray-800 dark:text-foreground"
                      : "text-gray-600 dark:text-muted-foreground"
                  )}>
                    {segment.words.map((word, wordIdx) => (
                      <WordSpan
                        key={`${word.start}-${word.text}`}
                        word={word}
                        isActive={isActive && wordIdx === activeWordIndex}
                        isSearchMatch={!!searchQuery && word.text.toLowerCase().includes(searchQuery.toLowerCase())}
                        onSeek={onSeekToTime || onSeekToSegment}
                      />
                    ))}
                  </p>
                ) : (
                  <p className={cn(
                    "text-sm leading-relaxed",
                    isActive
                      ? "text-gray-800 dark:text-foreground"
                      : "text-gray-600 dark:text-muted-foreground"
                  )}>
                    {highlightText(segment.text)}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  if (isTranscribing) {
    return <TranscriptionProgress progress={transcriptionProgress} />;
  }

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <EmptyStateIllustration>
        <svg width="120" height="140" viewBox="0 0 120 140" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ transform: 'perspective(600px) rotateY(-6deg) rotateX(4deg)' }}>
          <rect x="18" y="20" width="84" height="100" rx="6" className="fill-white dark:fill-white/[0.03]" />
          <rect x="18" y="20" width="84" height="100" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
          <rect x="28" y="36" width="40" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" />
          <rect x="28" y="46" width="64" height="2.5" rx="1.25" className="fill-gray-100 dark:fill-white/10" />
          <rect x="28" y="53" width="52" height="2.5" rx="1.25" className="fill-gray-100 dark:fill-white/10" />
          <rect x="28" y="66" width="36" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" />
          <rect x="28" y="76" width="64" height="2.5" rx="1.25" className="fill-gray-100 dark:fill-white/10" />
          <rect x="28" y="83" width="44" height="2.5" rx="1.25" className="fill-gray-100 dark:fill-white/10" />
          <rect x="28" y="96" width="30" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" />
          <rect x="28" y="106" width="56" height="2.5" rx="1.25" className="fill-gray-100 dark:fill-white/10" />
        </svg>
      </EmptyStateIllustration>
      <p className="text-sm font-medium text-foreground mb-1">
        {transcriptionFailed
          ? t('sweep.weldcrm.meetingIntelligence.transcriptionFailed')
          : t('sweep.weldcrm.globalFloatingCall.noTranscriptAvailable')}
      </p>
      <p className="text-xs text-muted-foreground mb-4 max-w-sm">
        {transcriptionFailed
          ? t('sweep.weldcrm.transcriptTab.transcriptionFailedDescription')
          : (emptyHint ?? t('sweep.weldcrm.transcriptTab.transcribeToSeeConversation'))}
      </p>
      {onTranscribe && (
        <Button
          variant="outline"
          size="sm"
          className="h-[34px]"
          onClick={onTranscribe}
        >
          {transcriptionFailed
            ? t('sweep.weldcrm.transcriptTab.tryAgain')
            : t('sweep.weldcrm.meetingIntelligenceHeader.transcribe')}
        </Button>
      )}
    </div>
  );
}
