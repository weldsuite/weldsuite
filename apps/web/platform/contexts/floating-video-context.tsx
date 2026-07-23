
import { createContext, useContext, useState, useRef, useCallback, useEffect, type ReactNode } from 'react';

interface FloatingVideoState {
  src: string;
  currentTime: number;
  isPlaying: boolean;
  callSubject: string;
  callId: string;
}

interface FloatingVideoContextType {
  floatingVideo: FloatingVideoState | null;
  minimize: (state: FloatingVideoState) => void;
  restore: () => FloatingVideoState | null;
  dismiss: () => void;
  maximizeBack: () => void;
  togglePlayPause: () => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  smoothTime: number;
  duration: number;
  isPlaying: boolean;
  pendingRestore: FloatingVideoState | null;
  consumePendingRestore: () => void;
}

const FloatingVideoContext = createContext<FloatingVideoContextType | null>(null);

export function useFloatingVideo() {
  return useContext(FloatingVideoContext);
}

export function FloatingVideoProvider({ children }: { children: ReactNode }) {
  const [floatingVideo, setFloatingVideo] = useState<FloatingVideoState | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number>(0);
  const [smoothTime, setSmoothTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<FloatingVideoState | null>(null);

  const minimize = useCallback((state: FloatingVideoState) => {
    setFloatingVideo(state);
    setSmoothTime(state.currentTime);
    setIsPlaying(state.isPlaying);
  }, []);

  const restore = useCallback(() => {
    const state = floatingVideo;
    if (state && videoRef.current) {
      const updated = {
        ...state,
        currentTime: videoRef.current.currentTime,
        isPlaying: !videoRef.current.paused,
      };
      setFloatingVideo(null);
      setIsPlaying(false);
      return updated;
    }
    setFloatingVideo(null);
    return state;
  }, [floatingVideo]);

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
    setFloatingVideo(null);
    setIsPlaying(false);
  }, []);

  const maximizeBack = useCallback(() => {
    if (floatingVideo && videoRef.current) {
      setPendingRestore({
        ...floatingVideo,
        currentTime: videoRef.current.currentTime,
        isPlaying: !videoRef.current.paused,
      });
    } else if (floatingVideo) {
      setPendingRestore(floatingVideo);
    }
    // Dismiss floating video immediately
    if (videoRef.current) videoRef.current.pause();
    setFloatingVideo(null);
    setIsPlaying(false);
  }, [floatingVideo]);

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
    if (!floatingVideo) return;

    let cancelled = false;
    let cleanupFn: (() => void) | null = null;

    const setup = () => {
      if (cancelled) return;
      const video = videoRef.current;
      if (!video) {
        // Video not yet rendered, retry next frame
        requestAnimationFrame(setup);
        return;
      }

      const onLoadedMetadata = () => {
        setDuration(video.duration);
        video.currentTime = floatingVideo.currentTime;
        if (floatingVideo.isPlaying) {
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

      // If video is already loaded (e.g., same src)
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
  }, [floatingVideo]);

  return (
    <FloatingVideoContext.Provider value={{ floatingVideo, minimize, restore, dismiss, maximizeBack, togglePlayPause, videoRef, smoothTime, duration, isPlaying, pendingRestore, consumePendingRestore }}>
      {children}
    </FloatingVideoContext.Provider>
  );
}
