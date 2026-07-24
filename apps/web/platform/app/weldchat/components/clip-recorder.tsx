/**
 * WeldChat Clip Recorder
 *
 * Dialog for recording video or screen clips.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Monitor, Video, VideoOff, Square, RotateCcw, Loader2, Mic, MicOff, MoreVertical, Send, ChevronUp } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Button } from '@weldsuite/ui/components/button';
import { useClipRecorder, type ClipMode } from '@/hooks/weldchat/use-clip-recorder';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { ChatClipAttachment } from '@weldsuite/db/schema';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

interface ClipRecorderProps {
  open: boolean;
  onClose: () => void;
  onClipReady: (attachment: ChatClipAttachment) => void;
  initialMode?: ClipMode;
}

/** Flat (non-`{ data }`-wrapped) response from `/storage/generate-upload-url`. */
interface GenerateUploadUrlResponse {
  success?: boolean;
  uploadUrl: string;
  uploadToken: string;
  fileKey: string;
}

/** Flat (non-`{ data }`-wrapped) response from `/storage/confirm-upload`. */
interface ConfirmUploadResponse {
  success?: boolean;
  file?: {
    id: string;
    fileName: string;
    fileKey: string;
    fileSize: number;
    mimeType: string;
    url: string;
    isPublic?: boolean;
  };
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function ClipRecorder({ open, onClose, onClipReady, initialMode }: ClipRecorderProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const recorder = useClipRecorder();

  useEffect(() => {
    if (open && initialMode) {
      recorder.setMode(initialMode);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialMode]);

  const { getClient } = useAppApiClient();
  const videoPreviewRef = useRef<HTMLVideoElement>(null);
  const videoPlaybackRef = useRef<HTMLVideoElement>(null);
  const camPipRef = useRef<HTMLVideoElement>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [camStream, setCamStream] = useState<MediaStream | null>(null);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [activeAudioId, setActiveAudioId] = useState('');
  const [activeVideoId, setActiveVideoId] = useState('');

  useEffect(() => {
    if (!recorder.stream) return;
    navigator.mediaDevices.enumerateDevices().then(devices => {
      setAudioDevices(devices.filter(d => d.kind === 'audioinput'));
      setVideoDevices(devices.filter(d => d.kind === 'videoinput'));
      const audioTrack = recorder.stream?.getAudioTracks()[0];
      const videoTrack = recorder.stream?.getVideoTracks()[0];
      if (audioTrack) setActiveAudioId(audioTrack.getSettings().deviceId ?? '');
      if (videoTrack) setActiveVideoId(videoTrack.getSettings().deviceId ?? '');
    }).catch(() => {});
  }, [recorder.stream]);

  const switchAudioDevice = useCallback(async (deviceId: string) => {
    if (!recorder.stream) return;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
      const oldTrack = recorder.stream.getAudioTracks()[0];
      const newTrack = newStream.getAudioTracks()[0];
      if (oldTrack) recorder.stream.removeTrack(oldTrack);
      recorder.stream.addTrack(newTrack);
      oldTrack?.stop();
      setActiveAudioId(deviceId);
    } catch {
      // Device switch failed (denied permission, device unplugged, …) — keep the previous device active.
    }
  }, [recorder.stream]);

  const switchVideoDevice = useCallback(async (deviceId: string) => {
    const stream = recorder.mode === 'screen' ? camStream : recorder.stream;
    if (!stream) return;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      const oldTrack = stream.getVideoTracks()[0];
      const newTrack = newStream.getVideoTracks()[0];
      if (oldTrack) stream.removeTrack(oldTrack);
      stream.addTrack(newTrack);
      oldTrack?.stop();
      setActiveVideoId(deviceId);
      if (recorder.mode === 'screen' && camPipRef.current) {
        camPipRef.current.srcObject = stream;
      } else if (videoPreviewRef.current) {
        videoPreviewRef.current.srcObject = stream;
      }
    } catch {
      // Device switch failed (denied permission, device unplugged, …) — keep the previous device active.
    }
  }, [recorder.stream, recorder.mode, camStream]);

