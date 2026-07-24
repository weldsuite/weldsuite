import { useEffect, useRef, useState, useCallback } from 'react';
import { useWeldChatCall, useWeldChatCallOptional } from '@/contexts/weldchat-call-context';
import { useChannel, useChannelMembers } from '@/hooks/queries/use-weldchat-queries';
import { useUser } from '@clerk/clerk-react';
import { usePathname } from '@/lib/router';
import { Mic, MicOff, PhoneOff, Maximize, PictureInPicture2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import type { RTKParticipant, RTKSelf } from '@cloudflare/realtimekit';

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * Hidden audio playback for one remote participant.
 *
 * Remote sound is normally emitted by the <audio> elements inside the
 * MeetingRoomView tiles. When the call is minimized to this PiP widget (the user
 * navigated to another part of the app), that view is unmounted — so without
 * this sink the user would see the PiP but hear no one. Only mounted while the
 * PiP is the active surface, so it never double-plays alongside the tiles.
 */
function RemotePiPAudio({ participant }: { participant: RTKParticipant | RTKSelf }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (participant.audioEnabled && participant.audioTrack) {
      el.srcObject = new MediaStream([participant.audioTrack]);
      // autoPlay only fires on first mount; call play() so a freshly-mounted
      // element actually resumes the stream.
      el.play().catch(() => { /* autoplay blocked / already playing */ });
    } else {
      el.srcObject = null;
    }
  }, [participant.audioEnabled, participant.audioTrack]);
  return <audio ref={ref} autoPlay />;
}

/**
 * Outer guard: render nothing when the WeldChatCall provider isn't reachable.
 *
 * This widget is lazy-loaded, so during HMR Vite can re-import it (and a fresh
 * copy of `weldchat-call-context`) while the still-mounted provider holds the
 * previous context instance — `useContext` would then return null and the
 * throwing `useWeldChatCall()` would crash the whole shell. Mirrors the
 * `useWeldChatCallOptional` / `usePresenceMaybe` pattern already used in the
 * context. In production (no HMR) the provider is always reachable, so the
 * inner widget renders exactly as before.
 */
export function PiPCallWidget() {
  const ctx = useWeldChatCallOptional();
  if (!ctx) return null;
  return <PiPCallWidgetInner />;
}

