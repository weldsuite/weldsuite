
import { createContext, useContext, useState, useRef, useCallback, useEffect, type ReactNode } from 'react';

interface FloatingCallSegment {
  id: string;
  speaker: string;
  speakerName?: string;
  text: string;
  start: number;
  end: number;
}

export interface FloatingCallState {
  callId: string;
  callSubject: string;
  callDate: string;
  callDuration: number;
  videoSrc: string;
  currentTime: number;
  isPlaying: boolean;
  segments: FloatingCallSegment[];
  attendees?: string[];
  platform?: string;
  meetingUrl?: string;
}

interface FloatingCallContextType {
  floatingCall: FloatingCallState | null;
  minimize: (state: FloatingCallState) => void;
  dismiss: () => void;
  maximizeBack: () => void;
  togglePlayPause: () => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  smoothTime: number;
  duration: number;
  isPlaying: boolean;
  pendingRestore: FloatingCallState | null;
  consumePendingRestore: () => void;
}

const FloatingCallContext = createContext<FloatingCallContextType | null>(null);

export function useFloatingCall() {
  return useContext(FloatingCallContext);
}

export function FloatingCallProvider({ children }: { children: ReactNode }) {
  const [floatingCall, setFloatingCall] = useState<FloatingCallState | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number>(0);
  const [smoothTime, setSmoothTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<FloatingCallState | null>(null);

  const minimize = useCallback((state: FloatingCallState) => {
    setFloatingCall(state);
    setSmoothTime(state.currentTime);
    setIsPlaying(state.isPlaying);
  }, []);

  const togglePlayPause = useCallback(() => {
    if (videoRef.current) {
      if (videoRef.current.paused) {
        videoRef.current.play().catch(() => {});
        setIsPlaying(true);
      } else {
        videoRef.current.pause();
        setIsPlaying(false);
      }
    }
  }, []);

  const dismiss = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.pause();
    }
    setFloatingCall(null);
    setIsPlaying(false);
  }, []);

  const maximizeBack = useCallback(() => {
    if (floatingCall && videoRef.current) {
      setPendingRestore({
        ...floatingCall,
        currentTime: videoRef.current.currentTime,
        isPlaying: !videoRef.current.paused,
      });
    } else if (floatingCall) {
      setPendingRestore(floatingCall);
    }
    if (videoRef.current) videoRef.current.pause();
    setFloatingCall(null);
    setIsPlaying(false);
  }, [floatingCall]);

  const consumePendingRestore = useCallback(() => {
    setPendingRestore(null);
  }, []);

  // Smooth time tracking
  useEffect(() => {
    const tick = () => {
      if (videoRef.current) {
        setSmoothTime(videoRef.current.currentTime);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    if (isPlaying) {
      rafRef.current = requestAnimationFrame(tick);
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying]);

  // Video event listeners and auto-play on minimize
  useEffect(() => {
    if (!floatingCall) return;

    let cancelled = false;
    let cleanupFn: (() => void) | null = null;

    const setup = () => {
      if (cancelled) return;
      const video = videoRef.current;
      if (!video) {
        requestAnimationFrame(setup);
        return;
      }

      const onLoadedMetadata = () => {
        setDuration(video.duration);
        video.currentTime = floatingCall.currentTime;
        if (floatingCall.isPlaying) {
          video.play().catch(() => {});
        }
      };
      const onPlay = () => setIsPlaying(true);
      const onPause = () => setIsPlaying(false);
      const onTimeUpdate = () => setSmoothTime(video.currentTime);

      video.addEventListener('loadedmetadata', onLoadedMetadata);
      video.addEventListener('play', onPlay);
      video.addEventListener('pause', onPause);
      video.addEventListener('timeupdate', onTimeUpdate);

      if (video.readyState >= 1) {
        onLoadedMetadata();
      }

      cleanupFn = () => {
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
        video.removeEventListener('play', onPlay);
        video.removeEventListener('pause', onPause);
        video.removeEventListener('timeupdate', onTimeUpdate);
      };
    };

    setup();

    return () => {
      cancelled = true;
      cleanupFn?.();
    };
  }, [floatingCall]);

  return (
    <FloatingCallContext.Provider value={{ floatingCall, minimize, dismiss, maximizeBack, togglePlayPause, videoRef, smoothTime, duration, isPlaying, pendingRestore, consumePendingRestore }}>
      {children}
    </FloatingCallContext.Provider>
  );
}
