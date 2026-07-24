/**
 * Standalone Call Room
 *
 * Opened by the mobile app via expo-web-browser.
 * Does not require Clerk auth — connects directly to Cloudflare RealtimeKit
 * using the `token` URL search param (obtained from the join call API).
 */

import RealtimeKitClient, { type RTKParticipant, type RTKSelf } from '@cloudflare/realtimekit';
import { useEffect, useRef, useState, useCallback } from 'react';
import { Loader2, Mic, MicOff, Video, VideoOff, PhoneOff } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { Button } from '@weldsuite/ui/components/button';

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * Explicitly stop the local camera/mic MediaStreamTracks held by the RTK
 * client. RealtimeKit's `leave()` does not reliably stop the underlying
 * hardware tracks in the browser, so without this the OS camera/mic indicator
 * stays lit after the call ends. Each getter can throw when the corresponding
 * media is disabled, so every read is guarded.
 */
function stopLocalMediaTracks(meeting: RealtimeKitClient | null | undefined) {
  if (!meeting) return;
  const self = meeting.self as unknown as {
    videoTrack?: MediaStreamTrack;
    audioTrack?: MediaStreamTrack;
    rawVideoTrack?: MediaStreamTrack;
    rawAudioTrack?: MediaStreamTrack;
    screenShareTracks?: { video?: MediaStreamTrack; audio?: MediaStreamTrack };
  };
  const stop = (read: () => MediaStreamTrack | undefined) => {
    try {
      read()?.stop();
    } catch {
      /* track unavailable or already stopped */
    }
  };
  stop(() => self?.videoTrack);
  stop(() => self?.audioTrack);
  stop(() => self?.rawVideoTrack);
  stop(() => self?.rawAudioTrack);
  stop(() => self?.screenShareTracks?.video);
  stop(() => self?.screenShareTracks?.audio);
}

function ParticipantTile({ participant, isSelf }: { participant: RTKParticipant | RTKSelf; isSelf?: boolean }) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && participant.videoEnabled && participant.videoTrack) {
      videoRef.current.srcObject = new MediaStream([participant.videoTrack]);
    } else if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, [participant.videoEnabled, participant.videoTrack]);

  const name = participant.name || t.weldchat.callRoom.participant;

  return (
    <div className="relative flex items-center justify-center bg-zinc-900 rounded-xl overflow-hidden aspect-video">
      {participant.videoEnabled && participant.videoTrack ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isSelf}
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="flex flex-col items-center gap-2">
          <div className="h-16 w-16 rounded-full bg-zinc-700 flex items-center justify-center text-white text-2xl font-semibold">
            {name[0]?.toUpperCase() ?? '?'}
          </div>
        </div>
      )}
      <div className="absolute bottom-2 left-2 flex items-center gap-1 bg-black/60 text-white text-xs px-2 py-1 rounded">
        {!participant.audioEnabled && <MicOff className="h-3 w-3" />}
        <span>{isSelf ? t.weldchat.callRoom.you : name}</span>
      </div>
    </div>
  );
}

