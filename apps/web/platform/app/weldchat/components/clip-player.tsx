/**
 * WeldChat Clip Player
 *
 * Inline playback component for audio, video, and screen clips
 * rendered inside the message stream.
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Play, Pause, Volume2, VolumeX, MoreVertical, Download, Share2, Link2, Trash2, Maximize, X, Captions, Loader2 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useTranscribeClip } from '@/hooks/queries/use-weldchat-queries';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@weldsuite/ui/components/dropdown-menu';
import { Button } from '@weldsuite/ui/components/button';
import type { ChatClipAttachment } from '@weldsuite/db/schema';

// ============================================================================
// Types
// ============================================================================

interface ClipPlayerProps {
  attachment: ChatClipAttachment;
  channelId?: string;
  messageId?: string;
}

// ============================================================================
// Helpers
// ============================================================================

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const PLAYBACK_RATES = [1, 1.5, 2];

const WAVEFORM_BAR_COUNT = 48;
const WAVEFORM_MAX_H = 28;

/** Generate a deterministic waveform pattern from the attachment id */
function generateWaveform(seed: string, count: number): number[] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const bars: number[] = [];
  for (let i = 0; i < count; i++) {
    hash = ((hash << 5) - hash + i * 7) | 0;
    const val = ((hash >>> 0) % 100) / 100;
    bars.push(0.12 + val * 0.88);
  }
  return bars;
}

// ============================================================================
// Audio Clip Player
// ============================================================================

function AudioClipPlayer({ attachment, channelId, messageId }: ClipPlayerProps) {
  const { t } = useI18n();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(attachment.durationSeconds || 0);
  const [rateIndex, setRateIndex] = useState(0);
  const { mutate: triggerTranscribe, isPending: isTranscribing } = useTranscribeClip();

  const waveform = useMemo(
    () => generateWaveform(attachment.id || attachment.fileName, WAVEFORM_BAR_COUNT),
    [attachment.id, attachment.fileName],
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onDurationChange = () => {
      if (audio.duration && isFinite(audio.duration)) setDuration(audio.duration);
    };
    const onEnded = () => setIsPlaying(false);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
    };
  }, []);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      audio.play();
    }
  }, [isPlaying]);

  const handleWaveformSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = pct * duration;
  }, [duration]);

  const cycleRate = useCallback(() => {
    const next = (rateIndex + 1) % PLAYBACK_RATES.length;
    setRateIndex(next);
    if (audioRef.current) {
      audioRef.current.playbackRate = PLAYBACK_RATES[next];
    }
  }, [rateIndex]);

  const seekTo = useCallback((time: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      if (!isPlaying) audioRef.current.play();
    }
  }, [isPlaying]);

  const progress = duration > 0 ? currentTime / duration : 0;

  return (
    <div className="max-w-[420px]">
      <audio ref={audioRef} src={attachment.url} preload="metadata" />

      <div className="flex items-center gap-3 rounded-xl bg-muted px-3 py-2.5">
        {/* Play/Pause button */}
        <Button
          variant="ghost"
          size="icon"
          onClick={togglePlay}
          className="flex-shrink-0 w-7 h-7 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground flex items-center justify-center transition-colors"
        >
          {isPlaying
            ? <Pause className="h-3 w-3 fill-current" />
            : <Play className="h-3 w-3 fill-current ml-0.5" />
          }
        </Button>

        {/* Waveform */}
        <div
          className="relative cursor-pointer select-none flex-1 min-w-0 overflow-hidden"
          style={{ height: WAVEFORM_MAX_H }}
          onClick={handleWaveformSeek}
        >
          <svg
            viewBox={`0 0 ${WAVEFORM_BAR_COUNT * 4} ${WAVEFORM_MAX_H}`}
            preserveAspectRatio="none"
            className="w-full h-full"
          >
            {waveform.map((level, i) => {
              const barProgress = i / waveform.length;
              const isPlayed = barProgress < progress;
              const barH = Math.max(3, Math.round(level * WAVEFORM_MAX_H));
              const x = i * 4;
              const y = (WAVEFORM_MAX_H - barH) / 2;
              return (
                <rect
                  key={i}
                  x={x}
                  y={y}
                  width={2.5}
                  height={barH}
                  rx={1.25}
                  className={isPlayed ? "fill-primary" : "fill-muted-foreground/30"}
                />
              );
            })}
          </svg>
        </div>

        {/* Time */}
        <span className="text-xs text-muted-foreground font-mono tabular-nums flex-shrink-0">
          {formatTime(isPlaying || currentTime > 0 ? currentTime : duration)}
        </span>

        {/* Actions */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              if (channelId && messageId && attachment.id && !attachment.transcript) {
                triggerTranscribe({ channelId, messageId, attachmentId: attachment.id });
              }
            }}
            disabled={isTranscribing || !!attachment.transcript}
            className="w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10 transition-colors flex items-center justify-center disabled:opacity-40"
            title={attachment.transcript ? t.weldchat.clipPlayer.transcriptGenerated : isTranscribing ? t.weldchat.clipPlayer.generatingTranscript : t.weldchat.clipPlayer.generateTranscript}
          >
            {isTranscribing || attachment.transcript?.status === 'pending' || attachment.transcript?.status === 'processing'
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Captions className="h-4 w-4" />
            }
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={cycleRate}
            className="w-7 h-7 text-xs font-semibold text-muted-foreground hover:text-foreground tabular-nums rounded-md hover:bg-muted-foreground/10 transition-colors flex items-center justify-center"
            title={t.weldchat.clipPlayer.playbackSpeed}
          >
            {PLAYBACK_RATES[rateIndex]}x
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10 transition-colors flex items-center justify-center">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[160px]">
            <DropdownMenuItem asChild>
              <a href={attachment.url} download={attachment.fileName}>
                <Download className="h-3.5 w-3.5 mr-0.5" />
                {t.weldchat.clipPlayer.download}
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                navigator.clipboard.writeText(attachment.url);
              }}
            >
              <Link2 className="h-3.5 w-3.5 mr-0.5" />
              {t.weldchat.clipPlayer.copyLink}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                if (navigator.share) {
                  navigator.share({ title: t.weldchat.clipPlayer.voiceClip, url: attachment.url });
                } else {
                  navigator.clipboard.writeText(attachment.url);
                }
              }}
            >
              <Share2 className="h-3.5 w-3.5 mr-0.5" />
              {t.weldchat.clipPlayer.shareClip}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive focus:bg-red-500/10"
              onClick={() => {
                // TODO: wire up delete via API
              }}
            >
              <Trash2 className="h-3.5 w-3.5 mr-0.5 text-red-500" />
              {t.weldchat.clipPlayer.deleteClip}
            </DropdownMenuItem>
          </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

    </div>
  );
}

