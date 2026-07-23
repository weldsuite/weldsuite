
import { useState, useRef, useCallback } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyStateIllustration } from '@/components/entity-list';
import { Play, Search, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDurationMin, formatSegmentTime } from './utils';
import { getSpeakerColor } from './speaker-colors';
import type { SpeakerInfo } from './types';
import { useTranslations } from '@weldsuite/i18n/client';

interface SpeakersTabProps {
  speakers: SpeakerInfo[];
  totalSpeakingTime: number;
  transcriptionTotalDuration: number;
  smoothTime: number;
  hasTranscription: boolean;
  isTranscribing: boolean;
  onSeekToSegment: (startTime: number) => void;
  onTranscribe?: () => void;
}

function SpeakersTabToolbar({ speakers }: { speakers: SpeakerInfo[] }) {
  const t = useTranslations();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  if (speakers.length === 0) return null;

  return (
    <div className="ml-auto flex items-center">
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
              placeholder={t('sweep.weldcrm.meetingIntelligence.searchSpeakers')}
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
    </div>
  );
}

export function SpeakersTabContent({
  speakers,
  totalSpeakingTime,
  transcriptionTotalDuration,
  smoothTime,
  hasTranscription,
  isTranscribing,
  onSeekToSegment,
  onTranscribe,
}: SpeakersTabProps) {
  const t = useTranslations();
  const [searchQuery, setSearchQuery] = useState('');

  if (speakers.length > 0) {
    const filtered = speakers.filter((speaker) => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      const name = (speaker.name || speaker.label || '').toLowerCase();
      return name.includes(q);
    });

    return (
      <div className="py-3">
        <div className="space-y-5">
          {filtered.map((speaker) => {
            const colors = getSpeakerColor(speaker.id);
            const speakingPercent = totalSpeakingTime > 0
              ? ((speaker.totalDuration / totalSpeakingTime) * 100).toFixed(1)
              : '0';

            return (
              <div key={speaker.label}>
                {/* Speaker info row */}
                <div
                  className="flex items-center gap-2 mb-2 cursor-pointer group/speaker"
                  onClick={() => onSeekToSegment(speaker.firstSegmentStart)}
                >
                  <Play className="h-3.5 w-3.5 text-gray-300 group-hover/speaker:text-gray-500 dark:text-gray-600 dark:group-hover/speaker:text-gray-400 transition-colors flex-shrink-0" />
                  <div className={cn(
                    "h-5 w-5 rounded-md flex-shrink-0 flex items-center justify-center text-xs font-semibold text-white",
                    colors.bg
                  )}>
                    <User className="h-3 w-3" />
                  </div>
                  <span className="text-sm font-medium text-gray-900 dark:text-foreground">
                    {speaker.name || speaker.label}
                  </span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border text-gray-500 dark:text-muted-foreground">
                      {speakingPercent}%
                    </span>
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border text-gray-500 dark:text-muted-foreground">
                      {formatDurationMin(speaker.totalDuration)}
                    </span>
                  </div>
                </div>
                {/* Timeline bar */}
                <div className="h-6 flex items-center relative">
                  <div className="w-full h-1.5 bg-gray-100 dark:bg-secondary rounded-full pointer-events-none" />
                  {transcriptionTotalDuration > 0 && speaker.segments.map((seg, i) => {
                    const left = (seg.start / transcriptionTotalDuration) * 100;
                    const width = Math.max(0.4, ((seg.end - seg.start) / transcriptionTotalDuration) * 100);
                    const segDuration = seg.end - seg.start;
                    const isFullyPlayed = smoothTime >= seg.end;
                    const isPartiallyPlayed = smoothTime > seg.start && smoothTime < seg.end;
                    let playedPercent = 0;
                    if (isFullyPlayed) playedPercent = 100;
                    else if (isPartiallyPlayed) playedPercent = ((smoothTime - seg.start) / segDuration) * 100;
                    const showProgress = smoothTime > 0;
                    return (
                      <div
                        key={i}
                        className="absolute cursor-pointer transition-[height] duration-150 ease-out group/seg h-1.5 hover:h-3.5 rounded-full"
                        style={{ left: `${left}%`, width: `${width}%`, top: '50%', transform: 'translateY(-50%)' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          const rect = e.currentTarget.getBoundingClientRect();
                          const x = e.clientX - rect.left;
                          const percent = x / rect.width;
                          const magnetZone = 0.2;
                          const time = percent < magnetZone ? seg.start : seg.start + percent * (seg.end - seg.start);
                          onSeekToSegment(time);
                        }}
                        onMouseMove={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const x = e.clientX - rect.left;
                          const percent = x / rect.width;
                          const magnetZone = 0.2;
                          const snapped = percent < magnetZone ? 0 : x;
                          const cursor = e.currentTarget.querySelector('[data-cursor]') as HTMLElement;
                          if (cursor) {
                            cursor.style.left = `${snapped}px`;
                            cursor.style.transition = percent < magnetZone ? 'left 0.15s ease-out' : 'none';
                          }
                        }}
                      >
                        {/* Hover tooltip */}
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 opacity-0 group-hover/seg:opacity-100 transition-opacity pointer-events-none z-10">
                          <div className="bg-popover border border-border shadow-lg rounded-md px-2.5 py-1.5 flex items-center gap-2 whitespace-nowrap">
                            <span className="text-[11px] font-mono text-foreground">{formatSegmentTime(seg.start)} – {formatSegmentTime(seg.end)}</span>
                            <span className="w-px h-3 bg-border" />
                            <span className="text-[11px] text-muted-foreground">{formatDurationMin(seg.end - seg.start)}</span>
                          </div>
                          <div className="flex justify-center -mt-px">
                            <div className="w-2 h-2 bg-popover border-b border-r border-border rotate-45 -mt-1" />
                          </div>
                        </div>
                        {/* Light base (full width) */}
                        <div className={cn(
                          "absolute inset-0 rounded-full pointer-events-none",
                          colors.bg,
                          showProgress && !isFullyPlayed ? "opacity-25" : "opacity-80"
                        )} />
                        {/* Played portion overlay */}
                        {showProgress && playedPercent > 0 && (
                          <div
                            className={cn("absolute inset-y-0 left-0 rounded-full pointer-events-none opacity-80", colors.bg)}
                            style={{ width: `${playedPercent}%` }}
                          />
                        )}
                        {/* Hover cursor */}
                        <div
                          data-cursor
                          className="absolute top-0 bottom-0 w-px bg-gray-900 dark:bg-gray-100 opacity-0 group-hover/seg:opacity-40 transition-opacity pointer-events-none"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <EmptyStateIllustration width={240} height={170}>
        <svg width="150" height="110" viewBox="0 -2 180 110" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ transform: 'perspective(600px) rotateY(-6deg) rotateX(4deg)' }}>
          {/* Speaker 1 row */}
          <rect x="10" y="4" width="28" height="4" rx="2" className="fill-gray-200 dark:fill-white/15" />
          <rect x="150" y="4" width="20" height="4" rx="2" className="fill-gray-200 dark:fill-white/10" />
          <rect x="10" y="14" width="20" height="4" rx="2" className="fill-gray-200 dark:fill-white/15" />
          <rect x="34" y="14" width="28" height="4" rx="2" className="fill-gray-300 dark:fill-white/20" />
          <rect x="66" y="14" width="16" height="4" rx="2" className="fill-gray-200 dark:fill-white/15" />
          <rect x="86" y="14" width="32" height="4" rx="2" className="fill-gray-300 dark:fill-white/20" />
          <rect x="122" y="14" width="14" height="4" rx="2" className="fill-gray-200 dark:fill-white/15" />
          <rect x="140" y="14" width="30" height="4" rx="2" className="fill-gray-300 dark:fill-white/20" />

          {/* Divider */}
          <line x1="10" y1="32" x2="170" y2="32" className="stroke-gray-200 dark:stroke-white/10" strokeWidth="0.5" />

          {/* Speaker 2 row */}
          <rect x="10" y="48" width="24" height="4" rx="2" className="fill-gray-200 dark:fill-white/15" />
          <rect x="150" y="48" width="20" height="4" rx="2" className="fill-gray-200 dark:fill-white/10" />
          <rect x="10" y="58" width="16" height="4" rx="2" className="fill-gray-200 dark:fill-white/15" />
          <rect x="30" y="58" width="24" height="4" rx="2" className="fill-gray-300 dark:fill-white/20" />
          <rect x="58" y="58" width="18" height="4" rx="2" className="fill-gray-200 dark:fill-white/15" />
          <rect x="80" y="58" width="30" height="4" rx="2" className="fill-gray-300 dark:fill-white/20" />
          <rect x="114" y="58" width="22" height="4" rx="2" className="fill-gray-200 dark:fill-white/15" />
          <rect x="140" y="58" width="30" height="4" rx="2" className="fill-gray-300 dark:fill-white/20" />

          {/* Divider */}
          <line x1="10" y1="76" x2="170" y2="76" className="stroke-gray-200 dark:stroke-white/10" strokeWidth="0.5" />

          {/* Speaker 3 row */}
          <rect x="10" y="92" width="22" height="4" rx="2" className="fill-gray-200 dark:fill-white/15" />
          <rect x="150" y="92" width="20" height="4" rx="2" className="fill-gray-200 dark:fill-white/10" />
          <rect x="10" y="102" width="14" height="4" rx="2" className="fill-gray-200 dark:fill-white/15" />
          <rect x="28" y="102" width="26" height="4" rx="2" className="fill-gray-300 dark:fill-white/20" />
          <rect x="58" y="102" width="20" height="4" rx="2" className="fill-gray-200 dark:fill-white/15" />
          <rect x="82" y="102" width="16" height="4" rx="2" className="fill-gray-300 dark:fill-white/20" />
          <rect x="102" y="102" width="28" height="4" rx="2" className="fill-gray-200 dark:fill-white/15" />
          <rect x="134" y="102" width="36" height="4" rx="2" className="fill-gray-300 dark:fill-white/20" />
        </svg>
      </EmptyStateIllustration>
      <p className="text-sm font-medium text-foreground mb-1">
        {hasTranscription ? t('sweep.weldcrm.speakersTab.noSpeakersIdentified') : t('sweep.weldcrm.speakersTab.noSpeakersAvailable')}
      </p>
      <p className="text-xs text-muted-foreground mb-4">
        {hasTranscription ? t('sweep.weldcrm.speakersTab.noSpeakersIdentifiedDescription') : t('sweep.weldcrm.speakersTab.transcribeToIdentify')}
      </p>
      {!hasTranscription && !isTranscribing && onTranscribe && (
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
