import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from '@tanstack/react-router';
import { useAuth } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { usePathname } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';
import { Mic, MicOff, VideoOff, Phone, MonitorUp, MoreVertical, Hand, Maximize, PictureInPicture2, Copy } from 'lucide-react';
import { useWeldMeetCall } from '@/contexts/weldmeet-call-context';
import { useMeeting } from '@/hooks/queries/use-weldmeet-queries';
import { useWorkspaceId } from '@/contexts/workspace-context';
import type { RTKParticipant } from '@cloudflare/realtimekit';
import { ParticipantAvatar, getPersonTheme, getInitials } from '@weldsuite/weldmeet-ui';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@/lib/utils';
import { usePipCornerDrag } from './use-pip-corner-drag';

// Chrome-only Document Picture-in-Picture API — not yet in standard DOM lib types.
interface DocumentPictureInPictureAPI {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * Google-Meet–style picture-in-picture widget. Shown bottom-right when the
 * user navigates away from the meeting room (or explicitly minimizes). One
 * video tile (active speaker / self), with 3 round controls — mic, camera,
 * hangup — that fade in on hover, and a back-to-meeting button in the top.
 *
 * The underlying RTK call client lives on WeldMeetCallProvider at the
 * app-shell level — the meeting itself stays alive across navigation.
 */
export function MeetingPiPWidget() {
  const {
    status,
    meetingId,
    duration,
    isMuted,
    isVideoOff,
    isScreenSharing,
    handRaised,
    isFullscreen,
    isPiP,
    meeting,
    meetingTitle,
    isOrganizer,
    prewarmedVideoTrack,
    toggleMute,
    toggleVideo,
    startScreenShare,
    stopScreenShare,
    toggleHandRaise,
    leaveMeeting,
    endMeeting,
    expandFromPiP,
    registerPopOut,
  } = useWeldMeetCall();

  const navigate = useNavigate();
  const pathname = usePathname();
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const pipVideoRef = useRef<HTMLVideoElement | null>(null);
  const pipActiveRef = useRef(false);
  const hasAnimatedRef = useRef(false);
  const [, forceUpdate] = useState(0);
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  // Width occupied by ANY open right-side panel, so the widget slides left and
  // sits next to it instead of being covered. Rather than wiring every panel's
  // own signal (notifications, calendar, WeldAgent, object/detail panels, …),
  // we measure the one thing they all affect: every module layout shrinks its
  // `[data-module-content]` wrapper from the right by the combined panel width.
  // So `viewport.right - content.right` IS the reserved width — one signal that
  // captures all current and future panels. Re-measured live via ResizeObserver
  // so the widget tracks the layout's width transition in lockstep.
  const [panelWidth, setPanelWidth] = useState(0);
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const el = document.querySelector('[data-module-content]');
      if (!el) {
        setPanelWidth(0);
        return;
      }
      const reserved = Math.round(window.innerWidth - el.getBoundingClientRect().right);
      // Ignore sub-panel noise (scrollbars etc.); real panels are ≥ ~480px.
      setPanelWidth(reserved > 24 ? reserved : 0);
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    schedule();
    const el = document.querySelector('[data-module-content]');
    const ro = el ? new ResizeObserver(schedule) : null;
    if (el) ro!.observe(el);
    window.addEventListener('resize', schedule);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', schedule);
      cancelAnimationFrame(raf);
    };
  }, [pathname]);

  const t = getTranslations('weldmeet');
  const isOnMeetingPage = !!meetingId && pathname?.startsWith(`/weldmeet/${meetingId}`);
  const shouldShow = status === 'connected' && !isFullscreen && (isPiP || !isOnMeetingPage);

  // Drag-to-corner for the in-page minimized widget (disabled in the Document
  // PiP popup, which fills its own OS window).
  const widgetRef = useRef<HTMLDivElement>(null);
  const pipDrag = usePipCornerDrag(widgetRef, { panelWidth, enabled: !pipWindow && shouldShow });

  // Joining info (copied from the "More" menu) — mirrors the meeting-overlay
  // share URL: <portal>/<workspace>/<joinCode>.
  const { orgId } = useAuth();
  const workspaceId = useWorkspaceId() || orgId;
  const { data: meetingData } = useMeeting(meetingId ?? '');
  const handleCopyJoiningInfo = useCallback(() => {
    const joinCode = meetingData?.joinCode ?? '';
    const portalUrl = import.meta.env.VITE_MEETING_PORTAL_URL || window.location.origin;
    const shareUrl = joinCode ? `${portalUrl}/${workspaceId}/${joinCode}` : '';
    const text = [
      t.pipWidget.joiningInfoTitle,
      shareUrl ? `${t.pipWidget.joiningInfoJoin}: ${shareUrl}` : null,
      joinCode ? `${t.pipWidget.joiningInfoMeetingId}: ${joinCode}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    if (!text) return;
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(t.pipWidget.joiningInfoCopied))
      .catch(() => {});
  }, [meetingData?.joinCode, workspaceId, t]);

  useEffect(() => {
    if (!meeting) return;
    const tick = () => forceUpdate(n => n + 1);
    meeting.participants?.joined?.on?.('participantJoined', tick);
    meeting.participants?.joined?.on?.('participantLeft', tick);
    meeting.self?.on?.('videoUpdate', tick);
    meeting.self?.on?.('audioUpdate', tick);
    return () => {
      try {
        meeting.participants?.joined?.removeListener?.('participantJoined', tick);
        meeting.participants?.joined?.removeListener?.('participantLeft', tick);
        meeting.self?.removeListener?.('videoUpdate', tick);
        meeting.self?.removeListener?.('audioUpdate', tick);
      } catch { /* ignore */ }
    };
  }, [meeting]);

  // Pick the most relevant participant — first remote (active speaker proxy)
  // or fall back to self.
  const remoteParticipants: RTKParticipant[] = meeting?.participants?.joined?.toArray?.() ?? [];
  const focused = remoteParticipants[0] ?? meeting?.self ?? null;
  const focusedIsSelf = !remoteParticipants[0];
  const focusedName = focused?.name || (focusedIsSelf ? t.pipWidget.you : t.pipWidget.participant);
  const focusedHasVideo = !!(focused?.videoEnabled && focused?.videoTrack);
  const focusedTrack = focusedHasVideo ? focused.videoTrack : null;
  const focusedAudioTrack = focused?.audioEnabled ? focused?.audioTrack : null;

  // Camera-off appearance — match the maximized ParticipantTile exactly:
  // deterministic colored tile background + ParticipantAvatar. Seed mirrors the
  // tile's (customParticipantId → userId → id → name) so colors agree.
  const focusedTheme = getPersonTheme(
    String(focused?.customParticipantId ?? focused?.userId ?? focused?.id ?? focusedName),
  );
  const focusedInitials = getInitials(focusedName);

  // Attach video to the visible tile.
  // NOTE: `pipWindow` MUST be a dep — when Document PiP opens, createPortal
  // mounts a new <video> element in the popup document, so we have to re-bind
  // the MediaStream to the new element. Without this, the popup renders blank.
  useEffect(() => {
    if (!videoRef.current) return;
    if (focusedTrack) {
      videoRef.current.srcObject = new MediaStream([focusedTrack]);
      videoRef.current.play().catch(() => { /* autoplay blocked or already playing */ });
    } else {
      videoRef.current.srcObject = null;
    }
  }, [focusedTrack, pipWindow]);

  // Attach audio (only when focusing a remote — never play self audio back)
  useEffect(() => {
    if (!audioRef.current) return;
    if (!focusedIsSelf && focusedAudioTrack) {
      audioRef.current.srcObject = new MediaStream([focusedAudioTrack]);
      audioRef.current.play().catch(() => { /* ignore */ });
    } else {
      audioRef.current.srcObject = null;
    }
  }, [focusedIsSelf, focusedAudioTrack, pipWindow]);

  // ─── Native browser PiP (auto on tab switch) ─────────────────────────────
  // Do NOT touch srcObject here — the dedicated effect below owns the stream
  // (a continuous 30fps canvas or the focused track) and clobbering it with
  // a fresh static captureStream(1) leaves the video with a single-frame
  // stream after PiP exits, which then disqualifies it from Chrome's
  // auto-PiP heuristic on subsequent tab switches. That's exactly the
  // "works once, then breaks" pattern.
  const enterNativePiP = useCallback((): Promise<void> | void => {
    const video = pipVideoRef.current;
    if (!video || pipActiveRef.current) return;
    if (!document.pictureInPictureEnabled) return;
    // Don't double-PiP if Document PiP is already open
    if (pipWindow) return;

    // CRITICAL: when this is invoked from the MediaSession action handler
    // (Chrome's auto-PiP path on tab switch), the activation token Chrome
    // grants is consumed by the FIRST relevant API call AND does NOT
    // survive `await`s across microtasks. So:
    //   - DO NOT `await video.play()` — that consumes the activation
    //     before requestPictureInPicture sees it. Call play() in a
    //     fire-and-forget way so the video is primed but the next
    //     statement runs synchronously.
    //   - DO NOT wait for `onloadeddata` — keep the video continuously
    //     primed externally so readyState >= 2 by the time we get here.
    //   - Call requestPictureInPicture SYNCHRONOUSLY in the same task as
    //     the action handler invocation.
    if (video.paused) video.play().catch(() => {});
    const p = video.requestPictureInPicture();
    return p
      .then(() => { pipActiveRef.current = true; })
      .catch((err: unknown) => {
        // NotAllowedError is expected on visibilitychange-triggered calls
        // when the user hasn't recently clicked — Chrome requires user
        // activation for `requestPictureInPicture` outside the MediaSession
        // action callback. Silently swallow that specific case so the
        // console isn't spammed; log everything else.
        const name = (err as { name?: string } | null)?.name;
        if (name !== 'NotAllowedError') {
          console.error('[MeetingPiP] requestPictureInPicture failed:', err);
        }
      });
  }, [pipWindow]);

  const exitNativePiP = useCallback(() => {
    if (document.pictureInPictureElement && pipActiveRef.current) {
      document.exitPictureInPicture().catch(() => {});
    }
    pipActiveRef.current = false;
    // Re-prime the video and media session so the NEXT tab switch is also
    // eligible for auto-PiP. Chrome briefly pauses the off-screen video on
    // PiP exit and may downgrade the media session — we restore both.
    const video = pipVideoRef.current;
    if (video?.paused) video.play().catch(() => {});
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = 'playing'; } catch { /* ignore */ }
    }
  }, []);

  // ─── Document Picture-in-Picture (Chromium 116+) — full DOM popup ────────
  // Lets us render the same React widget into a real popup window, so the
  // pop-out has the EXACT same design (Tailwind classes, theme tokens, all
  // interactive controls work).
  const openDocumentPip = useCallback(async () => {
    const dpip = (window as Window & { documentPictureInPicture?: DocumentPictureInPictureAPI }).documentPictureInPicture;
    if (!dpip) {
      // Fallback: legacy native video PiP (just a video tile, no UI)
      return enterNativePiP();
    }
    if (pipWindow) return;
    try {
      const w: Window = await dpip.requestWindow({ width: 360, height: 380 });

      // Clone every stylesheet from the host document so Tailwind v4 utilities
      // and CSS custom properties (--background, --card, --border, etc.) work.
      Array.from(document.styleSheets).forEach((sheet) => {
        try {
          const rules = Array.from(sheet.cssRules ?? [])
            .map((r) => r.cssText)
            .join('\n');
          const style = w.document.createElement('style');
          style.textContent = rules;
          w.document.head.appendChild(style);
        } catch {
          // CORS-restricted — re-link by URL
          if (sheet.href) {
            const link = w.document.createElement('link');
            link.rel = 'stylesheet';
            link.href = sheet.href;
            w.document.head.appendChild(link);
          }
        }
      });

      // Mirror dark/light theme onto the popup
      if (document.documentElement.classList.contains('dark')) {
        w.document.documentElement.classList.add('dark');
      }
      w.document.body.style.margin = '0';
      w.document.body.style.background = 'transparent';

      // Closing the pop-out window must also clear the minimized (isPiP) state.
      // Otherwise `shouldShow` stays true and the widget re-renders inline,
      // overlaying the full meeting page. Clearing it returns to the full
      // meeting when on the meeting page; off-page the widget still shows via
      // `!isOnMeetingPage`.
      w.addEventListener('pagehide', () => {
        setPipWindow(null);
        expandFromPiP();
      });
      setPipWindow(w);
    } catch (err) {
      console.error('[MeetingPiP] Document PiP failed:', err);
    }
  }, [enterNativePiP, pipWindow, expandFromPiP]);

  // Single entry point: prefer Document PiP, fall back to legacy native PiP
  const openPopOut = useCallback(() => {
    if ('documentPictureInPicture' in window) {
      openDocumentPip();
    } else {
      enterNativePiP();
    }
  }, [openDocumentPip, enterNativePiP]);

  // Expose the pop-out opener to the call context so the in-meeting 3-dots menu
  // can trigger the out-of-browser PiP window (not just the in-app widget).
  useEffect(() => {
    registerPopOut(openPopOut);
  }, [registerPopOut, openPopOut]);

  // Close the document PiP when the meeting ends
  useEffect(() => {
    if (status !== 'connected' && pipWindow) {
      try { pipWindow.close(); } catch { /* ignore */ }
      setPipWindow(null);
    }
  }, [status, pipWindow]);

  // Cleanup the popup if the component unmounts mid-call
  useEffect(() => {
    return () => {
      if (pipWindowRef.current) {
        try { pipWindowRef.current.close(); } catch { /* ignore */ }
      }
    };
  }, []);

  // Pick the highest-fidelity stream we have available to keep the hidden
  // video continuously playing. Priority:
  //   1. focusedTrack — live meeting (active speaker / self), once connected.
  //   2. prewarmedVideoTrack — RTK SelfMedia from `RealtimeKitClient.initMedia`,
  //      acquired by WeldMeetCallProvider while the user is on /weldmeet/new.
  //      This is what gives the click that starts an instant meeting an
  //      already-active real-media session on the origin so Chrome fires
  //      auto-PiP immediately on tab switch — and the same SelfMedia is
  //      handed off to RealtimeKitClient.init via `defaults.mediaHandler`,
  //      so RTK reuses these tracks without re-acquiring the device (no
  //      permission re-prompt, no camera-light flicker on join).
  //   3. canvas — placeholder when there's neither a meeting nor a pre-warm.
  const activeRealTrack = focusedTrack ?? prewarmedVideoTrack;

  useEffect(() => {
    const video = pipVideoRef.current;
    if (!video) return;

    let redrawTimer: ReturnType<typeof setInterval> | null = null;
    let playRetryTimer: ReturnType<typeof setInterval> | null = null;

    if (activeRealTrack) {
      video.srcObject = new MediaStream([activeRealTrack]);
    } else {
      // Continuously-redrawn canvas at 30fps. captureStream(1) produces a
      // single static frame, which Chrome's auto-PiP heuristic treats as
      // "not actively playing" — the tab-switch trigger then never fires
      // until something else (a real track or a user gesture) wakes the
      // video up.
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d')!;
      const draw = () => {
        ctx.fillStyle = '#0b0b0e';
        ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = '#fff';
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(meetingTitle || 'Meeting', 160, 95);
      };
      draw();
      redrawTimer = setInterval(draw, 1000);
      video.srcObject = canvas.captureStream(30);
    }

    // Some autoplay paths (off-screen muted video, no recent gesture) leave
    // the video paused. Retry until it actually plays, then keep nudging it
    // back if Chrome later pauses it (notably right after exiting PiP). The
    // 250ms cadence is what guarantees the video is unpaused before the user
    // can switch tabs again — at 1s, fast back-and-forth tab switches catch
    // the video paused and Chrome then skips auto-PiP.
    const tryPlay = () => video.play().catch(() => {});
    tryPlay();
    playRetryTimer = setInterval(() => {
      if (video.paused) tryPlay();
    }, 250);

    return () => {
      if (redrawTimer) clearInterval(redrawTimer);
      if (playRetryTimer) clearInterval(playRetryTimer);
    };
  }, [activeRealTrack, meetingTitle]);

  // Register MediaSession action handlers ONCE on mount (not gated on
  // status). Reason: the click that starts an instant meeting → immediate
  // tab switch happens BEFORE `status` reaches 'connected' (RTK takes
  // ~1–3 s to negotiate). Chrome only fires `enterpictureinpicture` on
  // tab switch when the action handler is already wired up at the moment
  // the tab loses visibility. The handler reads the LATEST enterNativePiP
  // via a ref, so closure staleness doesn't matter.
  const enterPipForActionRef = useRef(enterNativePiP);
  useEffect(() => { enterPipForActionRef.current = enterNativePiP; }, [enterNativePiP]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'WeldMeet',
      artist: 'WeldMeet',
    });
    const handleEnterPiP = () => { enterPipForActionRef.current(); };
    try {
      // @ts-expect-error -- 'enterpictureinpicture' is a Chrome MediaSessionAction not in standard lib types
      navigator.mediaSession.setActionHandler('enterpictureinpicture', handleEnterPiP);
    } catch { /* unsupported */ }
    // Other handlers Chrome expects on a "real" media session — without these
    // some Chrome builds silently downgrade the session and skip auto-PiP.
    const noop = () => {};
    try { navigator.mediaSession.setActionHandler('play', noop); } catch { /* ignore */ }
    try { navigator.mediaSession.setActionHandler('pause', noop); } catch { /* ignore */ }

    return () => {
      try {
        // @ts-expect-error -- see above
        navigator.mediaSession.setActionHandler('enterpictureinpicture', null);
      } catch { /* ignore */ }
      try { navigator.mediaSession.setActionHandler('play', null); } catch { /* ignore */ }
      try { navigator.mediaSession.setActionHandler('pause', null); } catch { /* ignore */ }
      navigator.mediaSession.metadata = null;
    };
  }, []);

  // Flip playbackState to 'playing' as soon as a meeting starts negotiating
  // (`connecting`), not just after `connected`. RTK takes ~1–3 s to fully
  // connect, and a user who immediately switches tabs after clicking
  // "Instant Meeting" otherwise hits a window where no MediaSession is
  // active → Chrome skips auto-PiP. Reset to 'none' when the meeting ends
  // so a later random tab-switch doesn't auto-PiP a stale placeholder.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    if (status === 'connected' || status === 'connecting' || status === 'preview') {
      try { navigator.mediaSession.playbackState = 'playing'; } catch { /* ignore */ }
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meetingTitle || 'Meeting',
        artist: 'WeldMeet',
      });
    } else if (status === 'idle' || status === 'ended') {
      try { navigator.mediaSession.playbackState = 'none'; } catch { /* ignore */ }
    }
  }, [status, meetingTitle]);

  // Always-current status, so the gesture listener (registered once at
  // mount with []-deps) can decide whether to promote MediaSession without
  // tearing down and re-attaching on every status flip.
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  // Stable refs to the latest enter/exit fns + pipWindow flag, so the
  // visibilitychange listener registers ONCE per connected session.
  // Previously the listener re-registered on every focusedTrack/meetingTitle
  // change, leaving brief windows where tab-switches were missed.
  const enterNativePipRef = useRef(enterNativePiP);
  const exitNativePipRef = useRef(exitNativePiP);
  const pipWindowRef = useRef(pipWindow);
  useEffect(() => { enterNativePipRef.current = enterNativePiP; }, [enterNativePiP]);
  useEffect(() => { exitNativePipRef.current = exitNativePiP; }, [exitNativePiP]);
  useEffect(() => { pipWindowRef.current = pipWindow; }, [pipWindow]);

  useEffect(() => {
    if (status !== 'connected') return;
    const onVisChange = () => {
      // Don't fire native PiP while Document PiP popup is already open
      if (pipWindowRef.current) return;
      if (document.hidden) enterNativePipRef.current();
      else exitNativePipRef.current();
    };
    // When PiP closes (user clicks the close button or returns to the tab),
    // re-prime the video AND media session right away so the next tab
    // switch is again eligible for auto-PiP. Without this, Chrome leaves the
    // session in a state where the second `enterpictureinpicture` action
    // never fires.
    const onPiPLeave = () => { exitNativePipRef.current(); };
    const videoEl = pipVideoRef.current;

    document.addEventListener('visibilitychange', onVisChange);
    videoEl?.addEventListener('leavepictureinpicture', onPiPLeave);
    return () => {
      document.removeEventListener('visibilitychange', onVisChange);
      videoEl?.removeEventListener('leavepictureinpicture', onPiPLeave);
      exitNativePipRef.current();
    };
  }, [status]);

  // Capture user gestures globally and ALWAYS — not gated on status — so the
  // very click that starts the instant meeting is what promotes the hidden
  // video to "user-initiated playback". Chrome only fires auto-PiP on tab
  // switch when the active media session was started under a user gesture;
  // programmatic play() from setInterval doesn't qualify. The widget mounts
  // in the app shell, so registering at mount means the "Instant Meeting"
  // click in another component is observed in the capture phase before any
  // navigation, and its activation is bound to play() of the hidden video.
  //
  // For the click that STARTS a meeting (status is still 'idle' until RTK
  // reaches 'connecting' a moment later), we gate by pathname: any click
  // while on a `/weldmeet/*` URL is treated as meeting-context, so we both
  // play() the video AND mark MediaSession 'playing' immediately. Without
  // this, the tab-switch happening before `status` flips finds the session
  // inactive and Chrome skips auto-PiP. Random clicks elsewhere on the
  // platform skip the playbackState change so they don't leave a stale
  // session that would auto-PiP a placeholder canvas later.
  useEffect(() => {
    const onUserGesture = () => {
      const v = pipVideoRef.current;
      if (v && v.paused) v.play().catch(() => {});
      const inMeetingContext =
        statusRef.current === 'connecting' ||
        statusRef.current === 'connected' ||
        statusRef.current === 'preview' ||
        (typeof window !== 'undefined' && window.location.pathname.startsWith('/weldmeet'));
      if (inMeetingContext && 'mediaSession' in navigator) {
        try { navigator.mediaSession.playbackState = 'playing'; } catch { /* ignore */ }
      }
    };
    document.addEventListener('pointerdown', onUserGesture, { capture: true });
    document.addEventListener('keydown', onUserGesture, { capture: true });
    return () => {
      document.removeEventListener('pointerdown', onUserGesture, { capture: true });
      document.removeEventListener('keydown', onUserGesture, { capture: true });
    };
  }, []);

  useEffect(() => {
    if (status !== 'connected') exitNativePiP();
  }, [status, exitNativePiP]);

  // ─── Actions ───────────────────────────────────────────────────────────────
  const handleExpand = useCallback(() => {
    // Ignore the click that fires at the end of a drag.
    if (pipDrag.didDragRef.current) return;
    expandFromPiP();
    if (meetingId) {
      navigate({ to: '/weldmeet/$meetingId/room', params: { meetingId } });
    }
  }, [expandFromPiP, navigate, meetingId, pipDrag.didDragRef]);

  const handleEnd = useCallback(() => {
    if (isOrganizer) endMeeting();
    else leaveMeeting();
  }, [isOrganizer, endMeeting, leaveMeeting]);

  const handleScreenShare = useCallback(() => {
    if (isScreenSharing) stopScreenShare();
    else {
      startScreenShare({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15 } },
        audio: false,
      }).catch(() => { /* user cancelled */ });
    }
  }, [isScreenSharing, startScreenShare, stopScreenShare]);

  if (shouldShow && !hasAnimatedRef.current) hasAnimatedRef.current = true;
  if (status !== 'connected') hasAnimatedRef.current = false;

  // Hidden video element for native browser PiP — must always be in the DOM.
  //
  // CRITICAL POSITIONING NOTES:
  // - `muted` is REQUIRED for unattended autoplay in Chromium.
  // - The participant tiles in the meeting overlay deliberately do NOT have
  //   `autopictureinpicture`, so this hidden video is the SOLE candidate
  //   Chrome can auto-PiP on tab switch.
  // - The element must be IN THE VIEWPORT for Chrome's auto-PiP heuristic
  //   to consider it eligible. Chrome prunes:
  //     * `display: none` / `visibility: hidden` videos
  //     * `opacity: 0` videos
  //     * videos whose bounding box doesn't intersect the viewport (e.g.
  //       positioned at `top: -9999px`)
  //   So we render it ON-SCREEN at 1×1 px with opacity 0.01 — visually
  //   undetectable to the user, but a real, in-viewport, "playing" video
  //   that satisfies the heuristic.
  // React 19 doesn't always pass through the lowercase `autopictureinpicture`
  // HTML attribute reliably — it's a Chrome vendor-specific attribute that
  // isn't in React's known-attribute list. Set BOTH the JSX attribute (as a
  // hint) AND the DOM property imperatively to be sure Chrome sees it.
  const setHiddenPipRef = useCallback((el: HTMLVideoElement | null) => {
    pipVideoRef.current = el;
    if (el) {
      try {
        // The DOM property is the source of truth Chrome reads.
        (el as HTMLVideoElement & { autoPictureInPicture?: boolean }).autoPictureInPicture = true;
        // Belt-and-suspenders: also set the HTML attribute explicitly.
        el.setAttribute('autopictureinpicture', '');
      } catch { /* property unsupported in this browser — silently degrade */ }
    }
  }, []);

  const hiddenPipElement = (
    <video
      ref={setHiddenPipRef}
      autoPlay
      muted
      playsInline
      style={{
        position: 'fixed',
        bottom: 0,
        right: 0,
        width: 1,
        height: 1,
        opacity: 0.01,
        pointerEvents: 'none',
        zIndex: -1,
      }}
    />
  );

  const isInPipWindow = !!pipWindow;

  const widget = (
    <div
      ref={isInPipWindow ? undefined : widgetRef}
      onPointerDown={isInPipWindow ? undefined : pipDrag.handlers.onPointerDown}
      onPointerMove={isInPipWindow ? undefined : pipDrag.handlers.onPointerMove}
      onPointerUp={isInPipWindow ? undefined : pipDrag.handlers.onPointerUp}
      onPointerCancel={isInPipWindow ? undefined : pipDrag.handlers.onPointerCancel}
      // Block the browser's native image/text drag so grabbing the avatar (or
      // any image) drags the whole widget instead of starting a ghost-image drag.
      onDragStart={isInPipWindow ? undefined : (e) => e.preventDefault()}
      className={cn(
        'group/pip bg-card p-2',
        isInPipWindow
          ? 'w-screen h-screen flex flex-col'
          : cn(
              'fixed z-[9999] w-[290px] rounded-2xl shadow-2xl ring-1 ring-border cursor-grab [&_img]:select-none',
              pipDrag.isDragging && 'cursor-grabbing select-none',
              shouldShow ? 'opacity-100' : 'opacity-0 pointer-events-none sr-only',
              !hasAnimatedRef.current && shouldShow && !pipDrag.isDragging && 'animate-in slide-in-from-bottom-4 fade-in duration-300',
            ),
      )}
      style={isInPipWindow ? undefined : pipDrag.style}
    >
        {/* Video / avatar area — inset, floating inside the panel.
            Uses fixed 4:3 aspect when in the in-page widget, but flexes to
            fill the popup window when in Document PiP mode. */}
        <div
          className={cn(
            // Camera-off → deterministic colored tile (matches ParticipantTile);
            // with video the track covers it, so only neutral bg-muted is needed.
            'relative w-full cursor-pointer overflow-hidden rounded-xl ring-1 ring-border',
            focusedTrack && 'bg-muted',
            isInPipWindow ? 'flex-1 min-h-0' : 'aspect-[4/3]',
          )}
          style={focusedTrack ? undefined : { backgroundColor: focusedTheme.tile }}
          onClick={handleExpand}
        >
          {focusedTrack ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted={focusedIsSelf}
              className={cn('absolute inset-0 w-full h-full object-cover', focusedIsSelf && '-scale-x-100')}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <ParticipantAvatar
                initials={focusedInitials}
                color={focusedTheme.avatar}
                picture={focused?.picture}
                className="h-14 w-14 !rounded-[15px]"
              />
            </div>
          )}

          {/* Bottom-left: name tag — matches ParticipantTile's design in the expanded meeting view */}
          <div className="absolute bottom-2 left-2 flex items-center gap-1 bg-black/60 text-white text-xs px-2 py-1 rounded-md max-w-[70%]">
            {focusedIsSelf
              ? (isMuted && <MicOff className="h-3 w-3 shrink-0" />)
              : (!focused?.audioEnabled && <MicOff className="h-3 w-3 shrink-0" />)
            }
            <span className="truncate">{focusedIsSelf ? t.pipWidget.you : focusedName}</span>
          </div>

          {/* Top-right: hover-revealed quick actions */}
          <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover/pip:opacity-100 transition-opacity duration-150">
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => { e.stopPropagation(); openPopOut(); }}
              title={t.pipWidget.popOut}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 hover:bg-black/75 text-white transition-colors"
            >
              <PictureInPicture2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => { e.stopPropagation(); handleExpand(); }}
              title={t.pipWidget.openMeeting}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 hover:bg-black/75 text-white transition-colors"
            >
              <Maximize className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <audio ref={audioRef} autoPlay />

        {/* Controls bar — same button style as the main CallControlsBar */}
        <div className="flex items-center justify-center gap-2 px-1 pt-2.5 pb-1">
          {/* Mic */}
          <div className={cn('rounded-[14px] ring-1', isMuted ? 'ring-red-400/40' : 'ring-border')}>
            <Button
              variant="secondary"
              size="icon"
              className={cn(
                'h-11 w-11 rounded-[14px] border-0 transition-all',
                isMuted
                  ? 'bg-red-100 hover:bg-red-200 text-red-500 dark:bg-red-500/20 dark:hover:bg-red-500/30 dark:text-red-400'
                  : '[&]:hover:brightness-95 dark:[&]:hover:brightness-110',
              )}
              onClick={toggleMute}
              title={isMuted ? t.pipWidget.turnOnMicrophone : t.pipWidget.turnOffMicrophone}
            >
              {isMuted ? <MicOff className="size-[18px]" /> : <Mic className="size-[18px]" />}
            </Button>
          </div>

          {/* Camera */}
          <div className={cn('relative rounded-[14px] ring-1', isVideoOff ? 'ring-red-400/40' : 'ring-border')}>
            <Button
              variant="secondary"
              size="icon"
              className={cn(
                'h-11 w-11 rounded-[14px] border-0 transition-all',
                isVideoOff
                  ? 'bg-red-100 hover:bg-red-200 text-red-500 dark:bg-red-500/20 dark:hover:bg-red-500/30 dark:text-red-400'
                  : '[&]:hover:brightness-95 dark:[&]:hover:brightness-110',
              )}
              onClick={toggleVideo}
              title={isVideoOff ? t.pipWidget.turnOnCamera : t.pipWidget.turnOffCamera}
            >
              {isVideoOff ? (
                <VideoOff className="size-[19px]" />
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="size-[21px]"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
                  />
                </svg>
              )}
            </Button>
            {isVideoOff && (
              <span className="pointer-events-none absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-amber-400 ring-2 ring-card flex items-center justify-center">
                <span className="text-[8px] font-bold text-amber-900 leading-none">!</span>
              </span>
            )}
          </div>

          {/* Screen share */}
          <div className="rounded-[14px] ring-1 ring-border">
            <Button
              variant={isScreenSharing ? 'default' : 'secondary'}
              size="icon"
              className="h-11 w-11 rounded-[14px] border-0 transition-all [&]:hover:brightness-95 dark:[&]:hover:brightness-110"
              onClick={handleScreenShare}
              title={isScreenSharing ? t.pipWidget.stopSharing : t.pipWidget.shareScreen}
            >
              <MonitorUp className="size-[18px]" />
            </Button>
          </div>

          {/* More */}
          <div className="rounded-[14px] ring-1 ring-border">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon"
                  className="h-11 w-11 rounded-[14px] border-0 transition-all [&]:hover:brightness-95 dark:[&]:hover:brightness-110 data-[state=open]:brightness-95 dark:data-[state=open]:brightness-110"
                  title={t.pipWidget.moreOptions}
                >
                  <MoreVertical className="size-[18px]" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end" sideOffset={6} className="w-48 z-[10000]">
                <DropdownMenuItem onClick={toggleHandRaise}>
                  <Hand className={cn('h-4 w-4 mr-0.5', handRaised && 'text-primary')} />
                  {handRaised ? t.pipWidget.lowerHand : t.pipWidget.raiseHand}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExpand}>
                  <Maximize className="h-4 w-4 mr-0.5" />
                  {t.pipWidget.openMeeting}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleCopyJoiningInfo}>
                  <Copy className="h-4 w-4 mr-0.5" />
                  {t.pipWidget.copyJoiningInfo}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Hangup — same destructive pill + rotated phone icon as the
              maximized meeting's CallControlsBar leave button. */}
          <Button
            variant="destructive"
            size="icon"
            className="h-11 w-14 rounded-[14px] transition-all [&]:hover:brightness-90"
            onClick={handleEnd}
            title={isOrganizer ? t.pipWidget.endMeeting : t.pipWidget.leaveMeeting}
          >
            <Phone className="!h-[19px] !w-[19px] rotate-[135deg] fill-current" />
          </Button>
        </div>

      {/* Hidden duration tracker — exposed for screen readers; not shown in this design */}
      <span className="sr-only">{formatDuration(duration)}</span>
    </div>
  );

  return (
    <>
      {hiddenPipElement}
      {isInPipWindow ? createPortal(widget, pipWindow!.document.body) : widget}
    </>
  );
}