function PiPCallWidgetInner() {
  const { t } = useI18n();
  const {
    status,
    channelId,
    duration,
    isMuted,
    isFullscreen,
    isPiP,
    meeting,
    toggleMute,
    endCall,
    expandFromPiP,
    toggleFullscreen,
  } = useWeldChatCall();
  const { user } = useUser();
  const pathname = usePathname();
  const { data: channelData } = useChannel(channelId ?? '');
  const { data: membersData } = useChannelMembers(channelId ?? '');
  const videoRef = useRef<HTMLVideoElement>(null);
  const hasAnimatedRef = useRef(false);
  const [, forceUpdate] = useState(0);

  const channel = channelData?.data;
  const isDm = channel?.type === 'dm';
  const members = membersData?.data || [];
  const otherMember = isDm ? members.find((m) => m.userId !== user?.id) : null;

  const callLabel = isDm
    ? otherMember?.name || otherMember?.email || t.weldchat.pipCallWidget.call
    : channel?.name || t.weldchat.pipCallWidget.call;

  // Determine whether the user is currently viewing the call's own conversation.
  // The URL param differs by route shape, so we can't just compare it to channelId:
  //   • 1:1 DM    → /weldchat/dm/$userId          (param is the OTHER user's id)
  //   • group DM  → /weldchat/dm/group/$channelId (param is the channel id)
  //   • channel   → /weldchat/$channelId          (param is the channel id)
  const groupMatch = pathname?.match(/\/weldchat\/dm\/group\/([^/]+)/);
  const dmMatch = pathname?.match(/\/weldchat\/dm\/([^/]+)/);
  const channelMatch = pathname?.match(/\/weldchat\/([^/]+)/);
  const isOnCallPage = groupMatch
    ? groupMatch[1] === channelId
    : dmMatch
      ? !!otherMember?.userId && dmMatch[1] === otherMember.userId
      : !!channelMatch && channelMatch[1] === channelId;

  const pipVideoRef = useRef<HTMLVideoElement | null>(null);
  const pipActiveRef = useRef(false);

  // Show PiP when: connected, not fullscreen, and either explicitly minimized OR navigated away
  const shouldShow = status === 'connected' && !isFullscreen && (isPiP || !isOnCallPage);

  // Force re-render when participants change
  useEffect(() => {
    if (!meeting) return;
    const tick = () => forceUpdate(n => n + 1);
    meeting.participants.joined.on('participantJoined', tick);
    meeting.participants.joined.on('participantLeft', tick);
    meeting.self.on('videoUpdate', tick);
    return () => {
      try {
        meeting.participants.joined.removeListener?.('participantJoined', tick);
        meeting.participants.joined.removeListener?.('participantLeft', tick);
        meeting.self.removeListener?.('videoUpdate', tick);
      } catch { /* ignore */ }
    };
  }, [meeting]);

  // Get video source — prefer remote participant, fall back to self
  const remoteParticipants = meeting?.participants?.joined?.toArray() || [];
  const firstRemote = remoteParticipants[0];
  const hasRemoteVideo = firstRemote?.videoEnabled && firstRemote?.videoTrack;
  const hasSelfVideo = meeting?.self?.videoEnabled && meeting?.self?.videoTrack;
  const videoTrack = hasRemoteVideo ? firstRemote.videoTrack : hasSelfVideo ? meeting.self.videoTrack : null;

  const enterNativePiP = useCallback(async () => {
    const video = pipVideoRef.current;
    if (!video || pipActiveRef.current) return;
    if (!document.pictureInPictureEnabled) {
      console.warn('[PiP] PictureInPicture not enabled in this browser');
      return;
    }

    try {
      // Set video source
      if (videoTrack) {
        video.srcObject = new MediaStream([videoTrack]);
      } else {
        // Audio-only: create a canvas with call info as video source
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = '#fff';
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(callLabel || t.weldchat.pipCallWidget.call, 160, 95);
        video.srcObject = canvas.captureStream(1);
      }

      // Wait for video to be ready
      await new Promise<void>((resolve) => {
        if (video.readyState >= 2) { resolve(); return; }
        video.onloadeddata = () => resolve();
      });
      await video.play();
      await video.requestPictureInPicture();
      pipActiveRef.current = true;
    } catch (err) {
      console.error('[PiP] Failed to enter PiP:', err);
    }
  }, [videoTrack, callLabel, t.weldchat.pipCallWidget.call]);

  const exitNativePiP = useCallback(() => {
    if (document.pictureInPictureElement && pipActiveRef.current) {
      document.exitPictureInPicture().catch(() => {});
    }
    pipActiveRef.current = false;
  }, []);

  // Keep the hidden PiP video element primed and playing so the manual "Pop out"
  // button can enter native PiP instantly (no auto-PiP — see note below).
  useEffect(() => {
    if (status !== 'connected') return;
    const video = pipVideoRef.current;
    if (!video) return;

    if (videoTrack) {
      video.srcObject = new MediaStream([videoTrack]);
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = '#fff';
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(callLabel || 'Call', 160, 95);
      video.srcObject = canvas.captureStream(1);
    }

    video.play().catch(() => {});
  }, [status, videoTrack, callLabel]);

  // NOTE: Automatic native PiP on tab switch is intentionally NOT registered.
  // We only want the in-app floating widget to follow the user around the
  // platform; popping a separate browser PiP window out of the tab on every
  // tab switch is unwanted. The native PiP window is now only entered when the
  // user explicitly clicks the "Pop out" button (which calls enterNativePiP).
  // We still listen for `leavepictureinpicture` so our state resets when the
  // user closes that manually-opened window, and we exit PiP on unmount.
  useEffect(() => {
    if (status !== 'connected') return;

    const onPiPLeave = () => { pipActiveRef.current = false; };

    const video = pipVideoRef.current;
    video?.addEventListener('leavepictureinpicture', onPiPLeave);

    return () => {
      video?.removeEventListener('leavepictureinpicture', onPiPLeave);
      exitNativePiP();
    };
  }, [status, exitNativePiP]);

  // Keep PiP video track in sync
  useEffect(() => {
    if (pipVideoRef.current && videoTrack) {
      pipVideoRef.current.srcObject = new MediaStream([videoTrack]);
    }
  }, [videoTrack]);

  // Exit PiP when call ends
  useEffect(() => {
    if (status !== 'connected') {
      exitNativePiP();
    }
  }, [status, exitNativePiP]);

  // Attach video
  useEffect(() => {
    if (!videoRef.current || !shouldShow) return;
    if (videoTrack) {
      const stream = new MediaStream([videoTrack]);
      videoRef.current.srcObject = stream;
    } else {
      videoRef.current.srcObject = null;
    }
  }, [videoTrack, shouldShow]);

  // Hidden video element backing the manual "Pop out" button (must always be in
  // the DOM so enterNativePiP can attach a stream to it). We deliberately do NOT
  // set `autopictureinpicture` here — that attribute is what made Chrome pop a
  // native PiP window out of the tab automatically on tab switch, which is the
  // behaviour we're removing. Native PiP is now only entered on explicit click.
  const pipElement = (
    <video
      ref={pipVideoRef}
      autoPlay
      playsInline
      className="fixed top-0 left-0 w-[320px] h-[180px] opacity-0 pointer-events-none -z-50"
    />
  );

  const displayName = firstRemote?.name || otherMember?.name || user?.fullName || '';
  const displayInitial = (displayName || '?')[0].toUpperCase();
  const displayPicture = firstRemote?.picture || otherMember?.picture || user?.imageUrl;

  // Track first appearance for entrance animation
  if (shouldShow && !hasAnimatedRef.current) hasAnimatedRef.current = true;
  // Reset when call ends so next call gets the animation
  if (status !== 'connected') hasAnimatedRef.current = false;

  return (
    <>
    {pipElement}
    {/* Remote audio — only while the PiP is the active surface (MeetingRoomView
        is unmounted then, so its tiles aren't also playing). Without this the
        minimized call is silent. */}
    {shouldShow && remoteParticipants.map((p) => (
      <RemotePiPAudio key={p.id} participant={p} />
    ))}
    <div className={cn(
      "fixed bottom-4 right-4 z-[9999] w-[300px] rounded-2xl overflow-hidden shadow-2xl border border-border bg-background",
      shouldShow ? "opacity-100" : "opacity-0 pointer-events-none sr-only",
      !hasAnimatedRef.current && shouldShow && "animate-in slide-in-from-bottom-4 fade-in duration-300",
    )}>
      {/* Video / Avatar area */}
      <div
        className="relative mx-2 mt-2 aspect-video rounded-xl overflow-hidden bg-muted flex items-center justify-center cursor-pointer"
        onClick={() => {
          expandFromPiP();
          toggleFullscreen();
        }}
      >
        {videoTrack ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={cn("w-full h-full object-cover", !hasRemoteVideo && "-scale-x-100")}
          />
        ) : (
          <Avatar className="h-14 w-14 !rounded-[16px]">
            {displayPicture && <AvatarImage src={displayPicture} className="!rounded-[16px]" />}
            <AvatarFallback className="text-xl bg-muted-foreground/20 text-foreground !rounded-[16px]">{displayInitial}</AvatarFallback>
          </Avatar>
        )}

        {/* Expand button */}
        <Button
          variant="ghost"
          className="absolute top-2 right-2 p-1.5 rounded-lg bg-background/70 hover:bg-muted/70 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            expandFromPiP();
            toggleFullscreen();
          }}
          title={t.weldchat.pipCallWidget.expand}
        >
          <Maximize className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>

        {/* Name tag */}
        <span className="absolute top-2 left-2 text-foreground/80 text-xs font-medium bg-background/60 rounded-md px-1.5 py-0.5">
          {callLabel}
        </span>
      </div>

      {/* Controls bar */}
      <div className="flex items-center justify-between px-3 py-2.5 bg-background">
        <span className="text-xs text-muted-foreground font-mono">{formatDuration(duration)}</span>
        <div className="flex items-center gap-2">
          {document.pictureInPictureEnabled && (
            <Button
              variant="secondary"
              size="icon"
              className="h-8 w-8 rounded-[10px] border-0"
              onClick={enterNativePiP}
              title={t.weldchat.pipCallWidget.popOut}
            >
              <PictureInPicture2 className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="secondary"
            size="icon"
            className={cn(
              "h-8 w-8 rounded-[10px] border-0",
              isMuted && "bg-red-100 hover:bg-red-200 text-red-500 dark:bg-red-500/20 dark:hover:bg-red-500/30 dark:text-red-400"
            )}
            onClick={toggleMute}
          >
            {isMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="destructive"
            size="icon"
            className="h-8 w-8 rounded-[10px]"
            onClick={endCall}
          >
            <PhoneOff className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
    </>
  );
}
