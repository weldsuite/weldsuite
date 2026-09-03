'use client';

/**
 * WeldChat meeting room — Cloudflare RealtimeKit official UI (`RtkMeeting`).
 *
 * Replaces the custom `@weldsuite/weldmeet-ui` MeetingRoomView for stability.
 * Signaling / lifecycle stay in `weldchat-call-context`; this only renders the
 * in-call surface once a meeting client exists.
 */

import { RealtimeKitProvider } from '@cloudflare/realtimekit-react';
import { RtkMeeting } from '@cloudflare/realtimekit-react-ui';
import { useWeldChatCall } from '@/contexts/weldchat-call-context';
import { Button } from '@weldsuite/ui/components/button';
import { Minimize2, PictureInPicture2 } from 'lucide-react';

export function ChatMeetingRoomView() {
  const { meeting, isFullscreen, toggleFullscreen, minimizeToPiP } = useWeldChatCall();

  if (!meeting) return null;

  const chrome = isFullscreen ? (
    <div className="absolute top-3 right-3 z-[60] flex gap-2">
      <Button
        type="button"
        size="icon"
        variant="secondary"
        className="h-9 w-9 rounded-full bg-black/50 text-white hover:bg-black/70"
        onClick={() => toggleFullscreen()}
        aria-label="Exit fullscreen"
      >
        <Minimize2 className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="secondary"
        className="h-9 w-9 rounded-full bg-black/50 text-white hover:bg-black/70"
        onClick={() => minimizeToPiP()}
        aria-label="Minimize to picture-in-picture"
      >
        <PictureInPicture2 className="h-4 w-4" />
      </Button>
    </div>
  ) : null;

  // Context already called meeting.join(); RtkMeeting renders the stable UI kit.
  // Cast bridges nested @cloudflare/realtimekit copies across react / react-ui packages.
  const room = (
    <RealtimeKitProvider value={meeting as never}>
      <div className="relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-black">
        {chrome}
        <RtkMeeting meeting={meeting as never} showSetupScreen={false} />
      </div>
    </RealtimeKitProvider>
  );

  if (isFullscreen) {
    return <div className="fixed inset-0 z-50 flex flex-col bg-background">{room}</div>;
  }

  return <div className="flex min-h-0 flex-1 flex-col">{room}</div>;
}
