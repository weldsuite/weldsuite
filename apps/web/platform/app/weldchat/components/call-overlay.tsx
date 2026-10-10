/**
 * WeldChat in-call views.
 *
 * These render the SAME shared `MeetingRoomView` as the WeldMeet experience
 * (via `chat-meeting-room.tsx`), driven by the WeldChat call context.
 * This file only owns the status → view routing and the inline/fullscreen
 * wrappers; the room itself lives in the shared `@weldsuite/weldmeet-ui` package.
 *
 * Exports consumed elsewhere:
 *   - InlineCallView  → channel / DM / group-DM conversation pages (inline)
 *   - CallOverlay     → app-shell (global, fullscreen)
 *
 * The "leave this call to join another?" question is the global
 * <CallSwitchDialog/> (components/call-switch-dialog.tsx), not a chat dialog.
 */

import { ConnectingView } from '@weldsuite/weldmeet-ui';
import { useWeldChatCall, useWeldChatCallOptional } from '@/contexts/weldchat-call-context';
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
