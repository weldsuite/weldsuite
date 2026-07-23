
import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  ChevronsRight,
  RotateCcw,
  RotateCw,
  FileText,
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

interface VideoPlayerProps {
  src: string | undefined;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isPlaying: boolean;
  currentTime: number;
  smoothTime: number;
  duration: number;
  flattenedTimeline: FlatTimelineSegment[];
  segments?: TranscriptionSegment[];
  onTogglePlayPause: () => void;
  onSeek: (time: number) => void;
  onMinimize?: () => void;
  onFullscreen?: () => void;
}

export function VideoPlayer({
  src,
  videoRef,
  isPlaying,
  currentTime,
  smoothTime,
  duration,
  flattenedTimeline,
  segments,
  onTogglePlayPause,
  onSeek,
  onMinimize,
  onFullscreen,
}: VideoPlayerProps) {
  const st = useTranslations();
  const [volume, setVolume] = useState(1);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isHoldSpeedUp, setIsHoldSpeedUp] = useState(false);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [seekHoverTime, setSeekHoverTime] = useState<number | null>(null);
  const [seekHoverX, setSeekHoverX] = useState(0);

  const holdTimerRef = useRef<NodeJS.Timeout | null>(null);
  const holdActiveRef = useRef(false);
  const holdWasActiveRef = useRef(false);
  const preMuteVolumeRef = useRef(1);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const hoveredSegRef = useRef<number>(-1);
  const segHighlightRef = useRef<HTMLDivElement>(null);
  const segCursorRef = useRef<HTMLDivElement>(null);

  const findSegmentAtTime = useCallback((time: number) => {
    if (!segments?.length) return null;
    const seg = segments.find((s) => time >= s.start && time <= s.end);
    if (seg) return { speaker: seg.speakerName || seg.speaker || st('sweep.weldcrm.audioPlayer.speaker'), text: seg.text };
    const prev = [...segments].reverse().find((s) => time >= s.start);
    if (prev) return { speaker: prev.speakerName || prev.speaker || st('sweep.weldcrm.audioPlayer.speaker'), text: prev.text };
    return null;
  }, [segments, st]);

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
    }
  };

  const skipBackward = () => {
    if (videoRef.current) {
      const t = Math.max(0, videoRef.current.currentTime - 10);
      videoRef.current.currentTime = t;
      onSeek(t);
    }
  };

  const skipForward = () => {
    if (videoRef.current) {
      const t = Math.min(videoRef.current.duration, videoRef.current.currentTime + 10);
      videoRef.current.currentTime = t;
      onSeek(t);
    }
  };

  const handlePlaybackRateChange = (rate: number) => {
    setPlaybackRate(rate);
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
  };

  const handleVideoMouseDown = useCallback(() => {
    if (!isPlaying || !videoRef.current) return;
    holdTimerRef.current = setTimeout(() => {
      holdActiveRef.current = true;
      if (videoRef.current) {
        videoRef.current.playbackRate = 2;
        setIsHoldSpeedUp(true);
      }
    }, 200);
  }, [isPlaying, videoRef]);

  const handleVideoMouseUp = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (holdActiveRef.current) {
      holdActiveRef.current = false;
      holdWasActiveRef.current = true;
      if (videoRef.current) {
        videoRef.current.playbackRate = playbackRate;
      }
      setIsHoldSpeedUp(false);
    }
  }, [playbackRate, videoRef]);

  const toggleFullscreen = () => {
    if (videoRef.current) {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        videoRef.current.requestFullscreen();
      }
    }
  };

  // Set initial volume
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
    }
  }, [videoRef, volume]);

  if (!src) {
    return (
      <div className="p-4 pb-0">
        <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
          <div className="w-full h-full flex items-center justify-center bg-gray-900 text-white">
            <div className="text-center">
              <FileText className="h-16 w-16 mx-auto mb-4 opacity-50" />
              <p className="text-lg">{st('sweep.weldcrm.videoPlayer.recordingNotAvailable')}</p>
              <p className="text-sm opacity-75 mt-2">{st('sweep.weldcrm.audioPlayer.transcriptAvailableBelow')}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 pb-0">
      <div className="relative bg-black rounded-lg overflow-hidden group/video aspect-video">
        <video
          ref={videoRef}
          className="w-full h-full rounded-lg cursor-pointer"
          src={src}
          poster="/video-poster.jpg"
          onClick={() => {
            if (holdActiveRef.current || holdWasActiveRef.current) {
              holdWasActiveRef.current = false;
              return;
            }
            onTogglePlayPause();
          }}
          onMouseDown={handleVideoMouseDown}
          onMouseUp={handleVideoMouseUp}
          onMouseLeave={handleVideoMouseUp}
        >
          {st('sweep.weldcrm.videoPlayer.browserNotSupported')}
        </video>

        {/* 2x speed indicator */}
        {isHoldSpeedUp && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 pointer-events-none animate-in fade-in duration-150">
            <div className="bg-black/70 backdrop-blur-sm rounded-full px-3 py-1 flex items-center gap-1.5">
              <ChevronsRight className="h-3.5 w-3.5 text-white" />
              <span className="text-white text-xs font-medium">2x</span>
            </div>
          </div>
        )}

        {/* Center Play Button */}
        {!isPlaying && (
          <div
            className="absolute inset-0 flex items-center justify-center cursor-pointer z-10"
            onClick={onTogglePlayPause}
          >
            <div className="w-16 h-16 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center border border-white/20 transition-transform hover:scale-105">
              <Play className="h-7 w-7 text-white fill-white" style={{ transform: 'translateX(1.5px)' }} />
            </div>
          </div>
        )}

        {/* Bottom Controls */}
        <div className={cn("absolute bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-black/90 via-black/50 to-transparent pt-16 transition-opacity duration-300", speedMenuOpen ? "opacity-100" : "opacity-0 group-hover/video:opacity-100")}>
          {/* Seekbar */}
          <div className="px-4 mb-1">
            <div className="flex items-center justify-between mb-1">
              <span className="text-white/80 text-xs font-mono">{formatTimestamp(currentTime)}</span>
              <span className="text-white/80 text-xs font-mono">{formatTimestamp(duration)}</span>
            </div>
            <div
              ref={seekBarRef}
              className="relative h-5 flex items-end cursor-pointer group/seek"
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
                const dur = videoRef.current?.duration || duration;
                if (!dur || dur <= 0) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const percent = Math.max(0, Math.min(1, x / rect.width));
                const newTime = percent * dur;
                onSeek(newTime);
                if (videoRef.current) videoRef.current.currentTime = newTime;
              }}
            >
              {/* Hover tooltip */}
              {seekHoverTime !== null && (
                <div
                  className="absolute bottom-7 -translate-x-1/2 pointer-events-none z-20"
                  style={{ left: seekHoverX }}
                >
                  <div className="bg-gray-900/95 backdrop-blur-sm rounded-lg px-3 py-2 border border-white/10 shadow-xl">
                    {findSegmentAtTime(seekHoverTime) && (
                      <p className="text-[11px] text-gray-300 max-w-[180px] truncate mb-0.5">
                        {findSegmentAtTime(seekHoverTime)?.speaker}
                      </p>
                    )}
                    <p className="text-xs font-mono text-white font-medium">
                      {formatTimestamp(seekHoverTime)}
                    </p>
                  </div>
                </div>
              )}

              {/* Track background */}
              <div
                ref={trackRef}
                className="w-full relative flex items-center cursor-pointer"
                style={{ height: '20px' }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!trackRef.current || duration <= 0 || flattenedTimeline.length === 0) return;
                  const rect = trackRef.current.getBoundingClientRect();
                  const x = e.clientX - rect.left;
                  const timeAtCursor = (x / rect.width) * duration;
                  const idx = flattenedTimeline.findIndex(s => timeAtCursor >= s.start && timeAtCursor <= s.end);
                  if (idx >= 0) {
                    const seg = flattenedTimeline[idx];
                    const segLeft = (seg.start / duration) * rect.width;
                    const segWidth = ((seg.end - seg.start) / duration) * rect.width;
                    const localPercent = (x - segLeft) / segWidth;
                    const magnetZone = 0.3;
                    const time = localPercent < magnetZone ? seg.start : seg.start + localPercent * (seg.end - seg.start);
                    onSeek(time);
                    if (videoRef.current) videoRef.current.currentTime = time;
                  } else {
                    onSeek(timeAtCursor);
                    if (videoRef.current) videoRef.current.currentTime = timeAtCursor;
                  }
                }}
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
                      highlight.style.height = '12px';
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
                {/* Base track line */}
                <div className="w-full h-1 bg-white/25 rounded-full absolute" />

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
                        height: '4px',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        backgroundColor: seg.hex,
                        opacity: 0.7,
                      }}
                    />
                  );
                })}

                {/* Shared hover highlight */}
                <div
                  ref={segHighlightRef}
                  className="absolute rounded-full pointer-events-none z-[1]"
                  style={{
                    height: '4px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    opacity: 0,
                    transition: 'height 0.15s ease-out, opacity 0.1s ease-out',
                  }}
                />

                {/* Shared hover cursor */}
                <div
                  ref={segCursorRef}
                  className="absolute top-0 bottom-0 w-0.5 bg-white rounded-full pointer-events-none z-[1]"
                  style={{ opacity: 0, left: 0 }}
                />

                {/* Played progress overlay */}
                <div
                  className="absolute h-1 left-0 rounded-full pointer-events-none z-[2]"
                  style={{
                    width: duration > 0 ? `${(smoothTime / duration) * 100}%` : '0%',
                    background: 'rgba(255,255,255,0.85)',
                    mixBlendMode: 'overlay',
                  }}
                />

                {/* Hover preview */}
                {seekHoverTime !== null && seekBarRef.current && (
                  <div
                    className="absolute h-1 left-0 bg-white/20 rounded-full pointer-events-none"
                    style={{ width: `${(seekHoverTime / duration) * 100}%` }}
                  />
                )}
              </div>

              {/* Playhead dot */}
              {duration > 0 && (
                <div
                  className="absolute w-3 h-3 -translate-x-1/2 -translate-y-1/2 bg-white rounded-full shadow-md pointer-events-none z-[3]"
                  style={{ left: `${(smoothTime / duration) * 100}%`, top: '50%' }}
                />
              )}
            </div>
          </div>

          {/* Controls row */}
          <div className="flex items-center gap-1 px-3 pb-2">
            {/* Left: playback controls */}
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="w-8 h-8 flex items-center justify-center text-white/80 hover:text-white rounded-md hover:bg-white/10 transition-colors"
                onClick={onTogglePlayPause}
              >
                {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" style={{ transform: 'translateX(0.5px)' }} />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="w-8 h-8 flex items-center justify-center text-white/80 hover:text-white rounded-md hover:bg-white/10 transition-colors"
                onClick={skipBackward}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="w-8 h-8 flex items-center justify-center text-white/80 hover:text-white rounded-md hover:bg-white/10 transition-colors"
                onClick={skipForward}
              >
                <RotateCw className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="flex-1" />

            {/* Right: volume, speed, minimize, fullscreen */}
            <div className="flex items-center gap-1">
              <div className="flex items-center group/vol">
                <Button
                  variant="ghost"
                  size="icon"
                  className="w-8 h-8 flex items-center justify-center text-white/80 hover:text-white rounded-md hover:bg-white/10 transition-colors"
                  onClick={() => {
                    if (volume > 0) {
                      preMuteVolumeRef.current = volume;
                      setVolume(0);
                      if (videoRef.current) videoRef.current.volume = 0;
                    } else {
                      const restored = preMuteVolumeRef.current || 1;
                      setVolume(restored);
                      if (videoRef.current) videoRef.current.volume = restored;
                    }
                  }}
                >
                  {volume === 0 ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                </Button>
                <div className="relative w-0 group-hover/vol:w-16 transition-all duration-200 h-8 flex items-center overflow-hidden">
                  <div className="absolute left-0 right-0 h-1 bg-white/30 rounded-full">
                    <div className="h-full bg-white rounded-full" style={{ width: `${volume * 100}%` }} />
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
              <DropdownMenu modal={false} open={speedMenuOpen} onOpenChange={setSpeedMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="h-8 px-2 flex items-center justify-center text-white/80 hover:text-white text-xs font-medium rounded-md hover:bg-white/10 transition-colors">
                    {playbackRate}x
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="center" onCloseAutoFocus={(e) => e.preventDefault()}>
                  {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                    <DropdownMenuItem key={rate} onClick={() => handlePlaybackRateChange(rate)}>
                      {rate}x
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {onMinimize && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="w-8 h-8 flex items-center justify-center text-white/80 hover:text-white rounded-md hover:bg-white/10 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMinimize();
                  }}
                >
                  <Minimize className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="w-8 h-8 flex items-center justify-center text-white/80 hover:text-white rounded-md hover:bg-white/10 transition-colors"
                onClick={onFullscreen || toggleFullscreen}
              >
                <Maximize className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