// ============================================================================
// Video/Screen Clip Player
// ============================================================================

function VideoClipPlayer({ attachment, channelId, messageId }: ClipPlayerProps) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(attachment.durationSeconds || 0);
  const [rateIndex, setRateIndex] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [showOverlay, setShowOverlay] = useState(true);
  const [isLightbox, setIsLightbox] = useState(false);
  const [videoLoaded, setVideoLoaded] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onDurationChange = () => {
      if (video.duration && isFinite(video.duration)) setDuration(video.duration);
    };
    const onEnded = () => { setIsPlaying(false); setShowOverlay(true); };
    const onPlay = () => { setIsPlaying(true); setShowOverlay(false); };
    const onPause = () => setIsPlaying(false);
    const onLoaded = () => setVideoLoaded(true);

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('durationchange', onDurationChange);
    video.addEventListener('ended', onEnded);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('loadeddata', onLoaded);

    // Already loaded (cached)
    if (video.readyState >= 2) setVideoLoaded(true);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('loadeddata', onLoaded);
    };
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.pause();
    } else {
      video.play();
    }
  }, [isPlaying]);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    video.currentTime = pct * duration;
  }, [duration]);

  const cycleRate = useCallback(() => {
    const next = (rateIndex + 1) % PLAYBACK_RATES.length;
    setRateIndex(next);
    if (videoRef.current) {
      videoRef.current.playbackRate = PLAYBACK_RATES[next];
    }
  }, [rateIndex]);

  const toggleMute = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  }, [isMuted]);

  const seekTo = useCallback((time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      if (!isPlaying) videoRef.current.play();
    }
  }, [isPlaying]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const openLightbox = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    // Pause inline player when opening lightbox
    if (videoRef.current && isPlaying) videoRef.current.pause();
    setIsLightbox(true);
  }, [isPlaying]);

  const closeLightbox = useCallback(() => {
    setIsLightbox(false);
  }, []);

  return (
    <div className="max-w-[400px]">
      {/* Video */}
      <div
        className="relative rounded-lg overflow-hidden bg-black cursor-pointer group/video"
        onClick={togglePlay}
      >
        <video
          ref={videoRef}
          src={attachment.url}
          preload="metadata"
          playsInline
          className="w-full aspect-video object-contain"
        />

        {/* Center play overlay — only on hover */}
        {!isPlaying && (
          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/video:opacity-100 transition-opacity pointer-events-none">
            <div className="w-10 h-10 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center">
              <Play className="h-4 w-4 text-white fill-current ml-0.5" />
            </div>
          </div>
        )}

        {/* Clip type badge */}
        <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium opacity-0 group-hover/video:opacity-100 transition-opacity">
          {attachment.clipType}
        </div>

        {/* Top-right icons */}
        <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover/video:opacity-100 transition-opacity">
          {!attachment.transcript && channelId && messageId && (
            <TranscriptButton channelId={channelId} messageId={messageId} attachmentId={attachment.id} />
          )}
          {(attachment.transcript?.status === 'pending' || attachment.transcript?.status === 'processing') && (
            <div className="p-1.5 rounded-md bg-black/60 text-white" title={t.weldchat.clipPlayer.generatingTranscriptBadge}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => { e.stopPropagation(); openLightbox(e); }}
            className="p-1.5 rounded-md bg-black/60 text-white hover:bg-black/80 transition-colors"
            title={t.weldchat.clipPlayer.viewFullscreen}
          >
            <Maximize className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Duration badge — always visible, hides when hover controls show */}
        <div className="absolute bottom-2 right-2 bg-black/70 text-white text-xs px-1.5 py-0.5 rounded font-mono group-hover/video:opacity-0 transition-opacity">
          {formatTime(duration)}
        </div>

        {/* Bottom controls — appear on hover */}
        <div className="absolute bottom-0 left-0 right-0 px-3 pb-2.5 pt-8 bg-gradient-to-t from-black/70 to-transparent opacity-0 group-hover/video:opacity-100 transition-opacity">
          {/* Seek bar */}
          <div
            className="w-full h-1 bg-white/25 rounded-full cursor-pointer mb-2 group/seek hover:h-1.5 transition-all"
            onClick={(e) => { e.stopPropagation(); handleSeek(e); }}
          >
            <div
              className="h-full bg-white rounded-full transition-all duration-100"
              style={{ width: `${progress}%` }}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => { e.stopPropagation(); togglePlay(); }}
                className="p-1 rounded text-white hover:bg-white/10 transition-colors"
              >
                {isPlaying
                  ? <Pause className="h-3.5 w-3.5" />
                  : <Play className="h-3.5 w-3.5 ml-0.5" />
                }
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => { e.stopPropagation(); toggleMute(); }}
                className="p-1 rounded text-white/70 hover:text-white hover:bg-white/10 transition-colors"
              >
                {isMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              </Button>
              <span className="text-white/60 text-[11px] font-mono tabular-nums">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                onClick={(e) => { e.stopPropagation(); cycleRate(); }}
                className="text-[11px] font-semibold text-white/60 hover:text-white px-1 py-0.5 rounded hover:bg-white/10 transition-colors tabular-nums"
              >
                {PLAYBACK_RATES[rateIndex]}x
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Lightbox */}
      {isLightbox && createPortal(
        <VideoLightbox attachment={attachment} onClose={closeLightbox} />,
        document.body,
      )}
    </div>
  );
}

