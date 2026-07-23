
import { useFloatingVideo } from '@/contexts/floating-video-context';
import { useMobileNavOptional } from '@/contexts/mobile-nav-context';
import { useRouter, usePathname } from '@/lib/router';
import { Play, Pause, Maximize, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';

export function GlobalFloatingVideo() {
  const ctx = useFloatingVideo();
  const mobileNav = useMobileNavOptional();
  const router = useRouter();
  const pathname = usePathname();

  if (!ctx?.floatingVideo) return null;

  const { floatingVideo, videoRef, smoothTime, duration, dismiss, togglePlayPause, isPlaying } = ctx;

  const formatTimestamp = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hours > 0) {
      return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="fixed bottom-4 z-[9999] w-80 shadow-2xl rounded-lg overflow-hidden border border-gray-200 dark:border-border animate-in slide-in-from-bottom-4 fade-in duration-200" style={{ right: mobileNav?.showWeldAgent ? `${(mobileNav?.weldAgentWidth ?? 480) + 16}px` : '16px' }}>
      <div className="relative bg-black rounded-lg overflow-hidden group/minivid aspect-video">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover cursor-pointer"
          src={floatingVideo.src}
          onClick={togglePlayPause}
        />

        {/* Center play/pause button - separate from overlay to avoid opacity glitch */}
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

        {/* Hover controls */}
        <div className="absolute inset-0 z-40 opacity-0 group-hover/minivid:opacity-100 transition-opacity duration-150 pointer-events-none">
          <div className="absolute top-2 right-2 flex items-center gap-1 pointer-events-auto">
            <Button
              variant="ghost"
              size="icon"
              className="w-7 h-7 flex items-center justify-center text-white bg-black/50 backdrop-blur-sm rounded-md hover:bg-black/70 transition-colors"
              onClick={() => {
                const callId = floatingVideo.callId;
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
              className="w-7 h-7 flex items-center justify-center text-white bg-black/50 backdrop-blur-sm rounded-md hover:bg-black/70 transition-colors"
              onClick={dismiss}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Title */}
          <div className="absolute bottom-10 left-2.5 right-2.5">
            <p className="text-white text-xs font-medium truncate drop-shadow-md">{floatingVideo.callSubject}</p>
          </div>
        </div>

        {/* Timeline with timestamps */}
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
    </div>
  );
}
