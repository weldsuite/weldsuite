'use client';

import { Loader2 } from 'lucide-react';

/** Shown while the meeting hasn't started yet (status === 'waiting'). */
export function WaitingScreen() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="flex flex-col items-center text-center">
        <div className="flex items-center gap-3 mb-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Waiting for the host to start...</p>
        </div>
        <p className="text-xs text-muted-foreground">You&apos;ll be connected automatically when the meeting begins.</p>
      </div>
    </div>
  );
}

export function ConnectingScreen() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Connecting...</p>
      </div>
    </div>
  );
}

export function LoadingScreen() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading meeting...</p>
      </div>
    </div>
  );
}

/** Banner over the meeting room while the connection is being restored. */
export function ReconnectingNotice() {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4">
      <div
        role="status"
        className="flex items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg"
      >
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span>Connection lost. Reconnecting...</span>
      </div>
    </div>
  );
}