  const toggleCamera = useCallback(() => {
    if (recorder.mode === 'screen' && camStream) {
      camStream.getVideoTracks().forEach(t => { t.enabled = !t.enabled; });
    } else if (recorder.stream) {
      recorder.stream.getVideoTracks().forEach(t => { t.enabled = !t.enabled; });
    }
    setCameraOn(prev => !prev);
  }, [recorder.stream, recorder.mode, camStream]);

  const toggleMic = useCallback(() => {
    if (recorder.stream) {
      recorder.stream.getAudioTracks().forEach(t => { t.enabled = !t.enabled; });
    }
    setMicOn(prev => !prev);
  }, [recorder.stream]);

  useEffect(() => {
    if (recorder.mode === 'screen' && recorder.state !== 'idle' && recorder.state !== 'recorded' && recorder.state !== 'uploading' && recorder.state !== 'sent') {
      navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' } })
        .then(stream => {
          setCamStream(stream);
          if (camPipRef.current) {
            camPipRef.current.srcObject = stream;
          }
        })
        .catch(() => {});
    } else {
      if (camStream) {
        camStream.getTracks().forEach(t => t.stop());
        setCamStream(null);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.mode, recorder.state]);

  useEffect(() => {
    if (camPipRef.current && camStream) {
      camPipRef.current.srcObject = camStream;
    }
  }, [camStream]);

  useEffect(() => {
    if (videoPreviewRef.current && recorder.stream && (recorder.mode === 'video' || recorder.mode === 'screen')) {
      videoPreviewRef.current.srcObject = recorder.stream;
    }
  }, [recorder.stream, recorder.mode]);

  useEffect(() => {
    if (recorder.blob) {
      const url = URL.createObjectURL(recorder.blob);
      setBlobUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setBlobUrl(null);
    }
  }, [recorder.blob]);

  useEffect(() => {
    if (open && recorder.state === 'idle') {
      recorder.startPreview();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recorder.state]);

  const handleClose = useCallback(() => {
    recorder.reset();
    setCameraOn(true);
    setMicOn(true);
    if (camStream) {
      camStream.getTracks().forEach(t => t.stop());
      setCamStream(null);
    }
    onClose();
  }, [recorder, onClose, camStream]);

  const handleSend = useCallback(async () => {
    if (!recorder.blob) return;
    recorder.setState('uploading');

    try {
      const client = await getClient();
      const ext = recorder.blob.type.includes('mp4') ? 'mp4' : 'webm';
      const fileName = `clip-${Date.now()}.${ext}`;

      const urlRes = await client.post<GenerateUploadUrlResponse>('/storage/generate-upload-url', {
        fileName,
        fileSize: recorder.blob.size,
        contentType: recorder.blob.type,
      });

      const { uploadUrl, uploadToken, fileKey } = urlRes;

      await fetch(uploadUrl, {
        method: 'PUT',
        body: recorder.blob,
        headers: { 'Content-Type': recorder.blob.type },
      });

      const confirmRes = await client.post<ConfirmUploadResponse>('/storage/confirm-upload', {
        uploadToken,
        fileKey,
      });

      const fileData = confirmRes?.file;

      const clipAttachment: ChatClipAttachment = {
        id: fileData?.id ?? fileKey,
        fileName,
        fileSize: recorder.blob.size,
        mimeType: recorder.blob.type,
        url: fileData?.url ?? '',
        clipType: recorder.mode,
        durationSeconds: recorder.duration,
      };

      recorder.setState('sent');
      onClipReady(clipAttachment);
      handleClose();
    } catch (err) {
      console.error('Clip upload failed:', err);
      recorder.setState('recorded');
    }
  }, [recorder, getClient, onClipReady, handleClose]);

  const isRecording = recorder.state === 'recording';
  const isRecorded = recorder.state === 'recorded';
  const isUploading = recorder.state === 'uploading';
  const showPreview = recorder.state === 'previewing' || isRecording;
  const showPlayback = isRecorded || isUploading;

  if (!open) return null;

  const handleReRecord = () => {
    recorder.reset();
    setCameraOn(true);
    setMicOn(true);
    setTimeout(() => recorder.startPreview(), 100);
  };

  const handleToggleScreen = () => {
    if (isRecorded) {
      recorder.reset();
      setTimeout(() => recorder.startPreview(), 100);
    }
    recorder.setMode(recorder.mode === 'screen' ? 'video' : 'screen');
  };

  // Centered modal popup with the SAME layout vocabulary as the WeldMeet PiP
  // minimized meeting (inset rounded video tile, `h-9 w-9 rounded-[10px]`
  // controls in `ring-1` wrappers, red tinting for off-states, destructive
  // primary action). Stays a true popup — overlay + centered card — only the
  // contents follow the PiP widget's design language.
  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 z-50 bg-black/50 animate-in fade-in-0 duration-200"
        onClick={handleClose}
      />

      {/* Popup */}
      <div
        className={cn(
          'group/clip fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-full max-w-[680px] bg-card p-2 rounded-[14px] shadow-2xl ring-1 ring-border',
          'animate-in fade-in-0 zoom-in-95 duration-200',
        )}
      >
      {/* Video / playback area — inset, floating inside the panel */}
      <div className="relative w-full aspect-video overflow-hidden rounded-[10px] bg-muted">
        {showPreview && (
          <video
            ref={videoPreviewRef}
            autoPlay
            muted
            playsInline
            className={cn(
              'absolute inset-0 w-full h-full object-cover',
              recorder.mode === 'video' && 'scale-x-[-1]',
            )}
          />
        )}

        {showPlayback && blobUrl && (
          <video
            ref={videoPlaybackRef}
            src={blobUrl}
            controls
            playsInline
            className={cn(
              'absolute inset-0 w-full h-full object-cover',
              recorder.mode === 'video' && 'scale-x-[-1]',
            )}
          />
        )}

        {recorder.state === 'idle' && !recorder.error && (
          <div className="absolute inset-0 flex items-center justify-center text-white/60 text-xs">
            {st('sweep.weldchat.clipRecorder.preparingCamera')}
          </div>
        )}

        {recorder.error && (
          <div className="absolute inset-0 flex items-center justify-center text-red-400 text-xs px-4 text-center">
            {recorder.error}
          </div>
        )}

        {/* Bottom-left timer / recording chip — matches PiP name tag */}
        {(isRecording || isRecorded) && (
          <div className="absolute bottom-2 left-2 flex items-center gap-1 bg-black/60 text-white text-xs px-2 py-1 rounded-md">
            {isRecording && <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shrink-0" />}
            <span
              className={cn(
                'font-mono tabular-nums',
                isRecording && recorder.duration >= 270 && 'text-yellow-400',
              )}
            >
              {formatDuration(recorder.duration)}
            </span>
          </div>
        )}

        {/* Camera PiP (when sharing screen) — matches PiP-in-PiP placement */}
        {recorder.mode === 'screen' && camStream && cameraOn && (showPreview || showPlayback) && (
          <div className="absolute bottom-2 right-2 w-[80px] aspect-[4/3] rounded-md overflow-hidden ring-1 ring-white/20 shadow">
            <video
              ref={camPipRef}
              autoPlay
              muted
              playsInline
              className="w-full h-full object-cover scale-x-[-1]"
            />
          </div>
        )}
      </div>

      {/* Controls bar — same button vocabulary as the maximized meeting's
          CallControlsBar: paired square + chevron in a single ring-wrapped
          pill, h-12 w-12 main + h-12 w-8 chevron, chevron rotates 180° while
          the dropdown is open. Device controls left, primary action right. */}
      <div className="flex items-center justify-between gap-3 pt-3 pb-1 px-1">
        <div className="flex items-center gap-3">
        {/* Mic + device chooser */}
        <div className={cn('flex items-center rounded-[10px] overflow-hidden ring-1', !micOn ? 'ring-red-400/40' : 'ring-border')}>
          <Button
            variant="secondary"
            size="icon"
            className={cn(
              'h-9 w-9 rounded-none rounded-l-[10px] border-0 transition-all',
              !micOn
                ? 'bg-red-100 hover:bg-red-200 text-red-500 dark:bg-red-500/20 dark:hover:bg-red-500/30 dark:text-red-400'
                : '[&]:hover:brightness-95 dark:[&]:hover:brightness-110',
            )}
            onClick={toggleMic}
            title={micOn ? st('sweep.weldchat.clipRecorder.turnOffMicrophone') : st('sweep.weldchat.clipRecorder.turnOnMicrophone')}
          >
            {micOn ? <Mic className="!h-4 !w-4" /> : <MicOff className="!h-4 !w-4" />}
          </Button>
          {audioDevices.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon"
                  className={cn(
                    'group/arrow h-9 w-6 rounded-none rounded-r-[10px] border-0 border-l border-border/30 px-0 flex items-center justify-center transition-colors',
                    !micOn
                      ? 'bg-red-100 hover:bg-red-200 text-red-500 dark:bg-red-500/20 dark:hover:bg-red-500/30 dark:text-red-400 border-red-400/20 data-[state=open]:bg-red-200 dark:data-[state=open]:bg-red-500/30'
                      : '[&]:hover:brightness-95 dark:[&]:hover:brightness-110 data-[state=open]:brightness-95 dark:data-[state=open]:brightness-110',
                  )}
                  title={st('sweep.weldchat.clipRecorder.microphoneOptions')}
                >
                  <ChevronUp className="h-4 w-4 transition-transform duration-200 group-data-[state=open]/arrow:rotate-180" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" sideOffset={7} className="w-64">
                <DropdownMenuRadioGroup value={activeAudioId} onValueChange={switchAudioDevice}>
                  {audioDevices.map(d => (
                    <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId} className="truncate">
                      <span className="truncate">{d.label || `${st('sweep.weldchat.clipRecorder.microphoneLabel')} ${d.deviceId.slice(0, 8)}`}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* Camera + device chooser */}
        <div className={cn('flex items-center rounded-[10px] overflow-hidden ring-1', !cameraOn ? 'ring-red-400/40' : 'ring-border')}>
          <Button
            variant="secondary"
            size="icon"
            className={cn(
              'h-9 w-9 rounded-none rounded-l-[10px] border-0 transition-all',
              !cameraOn
                ? 'bg-red-100 hover:bg-red-200 text-red-500 dark:bg-red-500/20 dark:hover:bg-red-500/30 dark:text-red-400'
                : '[&]:hover:brightness-95 dark:[&]:hover:brightness-110',
            )}
            onClick={toggleCamera}
            title={cameraOn ? st('sweep.weldchat.clipRecorder.turnOffCamera') : st('sweep.weldchat.clipRecorder.turnOnCamera')}
          >
            {cameraOn ? <Video className="!h-4 !w-4" /> : <VideoOff className="!h-4 !w-4" />}
          </Button>
          {videoDevices.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon"
                  className={cn(
                    'group/arrow h-9 w-6 rounded-none rounded-r-[10px] border-0 border-l border-border/30 px-0 flex items-center justify-center transition-colors',
                    !cameraOn
                      ? 'bg-red-100 hover:bg-red-200 text-red-500 dark:bg-red-500/20 dark:hover:bg-red-500/30 dark:text-red-400 border-red-400/20 data-[state=open]:bg-red-200 dark:data-[state=open]:bg-red-500/30'
                      : '[&]:hover:brightness-95 dark:[&]:hover:brightness-110 data-[state=open]:brightness-95 dark:data-[state=open]:brightness-110',
                  )}
                  title={st('sweep.weldchat.clipRecorder.cameraOptions')}
                >
                  <ChevronUp className="h-4 w-4 transition-transform duration-200 group-data-[state=open]/arrow:rotate-180" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" sideOffset={7} className="w-64">
                <DropdownMenuRadioGroup value={activeVideoId} onValueChange={switchVideoDevice}>
                  {videoDevices.map(d => (
                    <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId} className="truncate">
                      <span className="truncate">{d.label || `${st('sweep.weldchat.clipRecorder.cameraLabel')} ${d.deviceId.slice(0, 8)}`}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* Screen share toggle */}
        <div className="rounded-[10px] overflow-hidden ring-1 ring-border">
          <Button
            variant={recorder.mode === 'screen' ? 'default' : 'secondary'}
            size="icon"
            className="h-9 w-9 rounded-[10px] border-0 transition-all [&]:hover:brightness-95 dark:[&]:hover:brightness-110"
            onClick={handleToggleScreen}
            disabled={isRecording}
            title={recorder.mode === 'screen' ? st('sweep.weldchat.clipRecorder.switchToCamera') : st('sweep.weldchat.clipRecorder.shareScreen')}
          >
            <Monitor className="!h-4 !w-4" />
          </Button>
        </div>

        {/* More — re-record / extras */}
        {isRecorded && (
          <div className="rounded-[10px] overflow-hidden ring-1 ring-border">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon"
                  className="h-9 w-9 rounded-[10px] border-0 transition-all [&]:hover:brightness-95 dark:[&]:hover:brightness-110 data-[state=open]:brightness-95 dark:data-[state=open]:brightness-110"
                  title={st('sweep.weldchat.clipRecorder.moreOptions')}
                >
                  <MoreVertical className="!h-4 !w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" sideOffset={7} className="w-56">
                <DropdownMenuItem onClick={handleReRecord}>
                  <RotateCcw className="h-4 w-4 mr-0.5" />
                  {st('sweep.weldchat.clipRecorder.reRecord')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        </div>

        {/* Primary action — Record / Stop / Send / Retry */}
        <div className="flex items-center gap-2">
        {!isUploading && (
          <Button variant="outline" onClick={handleClose}>
            {t.weldchat.clipRecorder.cancel}
          </Button>
        )}
        {recorder.state === 'previewing' && (
          <Button onClick={() => recorder.startRecording(camStream)} title={t.weldchat.clipRecorder.record}>
            {t.weldchat.clipRecorder.record}
          </Button>
        )}

        {isRecording && (
          <Button
            variant="destructive"
            size="icon"
            className="h-9 w-9 rounded-[10px] transition-all [&]:hover:brightness-90"
            onClick={recorder.stopRecording}
            title={t.weldchat.clipRecorder.stop}
          >
            <Square className="!h-3.5 !w-3.5 fill-current" />
          </Button>
        )}

        {isRecorded && !isUploading && (
          <Button
            size="icon"
            className="h-9 w-9 rounded-[10px] transition-all [&]:hover:brightness-95 dark:[&]:hover:brightness-110"
            onClick={handleSend}
            title={t.weldchat.clipRecorder.send}
          >
            <Send className="!h-4 !w-4" />
          </Button>
        )}

        {isUploading && (
          <Button
            disabled
            size="icon"
            className="h-9 w-9 rounded-[10px]"
            title={t.weldchat.clipRecorder.uploading}
          >
            <Loader2 className="!h-4 !w-4 animate-spin" />
          </Button>
        )}

        {recorder.state === 'idle' && recorder.error && (
          <Button
            variant="secondary"
            size="icon"
            className="h-9 w-9 rounded-[10px] transition-all [&]:hover:brightness-95"
            onClick={recorder.startPreview}
            title={t.weldchat.clipRecorder.retry}
          >
            <RotateCcw className="!h-4 !w-4" />
          </Button>
        )}
        </div>
      </div>
      </div>
    </>
  );
}
