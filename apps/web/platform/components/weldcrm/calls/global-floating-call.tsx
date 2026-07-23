
import { useEffect, useRef } from 'react';
import { useFloatingCall } from '@/contexts/floating-call-context';
import { useMobileNavOptional } from '@/contexts/mobile-nav-context';
import { useRouter, usePathname } from '@/lib/router';
import { Play, Pause, Maximize, X, Video, User } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';

export function GlobalFloatingCall() {
  const t = useTranslations();
  const ctx = useFloatingCall();
  const mobileNav = useMobileNavOptional();
  const router = useRouter();
  const pathname = usePathname();
  const transcriptRef = useRef<HTMLDivElement>(null);
  const activeSegmentRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to active segment
  const activeSegmentId = (() => {
    if (!ctx?.floatingCall?.segments?.length || !ctx.smoothTime) return null;
    const time = ctx.smoothTime;
    const active = ctx.floatingCall.segments.find(s => time >= s.start && time <= s.end);
    if (active) return active.id;
    const prev = [...ctx.floatingCall.segments].reverse().find(s => time >= s.start);
    return prev?.id || null;
  })();

  useEffect(() => {
    if (activeSegmentRef.current && transcriptRef.current) {
      activeSegmentRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeSegmentId]);

  if (!ctx?.floatingCall) return null;

  const { floatingCall, videoRef, smoothTime, duration, dismiss, togglePlayPause, isPlaying } = ctx;

  const callDate = new Date(floatingCall.callDate);
  const callDuration = floatingCall.callDuration;

  const formatTimestamp = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hours > 0) {
      return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (secs === 0) return `${mins}min`;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const speakerColors = [
    'bg-blue-500',
    'bg-emerald-500',
    'bg-violet-500',
    'bg-amber-500',
    'bg-rose-500',
    'bg-cyan-500',
  ];

  const platform = floatingCall.platform || '';
  const meetingUrl = floatingCall.meetingUrl || '';

  return (
    <div className="fixed bottom-4 z-[9999] w-[340px] shadow-2xl rounded-xl overflow-hidden border border-gray-200 dark:border-border animate-in slide-in-from-bottom-4 fade-in duration-200 bg-white dark:bg-background flex flex-col" style={{ maxHeight: 'calc(100vh - 120px)', right: mobileNav?.showWeldAgent ? `${(mobileNav?.weldAgentWidth ?? 480) + 16}px` : '16px' }}>
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3 py-2.5 border-b border-gray-100 dark:border-border">
        <div className="h-7 w-7 rounded-md bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border flex items-center justify-center flex-shrink-0">
          {(() => {
            if (platform.includes('google') || meetingUrl.includes('meet.google')) {
              return <img src="/logos/google-meet.png" alt="Google Meet" className="h-4 w-4" />;
            }
            if (platform.includes('teams') || platform.includes('microsoft') || meetingUrl.includes('teams.microsoft')) {
              return <img src="/logos/teams.svg" alt="Microsoft Teams" className="h-4 w-4" />;
            }
            if (platform.includes('zoom') || meetingUrl.includes('zoom.us')) {
              return <img src="/logos/zoom.svg" alt="Zoom" className="h-4 w-4" />;
            }
            return <Video className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" />;
          })()}
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <p className="text-sm font-semibold text-gray-900 dark:text-foreground truncate min-w-0">{floatingCall.callSubject}</p>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border text-gray-500 dark:text-muted-foreground flex-shrink-0 whitespace-nowrap">
            {format(callDate, 'MMM d')}
          </span>
          {callDuration > 0 && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border text-gray-500 dark:text-muted-foreground flex-shrink-0 whitespace-nowrap">
              {formatDuration(callDuration)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="w-7 h-7 flex items-center justify-center text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground rounded-md hover:bg-gray-100 dark:hover:bg-secondary transition-colors"
            onClick={() => {
              const callId = floatingCall.callId;
              const alreadyOnCallPage = pathname === `/weldcrm/calls/${callId}`;
              ctx.maximizeBack();
              if (!alreadyOnCallPage) {
                router.push(`/weldcrm/calls/${callId}`);
              }
            }}
          >
            <Maximize className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="w-7 h-7 flex items-center justify-center text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground rounded-md hover:bg-gray-100 dark:hover:bg-secondary transition-colors"
            onClick={dismiss}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Video */}
      <div className="relative bg-black group/minivid aspect-video">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover cursor-pointer"
          src={floatingCall.videoSrc}
          onClick={togglePlayPause}
        />

        {/* Center play/pause */}
        <div
          className="absolute inset-0 z-30 flex items-center justify-center cursor-pointer opacity-0 group-hover/minivid:opacity-100 transition-opacity duration-150"
          onClick={togglePlayPause}
        >
          <div className="w-10 h-10 rounded-full bg-black/60 flex items-center justify-center border border-white/20">
            {isPlaying ? (
              <Pause className="h-4 w-4 text-white fill-white" />
            ) : (
              <Play className="h-4 w-4 text-white fill-white ml-0.5" />
            )}
          </div>
        </div>

        {/* Timeline */}
        <div className="absolute bottom-0 left-0 right-0 z-40 bg-gradient-to-t from-black/80 to-transparent pt-4 px-2.5 pb-1.5">
          <div className="flex items-center justify-between mb-1">
            <span className="text-white/80 text-[10px] font-mono">{formatTimestamp(smoothTime)}</span>
            <span className="text-white/80 text-[10px] font-mono">{formatTimestamp(duration)}</span>
          </div>
          <div
            className="relative h-3 flex items-center cursor-pointer group/miniseek"
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              const x = e.clientX - rect.left;
              const percent = Math.max(0, Math.min(1, x / rect.width));
              const newTime = percent * duration;
              if (videoRef.current) {
                videoRef.current.currentTime = newTime;
              }
            }}
          >
            <div className="w-full h-1 group-hover/miniseek:h-1.5 transition-all duration-150 bg-white/25 rounded-full relative overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 bg-white rounded-full"
                style={{ width: duration > 0 ? `${(smoothTime / duration) * 100}%` : '0%' }}
              />
            </div>
            {duration > 0 && (
              <div
                className="absolute w-2 h-2 bg-white rounded-full opacity-0 group-hover/miniseek:opacity-100 transition-opacity shadow-sm pointer-events-none"
                style={{ left: `${(smoothTime / duration) * 100}%`, top: '50%', transform: 'translate(-50%, -50%)' }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div ref={transcriptRef} className="flex-1 overflow-y-auto min-h-0 border-t border-gray-100 dark:border-border scrollbar-thin scrollbar-thumb-gray-200 dark:scrollbar-thumb-gray-800 scrollbar-track-transparent" style={{ maxHeight: '280px', scrollbarWidth: 'thin', scrollbarColor: 'rgba(200,200,200,0.3) transparent' }}>
          <div className="pl-3 pr-0 py-2 space-y-0.5">
            {floatingCall.segments.length > 0 ? (
              floatingCall.segments.map((segment) => {
                const speakerMatch = segment.speaker?.match(/\d+/);
                const speakerId = speakerMatch ? parseInt(speakerMatch[0]) : 0;
                const color = speakerColors[speakerId % speakerColors.length];
                const isActive = segment.id === activeSegmentId;

                return (
                  <div
                    key={segment.id}
                    ref={isActive ? activeSegmentRef : undefined}
                    onClick={() => {
                      if (videoRef.current) {
                        videoRef.current.currentTime = segment.start;
                      }
                    }}
                    className={cn(
                      "px-2 py-1.5 rounded-md cursor-pointer transition-colors",
                      isActive
                        ? "bg-blue-50 dark:bg-blue-950/30"
                        : "hover:bg-gray-50 dark:hover:bg-background/50"
                    )}
                  >
                    <div className="flex items-center gap-[7px] mb-0.5">
                      <div className={cn("h-5 w-5 rounded-md flex-shrink-0 flex items-center justify-center", color)}>
                        <User className="h-3 w-3 text-white" />
                      </div>
                      <span className="text-[13px] font-semibold text-gray-900 dark:text-foreground">{segment.speakerName || segment.speaker}</span>
                      <span className="text-[11px] font-mono text-gray-400 ml-auto">{formatTimestamp(segment.start)}</span>
                    </div>
                    <p className="text-[13px] text-gray-600 dark:text-muted-foreground leading-relaxed">{segment.text}</p>
                  </div>
                );
              })
            ) : (
              <p className="text-xs text-gray-500 text-center py-6">{t('sweep.weldcrm.globalFloatingCall.noTranscriptAvailable')}</p>
            )}
          </div>
      </div>
    </div>
  );
}
