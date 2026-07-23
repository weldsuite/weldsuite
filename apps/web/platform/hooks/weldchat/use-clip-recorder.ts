/**
 * WeldChat Clip Recorder Hook
 *
 * Encapsulates MediaRecorder logic for recording audio, video,
 * and screen clips. Handles stream acquisition, recording,
 * blob assembly, and cleanup.
 */

import { useState, useRef, useCallback, useEffect } from 'react';

// ============================================================================
// Types
// ============================================================================

export type ClipMode = 'audio' | 'video' | 'screen';

type RecorderState =
  | 'idle'
  | 'previewing'
  | 'recording'
  | 'recorded'
  | 'uploading'
  | 'sent';

export interface UseClipRecorderReturn {
  state: RecorderState;
  mode: ClipMode;
  stream: MediaStream | null;
  blob: Blob | null;
  duration: number;
  error: string | null;
  audioLevel: number;
  setMode: (mode: ClipMode) => void;
  startPreview: () => Promise<void>;
  startRecording: () => void;
  stopRecording: () => void;
  reset: () => void;
  setState: (state: RecorderState) => void;
}

const MAX_DURATION = 300; // 5 minutes

function getPreferredMimeType(mode: ClipMode): string {
  const types = mode === 'audio'
    ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
    : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];

  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return mode === 'audio' ? 'audio/webm' : 'video/webm';
}

// ============================================================================
// Hook
// ============================================================================

