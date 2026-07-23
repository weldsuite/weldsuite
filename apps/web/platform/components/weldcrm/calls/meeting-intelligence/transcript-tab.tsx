
import { useState, useRef, useCallback, memo } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyStateIllustration } from '@/components/entity-list';
import {
  Captions,
  Loader2,
  Search,
  User,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatSegmentTime } from './utils';
import { getSpeakerColor } from './speaker-colors';
import { parseSpeakerId } from './utils';
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
      <span
        onClick={(e) => {
          e.stopPropagation();
          onSeek(word.start);
        }}
        className={cn(
          "cursor-pointer rounded-[2px] px-[1px] transition-colors duration-75",
          isActive && "bg-yellow-200/70 dark:bg-yellow-700/40 text-yellow-900 dark:text-yellow-100 ring-1 ring-yellow-300/60 dark:ring-yellow-600/40",
          isSearchMatch && !isActive && "bg-yellow-200 dark:bg-yellow-800/60",
          !isActive && !isSearchMatch && "hover:bg-gray-200/70 dark:hover:bg-gray-700/50"
        )}
      >
        {word.text}
      </span>{' '}
    </>
  );
});

interface TranscriptTabProps {
  segments: TranscriptionSegment[] | undefined;
  isLoading: boolean;
  isTranscribing: boolean;
  transcriptionProgress: number;
  hasTranscription: boolean;
  activeSegmentId: string | null;
  autoScroll: boolean;
  onAutoScrollChange: (value: boolean) => void;
  onSeekToSegment: (startTime: number) => void;
  onTranscribe?: () => void;
  segmentRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
}

function TranscriptTab({
  segments,
  isLoading,
  isTranscribing,
  transcriptionProgress,
  hasTranscription,
  activeSegmentId,
  autoScroll,
  onAutoScrollChange,
  onSeekToSegment,
  onTranscribe,
  segmentRefs,
}: TranscriptTabProps) {
  const t = useTranslations();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const highlightText = useCallback((text: string) => {
    if (!searchQuery) return text;
    const regex = new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = text.split(regex);
    if (parts.length === 1) return text;
    return parts.map((part, i) =>
      regex.test(part) ? <mark key={i} className="bg-yellow-200 dark:bg-yellow-800/60 text-inherit rounded-sm px-0.5">{part}</mark> : part
    );
  }, [searchQuery]);

  const filteredSegments = segments?.filter((segment) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const text = (segment.text || '').toLowerCase();
    const speaker = (segment.speakerName || segment.speaker || '').toLowerCase();
    return text.includes(q) || speaker.includes(q);
  });

  return (
    <>
      {/* Tab toolbar - rendered via the tab header area */}
      {segments && segments.length > 0 && (
        <div className="ml-auto flex items-center gap-1.5">
          {/* Search */}
          <div className="relative flex items-center">
            <div className={cn(
              "flex items-center transition-all duration-200 ease-out",
              searchOpen ? "w-48" : "w-8"
            )}>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-8 w-8 p-0 flex-shrink-0 transition-opacity duration-200",
                  searchOpen && "opacity-0 pointer-events-none absolute"
                )}
                onClick={() => {
                  setSearchOpen(true);
                  setTimeout(() => searchRef.current?.focus(), 50);
                }}
              >
                <Search className="h-4 w-4" />
              </Button>
              <div className={cn(
                "relative transition-all duration-200 ease-out",
                searchOpen ? "opacity-100 w-48" : "opacity-0 w-0 pointer-events-none"
              )}>
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  ref={searchRef}
                  type="text"
                  placeholder={t('sweep.weldcrm.meetingIntelligence.searchTranscript')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onBlur={() => !searchQuery && setSearchOpen(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setSearchQuery('');
                      setSearchOpen(false);
                    }
                  }}
                  className="h-8 w-full pl-8 pr-3 text-sm border border-gray-200 dark:border-border rounded-md bg-white dark:bg-background focus:outline-none"
                />
              </div>
            </div>
          </div>
          {/* Auto-scroll toggle */}
          <Button
            variant="ghost"
            onClick={() => onAutoScrollChange(!autoScroll)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium border transition-colors whitespace-nowrap",
              autoScroll
                ? "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800"
                : "text-gray-600 dark:text-muted-foreground border-gray-200 dark:border-border"
            )}
          >
            {autoScroll ? t('sweep.weldcrm.transcriptTab.autoScrollOn') : t('sweep.weldcrm.transcriptTab.autoScrollOff')}
          </Button>
        </div>
      )}
    </>
  );
}

export function TranscriptTabContent({
  segments,
  isLoading,
  isTranscribing,
  transcriptionProgress,
  hasTranscription,
  activeSegmentId,
  activeWordIndex = -1,
  searchQuery,
  onSeekToSegment,
  onSeekToTime,
  onTranscribe,
  segmentRefs,
}: Omit<TranscriptTabProps, 'autoScroll' | 'onAutoScrollChange'> & {
  searchQuery: string;
  activeWordIndex?: number;
  onSeekToTime?: (time: number) => void;
}) {
  const t = useTranslations();
  const highlightText = useCallback((text: string) => {
    if (!searchQuery) return text;
    const regex = new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = text.split(regex);
    if (parts.length === 1) return text;
    return parts.map((part, i) =>
      regex.test(part) ? <mark key={i} className="bg-yellow-200 dark:bg-yellow-800/60 text-inherit rounded-sm px-0.5">{part}</mark> : part
    );
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
              onClick={() => {
                const selection = window.getSelection();
                if (selection && selection.toString().length > 0) return;
                onSeekToSegment(segment.start);
              }}
              className={cn(
                "group flex gap-3 py-4 px-4 cursor-pointer transition-colors duration-200",
                isActive
                  ? "bg-blue-50/50 dark:bg-blue-950/20"
                  : "hover:bg-gray-50 dark:hover:bg-background/50"
              )}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <div className={cn(
                    "h-5 w-5 rounded-md flex-shrink-0 flex items-center justify-center text-xs font-semibold text-white",
                    colors.bg
                  )}>
                    <User className="h-3 w-3" />
                  </div>
                  <span className={cn(
                    "text-sm font-semibold",
                    isActive ? "text-blue-600" : "text-gray-900 dark:text-foreground"
                  )}>
                    {segment.speakerName || segment.speaker || t('sweep.weldcrm.transcriptTab.speakerNumber', { number: speakerId })}
                  </span>
                  <span className="ml-auto text-xs font-mono text-gray-400 dark:text-muted-foreground">
                    {segment.timestamp || formatSegmentTime(segment.start)}
                  </span>
                </div>
                {segment.words && segment.words.length > 0 ? (
                  <p className={cn(
                    "text-sm leading-relaxed",
                    isActive
                      ? "text-gray-800 dark:text-foreground"
                      : "text-gray-600 dark:text-muted-foreground"
                  )}>
                    {segment.words.map((word, wordIdx) => (
                      <WordSpan
                        key={wordIdx}
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
      <p className="text-sm font-medium text-foreground mb-1">{t('sweep.weldcrm.globalFloatingCall.noTranscriptAvailable')}</p>
      <p className="text-xs text-muted-foreground mb-4">{t('sweep.weldcrm.transcriptTab.transcribeToSeeConversation')}</p>
      {onTranscribe && (
        <Button
          variant="outline"
          size="sm"
          className="h-[34px]"
          onClick={onTranscribe}
        >
          {t('sweep.weldcrm.meetingIntelligenceHeader.transcribe')}
        </Button>
      )}
    </div>
  );
}
