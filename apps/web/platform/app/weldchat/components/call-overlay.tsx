/**
 * WeldChat in-call views.
 *
 * Status → view routing for inline / fullscreen wrappers. The room itself is
 * Cloudflare RealtimeKit's official `RtkMeeting` (via `chat-meeting-room.tsx`).
 *
 * Exports consumed elsewhere:
 *   - InlineCallView  → channel / DM / group-DM conversation pages (inline)
 *   - CallOverlay     → app-shell (global, fullscreen)
 *   - SwitchCallDialog → app-shell (confirm leaving a call to start another)
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ConnectingView } from '@weldsuite/weldmeet-ui';
import { useWeldChatCall, useWeldChatCallOptional } from '@/contexts/weldchat-call-context';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@weldsuite/ui/components/dialog';
import { getTranslations } from '@/lib/i18n';
import { ChatMeetingRoomView } from './chat-meeting-room';

// ============================================================================
// Inline view — rendered within the conversation content area
// ============================================================================

export function InlineCallView() {
  const { status, isFullscreen, isPiP, meeting } = useWeldChatCall();

  // Fullscreen is owned by <CallOverlay/>; PiP by <PiPCallWidget/>.
  if (status === 'idle' || status === 'ended' || isFullscreen || isPiP) return null;

  // No pre-join preview — a brief connecting spinner, then straight into the room.
  if (status === 'ringing-outgoing' || status === 'connecting' || !meeting) {
    return (
      <div className="flex-1 flex min-h-0">
        <ConnectingView />
      </div>
    );
  }

  return <ChatMeetingRoomView />;
}

// ============================================================================
// Fullscreen overlay — globally mounted in the app shell
// ============================================================================

export function CallOverlay() {
  // Lazy-loaded + globally mounted in the shell, so an HMR re-import can
  // transiently see a null context while the provider holds a stale instance.
  // Render nothing instead of crashing the shell (see PiPCallWidget).
  const ctx = useWeldChatCallOptional();
  if (!ctx) return null;
  return <CallOverlayInner />;
}

function CallOverlayInner() {
  const { status, isFullscreen, meeting } = useWeldChatCall();

  if (status === 'idle' || status === 'ended') return null;
  if (!isFullscreen) return null;

  if (status === 'ringing-outgoing' || status === 'connecting' || !meeting) {
    return (
      <div className="fixed inset-0 z-50 flex bg-background">
        <ConnectingView />
      </div>
    );
  }

  return <ChatMeetingRoomView />;
}

// ============================================================================
// Switch-call confirmation dialog
// ============================================================================

export function SwitchCallDialog() {
  // Same null-context guard as CallOverlay (lazy + globally mounted).
  const ctx = useWeldChatCallOptional();
  if (!ctx) return null;
  return <SwitchCallDialogInner />;
}

function SwitchCallDialogInner() {
  const t = getTranslations('weldchat');
  const { pendingCall, confirmSwitchCall, cancelSwitchCall } = useWeldChatCall();
  const [switching, setSwitching] = useState(false);

  const handleConfirm = async () => {
    setSwitching(true);
    try {
      await confirmSwitchCall();
    } finally {
      setSwitching(false);
    }
  };

  return (
    <Dialog open={!!pendingCall} onOpenChange={(open) => { if (!open) cancelSwitchCall(); }}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t.switchCallDialog.title}</DialogTitle>
          <DialogDescription>
            {t.switchCallDialog.description}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={cancelSwitchCall} disabled={switching}>
            {t.switchCallDialog.stayInCall}
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={switching}>
            {switching ? <Loader2 className="h-4 w-4 animate-spin" /> : t.switchCallDialog.leaveAndCall}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