export default function CallRoomPage() {
  const { t } = useI18n();
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const callType = (params.get('type') ?? 'voice') as 'voice' | 'video';

  const [meeting, setMeeting] = useState<RealtimeKitClient | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'ended' | 'error'>('connecting');
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(callType === 'voice');
  const [duration, setDuration] = useState(0);
  const [, forceUpdate] = useState(0);

  const durationRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!token) {
      setStatus('error');
      return;
    }

    let m: RealtimeKitClient;

    (async () => {
      try {
        m = await RealtimeKitClient.init({
          authToken: token,
          defaults: {
            audio: true,
            video: callType === 'video',
          },
        });

        m.self.on('roomJoined', () => {
          setStatus('connected');
          durationRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
        });

        m.self.on('roomLeft', () => {
          setStatus('ended');
          if (durationRef.current) clearInterval(durationRef.current);
        });

        m.participants.joined.on('participantJoined', () => forceUpdate((n) => n + 1));
        m.participants.joined.on('participantLeft', () => forceUpdate((n) => n + 1));
        m.self.on('audioUpdate', () => forceUpdate((n) => n + 1));
        m.self.on('videoUpdate', () => forceUpdate((n) => n + 1));

        await m.join();
        setMeeting(m);
      } catch {
        setStatus('error');
      }
    })();

    return () => {
      if (durationRef.current) clearInterval(durationRef.current);
      stopLocalMediaTracks(m);
      try { m?.leave(); } catch { /* ignore */ }
    };
  }, [token, callType]);

  const handleLeave = useCallback(async () => {
    if (meeting) {
      // Stop the local hardware tracks first — RTK's leave() does not reliably
      // release the camera/mic, so the device indicator would otherwise stay on.
      stopLocalMediaTracks(meeting);
      try { meeting.leave(); } catch { /* ignore */ }
    }

    // Notify the mobile app and close the browser
    window.close();

    // Fallback: redirect to a closing message if window.close() is blocked
    setStatus('ended');
  }, [meeting]);

  const toggleMute = useCallback(() => {
    if (!meeting) return;
    if (meeting.self.audioEnabled) {
      meeting.self.disableAudio();
      setIsMuted(true);
    } else {
      meeting.self.enableAudio();
      setIsMuted(false);
    }
  }, [meeting]);

  const toggleVideo = useCallback(() => {
    if (!meeting) return;
    if (meeting.self.videoEnabled) {
      meeting.self.disableVideo();
      setIsVideoOff(true);
    } else {
      meeting.self.enableVideo();
      setIsVideoOff(false);
    }
  }, [meeting]);

  if (status === 'error') {
    return (
      <div
        data-testid="call-room-error"
        className="fixed inset-0 flex flex-col items-center justify-center bg-zinc-950 text-white gap-4"
      >
        <PhoneOff className="h-12 w-12 text-red-500" />
        <p className="text-lg font-medium">{t.weldchat.callRoom.unableToJoin}</p>
        <p className="text-sm text-zinc-400">{t.weldchat.callRoom.callLinkExpired}</p>
        <Button
          data-testid="call-room-close"
          variant="ghost"
          onClick={() => window.close()}
          className="mt-4 px-6 py-2 bg-zinc-800 rounded-lg text-sm hover:bg-zinc-700 text-white"
        >
          {t.weldchat.callRoom.close}
        </Button>
      </div>
    );
  }

  if (status === 'ended') {
    return (
      <div
        data-testid="call-room-ended"
        className="fixed inset-0 flex flex-col items-center justify-center bg-zinc-950 text-white gap-4"
      >
        <PhoneOff className="h-12 w-12 text-zinc-500" />
        <p className="text-lg font-medium">{t.weldchat.callRoom.callEnded}</p>
        <p className="text-sm text-zinc-400 font-mono">{formatDuration(duration)}</p>
        <Button
          data-testid="call-room-close"
          variant="ghost"
          onClick={() => window.close()}
          className="mt-4 px-6 py-2 bg-zinc-800 rounded-lg text-sm hover:bg-zinc-700 text-white"
        >
          {t.weldchat.callRoom.close}
        </Button>
      </div>
    );
  }

  if (status === 'connecting' || !meeting) {
    return (
      <div
        data-testid="call-room-connecting"
        className="fixed inset-0 flex flex-col items-center justify-center bg-zinc-950 text-white gap-4"
      >
        <Loader2 className="h-12 w-12 animate-spin text-zinc-400" />
        <p className="text-lg font-medium">{t.weldchat.callRoom.connecting}</p>
      </div>
    );
  }

  const remoteParticipants = meeting.participants.joined.toArray();
  const total = remoteParticipants.length + 1;
  const gridCols =
    total <= 1 ? 'grid-cols-1' :
    total <= 2 ? 'grid-cols-2' :
    'grid-cols-2';

  return (
    <div data-testid="call-room" className="fixed inset-0 flex flex-col bg-zinc-950 text-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <span className="text-sm font-medium">
          {callType === 'video' ? t.weldchat.callRoom.videoCall : t.weldchat.callRoom.voiceCall}
        </span>
        <span className="text-sm text-zinc-400 font-mono">{formatDuration(duration)}</span>
      </div>

      {/* Participant grid */}
      <div className={`flex-1 grid ${gridCols} gap-2 p-4 auto-rows-fr`}>
        <ParticipantTile participant={meeting.self} isSelf />
        {remoteParticipants.map((p) => (
          <ParticipantTile key={p.id} participant={p} />
        ))}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-4 py-6 border-t border-zinc-800">
        <Button
          data-testid="call-room-mute"
          variant="ghost"
          onClick={toggleMute}
          className={`h-12 w-12 rounded-full flex items-center justify-center transition-colors p-0 ${
            isMuted ? 'bg-red-600 hover:bg-red-700' : 'bg-zinc-700 hover:bg-zinc-600'
          }`}
        >
          {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </Button>

        {callType === 'video' && (
          <Button
            data-testid="call-room-video"
            variant="ghost"
            onClick={toggleVideo}
            className={`h-12 w-12 rounded-full flex items-center justify-center transition-colors p-0 ${
              isVideoOff ? 'bg-red-600 hover:bg-red-700' : 'bg-zinc-700 hover:bg-zinc-600'
            }`}
          >
            {isVideoOff ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
          </Button>
        )}

        <Button
          data-testid="call-room-leave"
          variant="ghost"
          onClick={handleLeave}
          className="h-12 w-12 rounded-full flex items-center justify-center bg-red-600 hover:bg-red-700 transition-colors p-0"
        >
          <PhoneOff className="h-5 w-5" />
        </Button>
      </div>
    </div>
  );
}