export function useClipRecorder(): UseClipRecorderReturn {
  const [state, setState] = useState<RecorderState>('idle');
  const [mode, setModeState] = useState<ClipMode>('audio');
  const modeRef = useRef<ClipMode>(mode);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositeRafRef = useRef<number>(0);
  const camStreamRef = useRef<MediaStream | null>(null);

  // Cleanup all streams and timers
  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (audioIntervalRef.current) {
      clearInterval(audioIntervalRef.current);
      audioIntervalRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
      analyserRef.current = null;
    }
    if (compositeRafRef.current) {
      cancelAnimationFrame(compositeRafRef.current);
      compositeRafRef.current = 0;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try { recorderRef.current.stop(); } catch {}
    }
    recorderRef.current = null;
    canvasRef.current = null;
    camStreamRef.current = null;
  }, []);

  const stopStream = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      setStream(null);
    }
  }, [stream]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
      // Stop all tracks
      stream?.getTracks().forEach((t) => t.stop());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Audio level monitoring
  const startAudioMonitoring = useCallback((mediaStream: MediaStream) => {
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      const data = new Uint8Array(analyser.frequencyBinCount);
      ctx.createMediaStreamSource(mediaStream).connect(analyser);
      ctx.resume();

      audioContextRef.current = ctx;
      analyserRef.current = analyser;

      audioIntervalRef.current = setInterval(() => {
        if (ctx.state === 'running') {
          analyser.getByteFrequencyData(data);
          const avg = data.reduce((s, v) => s + v, 0) / data.length;
          setAudioLevel(Math.min(avg / 128, 1)); // Normalize to 0–1
        }
      }, 50);
    } catch {
      // AudioContext unavailable
    }
  }, []);

  const setMode = useCallback((newMode: ClipMode) => {
    if (state !== 'idle' && state !== 'previewing') return;
    // Stop existing stream when switching modes
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      setStream(null);
    }
    cleanup();
    modeRef.current = newMode;
    setModeState(newMode);
    setState('idle');
    setError(null);
  }, [state, stream, cleanup]);

  const startPreview = useCallback(async () => {
    setError(null);
    const currentMode = modeRef.current;

    try {
      let mediaStream: MediaStream;

      if (currentMode === 'audio') {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } else if (currentMode === 'video') {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        });
      } else {
        mediaStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: true,
        });
        // Handle user stopping screen share via browser UI
        mediaStream.getVideoTracks()[0]?.addEventListener('ended', () => {
          if (recorderRef.current && recorderRef.current.state === 'recording') {
            recorderRef.current.stop();
          }
        });
      }

      setStream(mediaStream);
      setState('previewing');
      startAudioMonitoring(mediaStream);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to access media device';
      if (msg.includes('Permission denied') || msg.includes('NotAllowedError')) {
        setError('Permission denied. Please allow access to your microphone/camera.');
      } else {
        setError(msg);
      }
    }
  }, [mode, startAudioMonitoring]);

  const beginRecording = useCallback((recordStream: MediaStream) => {
    const mimeType = getPreferredMimeType(modeRef.current);
    const recorder = new MediaRecorder(recordStream, { mimeType });

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunksRef.current.push(e.data);
      }
    };

    recorder.onstop = () => {
      if (compositeRafRef.current) {
        cancelAnimationFrame(compositeRafRef.current);
        compositeRafRef.current = 0;
      }
      const finalBlob = new Blob(chunksRef.current, { type: mimeType });
      setBlob(finalBlob);
      setState('recorded');

      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    recorder.start(1000);
    recorderRef.current = recorder;
    startTimeRef.current = Date.now();
    setState('recording');

    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      setDuration(elapsed);

      if (elapsed >= MAX_DURATION) {
        if (recorderRef.current && recorderRef.current.state === 'recording') {
          recorderRef.current.stop();
        }
      }
    }, 200);
  }, []);

  const startRecording = useCallback((pipCameraStream?: MediaStream | null) => {
    if (!stream || state !== 'previewing') return;

    chunksRef.current = [];
    setDuration(0);
    setBlob(null);

    // Composite screen + camera PiP onto a canvas
    if (modeRef.current === 'screen' && pipCameraStream && pipCameraStream.getVideoTracks().length > 0) {
      camStreamRef.current = pipCameraStream;
      const screenTrack = stream.getVideoTracks()[0];
      const screenSettings = screenTrack?.getSettings();
      const w = screenSettings?.width || 1920;
      const h = screenSettings?.height || 1080;

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvasRef.current = canvas;
      const ctx = canvas.getContext('2d')!;

      const screenVideo = document.createElement('video');
      screenVideo.srcObject = stream;
      screenVideo.muted = true;
      screenVideo.playsInline = true;

      const camVideo = document.createElement('video');
      camVideo.srcObject = pipCameraStream;
      camVideo.muted = true;
      camVideo.playsInline = true;

      const pipW = Math.round(w * 0.18);
      const pipH = Math.round(pipW * 0.75);
      const pipMargin = Math.round(w * 0.02);

      const drawFrame = () => {
        if (screenVideo.readyState >= 2) {
          ctx.drawImage(screenVideo, 0, 0, w, h);
        }
        const camTrack = pipCameraStream.getVideoTracks()[0];
        if (camTrack && camTrack.enabled && camTrack.readyState === 'live' && camVideo.readyState >= 2) {
          const px = w - pipW - pipMargin;
          const py = h - pipH - pipMargin;
          const r = 12;
          ctx.save();
          ctx.beginPath();
          if (ctx.roundRect) {
            ctx.roundRect(px, py, pipW, pipH, r);
          } else {
            // Fallback for browsers without roundRect
            ctx.moveTo(px + r, py);
            ctx.lineTo(px + pipW - r, py);
            ctx.quadraticCurveTo(px + pipW, py, px + pipW, py + r);
            ctx.lineTo(px + pipW, py + pipH - r);
            ctx.quadraticCurveTo(px + pipW, py + pipH, px + pipW - r, py + pipH);
            ctx.lineTo(px + r, py + pipH);
            ctx.quadraticCurveTo(px, py + pipH, px, py + pipH - r);
            ctx.lineTo(px, py + r);
            ctx.quadraticCurveTo(px, py, px + r, py);
            ctx.closePath();
          }
          ctx.clip();
          ctx.drawImage(camVideo, px, py, pipW, pipH);
          ctx.restore();
        }
        compositeRafRef.current = requestAnimationFrame(drawFrame);
      };

      // Wait for both videos to be playing, then start
      Promise.all([
        screenVideo.play(),
        camVideo.play(),
      ]).then(() => {
        compositeRafRef.current = requestAnimationFrame(drawFrame);
        const canvasStream = canvas.captureStream(30);
        stream.getAudioTracks().forEach((t) => canvasStream.addTrack(t));
        beginRecording(canvasStream);
      }).catch(() => {
        // Fallback: record screen only without camera
        beginRecording(stream);
      });
    } else {
      beginRecording(stream);
    }
  }, [stream, state, beginRecording]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      // Capture final duration before stopping
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      setDuration(elapsed);
      recorderRef.current.stop();
    }
  }, []);

  const reset = useCallback(() => {
    cleanup();
    stopStream();
    setBlob(null);
    setDuration(0);
    setError(null);
    setAudioLevel(0);
    chunksRef.current = [];
    setState('idle');
  }, [cleanup, stopStream]);

  return {
    state,
    mode,
    stream,
    blob,
    duration,
    error,
    audioLevel,
    setMode,
    startPreview,
    startRecording,
    stopRecording,
    reset,
    setState,
  };
}
