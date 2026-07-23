
import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  RotateCcw,
  RotateCw,
  Phone,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { formatTimestamp } from './utils';
import type { FlatTimelineSegment, TranscriptionSegment } from './types';
import { useTranslations } from '@weldsuite/i18n/client';

interface AudioPlayerProps {
  src: string | undefined;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  isPlaying: boolean;
  currentTime: number;
  smoothTime: number;
  duration: number;
  flattenedTimeline: FlatTimelineSegment[];
  segments?: TranscriptionSegment[];
  onTogglePlayPause: () => void;
  onSeek: (time: number) => void;
}

export function AudioPlayer({
  src,
  audioRef,
  isPlaying,
  currentTime,
  smoothTime,
  duration,
  flattenedTimeline,
  segments,
  onTogglePlayPause,
  onSeek,
}: AudioPlayerProps) {
  const t = useTranslations();
  const [volume, setVolume] = useState(1);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [seekHoverTime, setSeekHoverTime] = useState<number | null>(null);
  const [seekHoverX, setSeekHoverX] = useState(0);

  const preMuteVolumeRef = useRef(1);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const hoveredSegRef = useRef<number>(-1);
  const segHighlightRef = useRef<HTMLDivElement>(null);
  const segCursorRef = useRef<HTMLDivElement>(null);

  const findSegmentAtTime = useCallback((time: number) => {
    if (!segments?.length) return null;
    const seg = segments.find((s) => time >= s.start && time <= s.end);
    if (seg) return { speaker: seg.speakerName || seg.speaker || t('sweep.weldcrm.audioPlayer.speaker'), text: seg.text };
    const prev = [...segments].reverse().find((s) => time >= s.start);
    if (prev) return { speaker: prev.speakerName || prev.speaker || t('sweep.weldcrm.audioPlayer.speaker'), text: prev.text };
    return null;
  }, [segments, t]);

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (audioRef.current) {
      audioRef.current.volume = newVolume;
    }
  };

  const skipBackward = () => {
    if (audioRef.current) {
      const t = Math.max(0, audioRef.current.currentTime - 10);
      audioRef.current.currentTime = t;
      onSeek(t);
    }
  };

  const skipForward = () => {
    if (audioRef.current) {
      const t = Math.min(audioRef.current.duration, audioRef.current.currentTime + 10);
      audioRef.current.currentTime = t;
      onSeek(t);
    }
  };

  const handlePlaybackRateChange = (rate: number) => {
    setPlaybackRate(rate);
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  };

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [audioRef, volume]);

  if (!src) {
    return (
      <div className="px-4 pt-4">
        <div className="rounded-xl bg-gray-100 dark:bg-background border border-gray-200 dark:border-border p-5">
          <div className="flex items-center justify-center gap-3 text-gray-400 dark:text-muted-foreground">
            <Phone className="h-5 w-5" />
            <div className="text-center">
              <p className="text-sm font-medium">{t('sweep.weldcrm.audioPlayer.noRecordingAvailable')}</p>
              <p className="text-xs mt-0.5 opacity-75">{t('sweep.weldcrm.audioPlayer.transcriptAvailableBelow')}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const progress = duration > 0 ? (smoothTime / duration) * 100 : 0;

  return (
    <div className="px-4 pt-4">
      <audio ref={audioRef} src={src} preload="metadata" />
      <div className="rounded-xl bg-gradient-to-b from-gray-50 to-gray-100 dark:from-background dark:to-background border border-gray-200 dark:border-border p-5">
        {/* Top: time + seekbar */}
        <div className="flex items-center gap-4">
          {/* Current time */}
          <span className="text-xs font-mono tabular-nums text-gray-500 dark:text-white/50 w-10 text-right flex-shrink-0">
            {formatTimestamp(currentTime)}
          </span>

          {/* Seekbar */}
          <div
            ref={seekBarRef}
            className="flex-1 relative h-8 flex items-center cursor-pointer group/seek"
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const x = e.clientX - rect.left;
              const percent = Math.max(0, Math.min(1, x / rect.width));
              setSeekHoverTime(percent * duration);
              setSeekHoverX(x);
            }}
            onMouseLeave={() => setSeekHoverTime(null)}
            onClick={(e) => {
              e.stopPropagation();
              const dur = audioRef.current?.duration || duration;
              if (!dur || dur <= 0) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const x = e.clientX - rect.left;
              const percent = Math.max(0, Math.min(1, x / rect.width));
              const newTime = percent * dur;
              onSeek(newTime);
              if (audioRef.current) audioRef.current.currentTime = newTime;
            }}
          >
            {/* Hover tooltip */}
            {seekHoverTime !== null && (
              <div
                className="absolute bottom-8 -translate-x-1/2 pointer-events-none z-20"
                style={{ left: seekHoverX }}
              >
                <div className="bg-white dark:bg-secondary backdrop-blur-sm rounded-lg px-2.5 py-1.5 border border-gray-200 dark:border-white/10 shadow-xl">
                  {findSegmentAtTime(seekHoverTime) && (
                    <p className="text-[11px] text-gray-500 dark:text-muted-foreground max-w-[180px] truncate mb-0.5">
                      {findSegmentAtTime(seekHoverTime)?.speaker}
                    </p>
                  )}
                  <p className="text-xs font-mono text-gray-900 dark:text-white font-medium">
                    {formatTimestamp(seekHoverTime)}
                  </p>
                </div>
              </div>
            )}

            {/* Track */}
            <div
              ref={trackRef}
              className="w-full relative flex items-center cursor-pointer"
              style={{ height: '20px' }}
              onMouseMove={(e) => {
                if (!trackRef.current || duration <= 0 || flattenedTimeline.length === 0) return;
                const rect = trackRef.current.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const timeAtCursor = (x / rect.width) * duration;
                let idx = -1;
                for (let i = 0; i < flattenedTimeline.length; i++) {
                  if (timeAtCursor >= flattenedTimeline[i].start && timeAtCursor <= flattenedTimeline[i].end) {
                    idx = i;
                    break;
                  }
                }
                const highlight = segHighlightRef.current;
                const cursor = segCursorRef.current;
                if (idx >= 0) {
                  const seg = flattenedTimeline[idx];
                  const segLeftPx = (seg.start / duration) * rect.width;
                  const segWidthPx = ((seg.end - seg.start) / duration) * rect.width;
                  const localPercent = (x - segLeftPx) / segWidthPx;
                  const magnetZone = 0.3;
                  if (highlight) {
                    highlight.style.left = `${(seg.start / duration) * 100}%`;
                    highlight.style.width = `${Math.max(0.3, ((seg.end - seg.start) / duration) * 100)}%`;
                    highlight.style.backgroundColor = seg.hex;
                    highlight.style.opacity = '0.9';
                    highlight.style.height = '10px';
                  }
                  if (cursor) {
                    const snappedPx = localPercent < magnetZone ? segLeftPx : x;
                    cursor.style.left = `${snappedPx}px`;
                    cursor.style.transition = localPercent < magnetZone ? 'left 0.15s ease-out' : 'none';
                    cursor.style.opacity = '1';
                  }
                } else {
                  if (highlight) {
                    highlight.style.opacity = '0';
                    highlight.style.height = '4px';
                  }
                  if (cursor) cursor.style.opacity = '0';
                }
                hoveredSegRef.current = idx;
              }}
              onMouseLeave={() => {
                hoveredSegRef.current = -1;
                if (segHighlightRef.current) {
                  segHighlightRef.current.style.opacity = '0';
                  segHighlightRef.current.style.height = '4px';
                }
                if (segCursorRef.current) segCursorRef.current.style.opacity = '0';
              }}
            >
              {/* Base track */}
              <div className="w-full h-1.5 bg-gray-200 dark:bg-white/15 rounded-full absolute" />

              {/* Speaker color segments */}
              {duration > 0 && flattenedTimeline.map((seg, i) => {
                const left = (seg.start / duration) * 100;
                const w = Math.max(0.3, ((seg.end - seg.start) / duration) * 100);
                return (
                  <div
                    key={`seg-${i}`}
                    className="absolute rounded-full pointer-events-none"
                    style={{
                      left: `${left}%`,
                      width: `${w}%`,
                      height: '5px',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      backgroundColor: seg.hex,
                      opacity: 0.7,
                    }}
                  />
                );
              })}

              {/* Hover highlight */}
              <div
                ref={segHighlightRef}
                className="absolute rounded-full pointer-events-none z-[1]"
                style={{
                  height: '5px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  opacity: 0,
                  transition: 'height 0.15s ease-out, opacity 0.1s ease-out',
                }}
              />

              {/* Hover cursor */}
              <div
                ref={segCursorRef}
                className="absolute top-0 bottom-0 w-0.5 bg-gray-900 dark:bg-foreground rounded-full pointer-events-none z-[1]"
                style={{ opacity: 0, left: 0 }}
              />

              {/* Played progress */}
              <div
                className="absolute h-1.5 left-0 rounded-full pointer-events-none z-[2]"
                style={{
                  width: `${progress}%`,
                  background: 'var(--color-gray-500)',
                }}
              />

              {/* Hover preview */}
              {seekHoverTime !== null && (
                <div
                  className="absolute h-1.5 left-0 bg-gray-400/30 dark:bg-white/20 rounded-full pointer-events-none"
                  style={{ width: `${(seekHoverTime / duration) * 100}%` }}
                />
              )}
            </div>

            {/* Playhead dot */}
            {duration > 0 && (
              <div
                className="absolute w-3.5 h-3.5 -translate-x-1/2 -translate-y-1/2 bg-gray-700 dark:bg-foreground rounded-full shadow-md pointer-events-none z-[3] border-2 border-white dark:border-background"
                style={{ left: `${progress}%`, top: '50%' }}
              />
            )}
          </div>

          {/* Duration */}
          <span className="text-xs font-mono tabular-nums text-gray-500 dark:text-white/50 w-10 flex-shrink-0">
            {duration > 0 && isFinite(duration) ? formatTimestamp(duration) : '--:--'}
          </span>
        </div>

        {/* Bottom controls */}
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-200/60 dark:border-border/50">
          {/* Left: Volume */}
          <div className="relative group/vol">
            <Button
              variant="ghost"
              size="icon"
              className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-white rounded-md hover:bg-gray-200/60 dark:hover:bg-white/10 transition-colors"
              onClick={() => {
                if (volume > 0) {
                  preMuteVolumeRef.current = volume;
                  setVolume(0);
                  if (audioRef.current) audioRef.current.volume = 0;
                } else {
                  const restored = preMuteVolumeRef.current || 1;
                  setVolume(restored);
                  if (audioRef.current) audioRef.current.volume = restored;
                }
              }}
            >
              {volume === 0 ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            </Button>
            <div className="absolute left-0 top-1/2 -translate-y-1/2 ml-8 hidden group-hover/vol:flex items-center w-20 h-7 bg-white dark:bg-secondary rounded-lg border border-gray-200 dark:border-white/10 shadow-lg px-2 z-10">
              <div className="relative w-full h-1 bg-gray-200 dark:bg-white/20 rounded-full">
                <div className="h-full bg-gray-500 dark:bg-foreground rounded-full" style={{ width: `${volume * 100}%` }} />
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={volume}
                onChange={handleVolumeChange}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
            </div>
          </div>

          {/* Center: Skip + Play controls */}
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              className="h-7 px-2 flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-white rounded-md hover:bg-gray-200/60 dark:hover:bg-white/10 transition-colors"
              onClick={skipBackward}
            >
              <RotateCcw className="h-3 w-3" />
              <span>10s</span>
            </Button>
            <Button
              variant="ghost"
              className="w-9 h-9 flex items-center justify-center bg-gray-900 dark:bg-white hover:bg-gray-800 dark:hover:bg-white/90 rounded-full transition-colors shadow-sm"
              onClick={onTogglePlayPause}
            >
              {isPlaying ? (
                <Pause className="h-3.5 w-3.5 text-white dark:text-gray-900 fill-current" />
              ) : (
                <Play className="h-3.5 w-3.5 text-white dark:text-gray-900 fill-current" style={{ transform: 'translateX(1px)' }} />
              )}
            </Button>
            <Button
              variant="ghost"
              className="h-7 px-2 flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-white rounded-md hover:bg-gray-200/60 dark:hover:bg-white/10 transition-colors"
              onClick={skipForward}
            >
              <span>10s</span>
              <RotateCw className="h-3 w-3" />
            </Button>
          </div>

          {/* Right: Playback speed */}
          <DropdownMenu modal={false} open={speedMenuOpen} onOpenChange={setSpeedMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="h-7 px-2.5 flex items-center justify-center text-gray-400 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-white text-xs font-medium rounded-md hover:bg-gray-200/60 dark:hover:bg-white/10 transition-colors">
                {playbackRate}x
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                <DropdownMenuItem key={rate} onClick={() => handlePlaybackRateChange(rate)}>
                  {rate}x
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