// ============================================================================
// Video Lightbox
// ============================================================================

function VideoLightbox({ attachment, onClose }: { attachment: ChatClipAttachment; onClose: () => void }) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(attachment.durationSeconds || 0);
  const [isMuted, setIsMuted] = useState(false);
  const [rateIndex, setRateIndex] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onDurationChange = () => {
      if (video.duration && isFinite(video.duration)) setDuration(video.duration);
    };
    const onEnded = () => setIsPlaying(false);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('durationchange', onDurationChange);
    video.addEventListener('ended', onEnded);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);

    // Auto-play on open
    video.play().catch(() => {});

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
    };
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) video.pause();
    else video.play();
  }, [isPlaying]);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    video.currentTime = pct * duration;
  }, [duration]);

  const toggleMute = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  }, [isMuted]);

  const cycleRate = useCallback(() => {
    const next = (rateIndex + 1) % PLAYBACK_RATES.length;
    setRateIndex(next);
    if (videoRef.current) videoRef.current.playbackRate = PLAYBACK_RATES[next];
  }, [rateIndex]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const [showControls, setShowControls] = useState(true);
  const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideTimeout.current) clearTimeout(hideTimeout.current);
    hideTimeout.current = setTimeout(() => {
      if (isPlaying) setShowControls(false);
    }, 2500);
  }, [isPlaying]);

  useEffect(() => {
    if (!isPlaying) setShowControls(true);
  }, [isPlaying]);

  useEffect(() => {
    return () => { if (hideTimeout.current) clearTimeout(hideTimeout.current); };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 animate-in fade-in-0 duration-200"
      onClick={onClose}
      onMouseMove={resetHideTimer}
    >
      {/* Video wrapper — controls are positioned relative to this */}
      <div
        className="relative max-w-[90vw] max-h-[90vh] rounded-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <video
          ref={videoRef}
          src={attachment.url}
          playsInline
          onClick={togglePlay}
          className="w-full h-full object-contain cursor-pointer block"
        />

        {/* Play overlay (center) */}
        {!isPlaying && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-16 h-16 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center">
              <Play className="h-7 w-7 text-white fill-current ml-1" />
            </div>
          </div>
        )}

        {/* Top bar — inside video */}
        <div className={cn(
          "absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/70 to-transparent transition-opacity duration-300",
          showControls ? "opacity-100" : "opacity-0 pointer-events-none"
        )}>
          <div className="flex items-center gap-3">
            <span className="text-white/80 text-sm font-medium">{attachment.fileName}</span>
            <span className="text-white/40 text-xs uppercase tracking-wider">{attachment.clipType}</span>
          </div>
          <div className="flex items-center gap-1">
            <a
              href={attachment.url}
              download={attachment.fileName}
              className="p-2 rounded-md text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              title={t.weldchat.clipPlayer.download}
              onClick={(e) => e.stopPropagation()}
            >
              <Download className="h-4 w-4" />
            </a>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="p-2 rounded-md text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              title={t.weldchat.clipPlayer.close}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Bottom controls — inside video */}
        <div className={cn(
          "absolute bottom-0 left-0 right-0 px-4 pb-3 pt-10 bg-gradient-to-t from-black/70 to-transparent transition-opacity duration-300",
          showControls ? "opacity-100" : "opacity-0 pointer-events-none"
        )}>
          {/* Seek bar */}
          <div
            className="w-full h-1 bg-white/25 rounded-full cursor-pointer mb-2.5 group/seek hover:h-1.5 transition-all"
            onClick={(e) => { e.stopPropagation(); handleSeek(e); }}
          >
            <div
              className="h-full bg-white rounded-full transition-all duration-100 relative"
              style={{ width: `${progress}%` }}
            >
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full opacity-0 group-hover/seek:opacity-100 transition-opacity shadow" />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => { e.stopPropagation(); togglePlay(); }}
                className="p-1.5 rounded-md text-white hover:bg-white/10 transition-colors"
              >
                {isPlaying
                  ? <Pause className="h-5 w-5" />
                  : <Play className="h-5 w-5 ml-0.5" />
                }
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => { e.stopPropagation(); toggleMute(); }}
                className="p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/10 transition-colors"
              >
                {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              </Button>
              <span className="text-white/60 text-xs font-mono tabular-nums ml-1">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>
            <Button
              variant="ghost"
              onClick={(e) => { e.stopPropagation(); cycleRate(); }}
              className="text-xs font-semibold text-white/60 hover:text-white px-2 py-1 rounded-md hover:bg-white/10 transition-colors tabular-nums"
            >
              {PLAYBACK_RATES[rateIndex]}x
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Transcript Button (for video overlay)
// ============================================================================

function TranscriptButton({ channelId, messageId, attachmentId }: { channelId: string; messageId: string; attachmentId: string }) {
  const { t } = useI18n();
  const { mutate: triggerTranscribe, isPending } = useTranscribeClip();

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={(e) => {
        e.stopPropagation();
        triggerTranscribe({ channelId, messageId, attachmentId });
      }}
      disabled={isPending}
      className="p-1.5 rounded-md bg-black/60 text-white hover:bg-black/80 transition-colors disabled:opacity-50"
      title={t.weldchat.clipPlayer.generateTranscript}
    >
      {isPending
        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
        : <Captions className="h-3.5 w-3.5" />
      }
    </Button>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function ClipPlayer({ attachment, channelId, messageId }: ClipPlayerProps) {
  if (attachment.clipType === 'audio') {
    return <AudioClipPlayer attachment={attachment} channelId={channelId} messageId={messageId} />;
  }
  return <VideoClipPlayer attachment={attachment} channelId={channelId} messageId={messageId} />;
}
