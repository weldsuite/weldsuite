import { useEffect, useRef } from 'react';
import { Mic, MicOff, VideoIcon, VideoOff } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';

export interface PreviewViewProps {
  meetingTitle?: string;
  meetingType?: 'video' | 'audio';
  previewStream: MediaStream | null;
  previewAudioEnabled: boolean;
  previewVideoEnabled: boolean;
  togglePreviewAudio: () => void;
  togglePreviewVideo: () => void;
  confirmJoinFromPreview: () => void;
  cancelPreview: () => void;
}

export function PreviewView({
  meetingTitle,
  previewStream,
  previewAudioEnabled,
  previewVideoEnabled,
  togglePreviewAudio,
  togglePreviewVideo,
  confirmJoinFromPreview,
  cancelPreview,
}: PreviewViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && previewStream) {
      videoRef.current.srcObject = previewStream;
    }
  }, [previewStream]);

  return (
    <div className="flex-1 flex items-center justify-center bg-background">
      <div className="max-w-lg w-full mx-4 space-y-6">
        <div className="text-center">
          <h2 className="text-xl font-semibold">{meetingTitle || 'Join Meeting'}</h2>
          <p className="text-sm text-muted-foreground mt-1">Check your audio and video before joining</p>
        </div>

        <div className="relative aspect-video bg-muted rounded-xl overflow-hidden">
          {previewVideoEnabled && previewStream ? (
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="w-full h-full object-cover mirror"
              style={{ transform: 'scaleX(-1)' }}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="h-20 w-20 rounded-full bg-primary/10 flex items-center justify-center">
                <VideoOff className="h-8 w-8 text-muted-foreground" />
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-center gap-3">
          <Button
            variant={previewAudioEnabled ? 'outline' : 'destructive'}
            size="icon"
            className="h-12 w-12 rounded-full"
            onClick={togglePreviewAudio}
          >
            {previewAudioEnabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
          </Button>
          <Button
            variant={previewVideoEnabled ? 'outline' : 'destructive'}
            size="icon"
            className="h-12 w-12 rounded-full"
            onClick={togglePreviewVideo}
          >
            {previewVideoEnabled ? <VideoIcon className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
          </Button>
        </div>

        <div className="flex justify-center gap-3">
          <Button variant="outline" onClick={cancelPreview}>
            Cancel
          </Button>
          <Button onClick={confirmJoinFromPreview}>
            Join Meeting
          </Button>
        </div>
      </div>
    </div>
  );
}
