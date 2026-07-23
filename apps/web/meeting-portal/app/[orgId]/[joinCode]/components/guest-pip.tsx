'use client';

/**
 * Out-of-browser Picture-in-Picture for the meeting portal.
 *
 * Chromium: Document Picture-in-Picture — a real OS window that we portal a
 * compact meeting view into (focused tile + mic/cam/leave), with the host
 * document's stylesheets cloned so Tailwind works.
 * Other browsers: fall back to native single-video PiP of the focused tile.
 *
 * `openPiP()` MUST be called inside a user gesture (Document PiP requires user
 * activation) — wire it to the 3-dots "Picture in picture" click.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mic, MicOff, Video, VideoOff, PhoneOff } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';

export interface PiPFocused {
  name: string;
  videoTrack: MediaStreamTrack | null;
  isSelf: boolean;
}

interface GuestPiPOptions {
  focused: PiPFocused;
  meetingTitle: string;
  isMuted: boolean;
  isVideoOff: boolean;
  onToggleMute: () => void;
  onToggleVideo: () => void;
  onLeave: () => void;
}

export function useGuestPiP(opts: GuestPiPOptions) {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const nativeVideoRef = useRef<HTMLVideoElement | null>(null);

  const openPiP = useCallback(() => {
    const dpip = (window as unknown as { documentPictureInPicture?: { requestWindow: (o: { width: number; height: number }) => Promise<Window> } }).documentPictureInPicture;

    if (dpip) {
      if (pipWindow) return;
      // requestWindow is called synchronously in the gesture — do not await
      // anything before it or the user-activation is lost.
      dpip
        .requestWindow({ width: 360, height: 320 })
        .then((w: Window) => {
          // Clone host stylesheets so Tailwind utilities + theme tokens apply.
          Array.from(document.styleSheets).forEach((sheet) => {
            try {
              const rules = Array.from(sheet.cssRules ?? [])
                .map((r) => r.cssText)
                .join('\n');
              const style = w.document.createElement('style');
              style.textContent = rules;
              w.document.head.appendChild(style);
            } catch {
              if (sheet.href) {
                const link = w.document.createElement('link');
                link.rel = 'stylesheet';
                link.href = sheet.href;
                w.document.head.appendChild(link);
              }
            }
          });
          if (document.documentElement.classList.contains('dark')) {
            w.document.documentElement.classList.add('dark');
          }
          w.document.body.style.margin = '0';
          w.document.body.style.background = 'transparent';
          w.addEventListener('pagehide', () => setPipWindow(null));
          setPipWindow(w);
        })
        .catch((err: unknown) => console.error('[GuestPiP] Document PiP failed:', err));
      return;
    }

    // Fallback: native single-video PiP of the focused tile.
    const v = nativeVideoRef.current;
    if (v && document.pictureInPictureEnabled && v.srcObject) {
      if (v.paused) v.play().catch(() => {});
      v.requestPictureInPicture().catch((err: unknown) => {
        if ((err as { name?: string } | null)?.name !== 'NotAllowedError') {
          console.error('[GuestPiP] native PiP failed:', err);
        }
      });
    }
  }, [pipWindow]);

  // Keep the hidden native-fallback video bound to the focused track so a
  // non-Chromium browser has something to pop out.
  useEffect(() => {
    const v = nativeVideoRef.current;
    if (!v) return;
    if (opts.focused.videoTrack) {
      v.srcObject = new MediaStream([opts.focused.videoTrack]);
      v.play().catch(() => {});
    } else {
      v.srcObject = null;
    }
  }, [opts.focused.videoTrack]);

  // Close the popup if the room unmounts (meeting ended / left).
  useEffect(
    () => () => {
      if (pipWindow) {
        try {
          pipWindow.close();
        } catch {
          /* ignore */
        }
      }
    },
    [pipWindow],
  );

  const pipNode = (
    <>
      <video
        ref={nativeVideoRef}
        autoPlay
        muted
        playsInline
        style={{ position: 'fixed', width: 1, height: 1, opacity: 0.01, bottom: 0, right: 0, pointerEvents: 'none', zIndex: -1 }}
      />
      {pipWindow && createPortal(<GuestPiPContent {...opts} pipWindow={pipWindow} />, pipWindow.document.body)}
    </>
  );

  return { openPiP, pipNode };
}

function GuestPiPContent({
  focused,
  isMuted,
  isVideoOff,
  onToggleMute,
  onToggleVideo,
  onLeave,
  pipWindow,
}: GuestPiPOptions & { pipWindow: Window }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Re-bind the track whenever it changes OR the popup (re)mounts the element.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (focused.videoTrack) {
      v.srcObject = new MediaStream([focused.videoTrack]);
      v.play().catch(() => {});
    } else {
      v.srcObject = null;
    }
  }, [focused.videoTrack, pipWindow]);

  return (
    <div className="w-screen h-screen flex flex-col bg-card p-2">
      <div className="relative flex-1 min-h-0 overflow-hidden rounded-xl bg-black ring-1 ring-border">
        {focused.videoTrack ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={focused.isSelf}
            className={cn('absolute inset-0 h-full w-full object-cover', focused.isSelf && '-scale-x-100')}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">
            {focused.isSelf ? 'You' : focused.name}
          </div>
        )}
        <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-xs text-white">
          <span className="truncate">{focused.isSelf ? 'You' : focused.name}</span>
        </div>
      </div>

      <div className="flex items-center justify-center gap-2 pt-2">
        <button
          onClick={onToggleMute}
          title={isMuted ? 'Unmute' : 'Mute'}
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-[12px] transition-colors',
            isMuted ? 'bg-red-500/20 text-red-500' : 'bg-secondary text-foreground hover:brightness-95',
          )}
        >
          {isMuted ? <MicOff className="h-[18px] w-[18px]" /> : <Mic className="h-[18px] w-[18px]" />}
        </button>
        <button
          onClick={onToggleVideo}
          title={isVideoOff ? 'Turn on camera' : 'Turn off camera'}
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-[12px] transition-colors',
            isVideoOff ? 'bg-red-500/20 text-red-500' : 'bg-secondary text-foreground hover:brightness-95',
          )}
        >
          {isVideoOff ? <VideoOff className="h-[18px] w-[18px]" /> : <Video className="h-[18px] w-[18px]" />}
        </button>
        <button
          onClick={onLeave}
          title="Leave"
          className="flex h-10 w-14 items-center justify-center rounded-[12px] bg-destructive text-destructive-foreground transition-all hover:brightness-90"
        >
          <PhoneOff className="h-[18px] w-[18px]" />
        </button>
      </div>
    </div>
  );
}
