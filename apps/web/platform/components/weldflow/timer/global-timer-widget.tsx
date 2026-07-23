/**
 * Floating indicator for the running time-tracking timer.
 *
 * Mounted once in the app shell, so a timer stays visible and stoppable from
 * anywhere in the platform. The timer itself is server state, so this survives
 * refresh and reflects timers started on another device.
 *
 * The chip can be dragged anywhere on screen; its position is remembered
 * across sessions. Double-click returns it to the default corner.
 *
 * Renders nothing when no timer is running.
 */

import { useState } from 'react';
import { Square, Timer, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';
import { useDraggablePosition } from '@/hooks/use-draggable-position';
import {
  formatElapsed,
  useDiscardTimer,
  useElapsedSeconds,
  useRunningTimer,
  useStopTimer,
} from '@/hooks/queries/use-timer-queries';

const TIMER_CHIP_POSITION_KEY = 'weldflow.timerChip.position';

export function GlobalTimerWidget() {
  const t = getTranslations('projects');
  const { data: timer } = useRunningTimer();
  const stopTimer = useStopTimer();
  const discardTimer = useDiscardTimer();
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  // Hook order must stay stable, so these run even when nothing is running.
  const elapsed = useElapsedSeconds(timer?.startedAt);
  const { ref, style, isDragging, dragHandleProps, resetPosition } =
    useDraggablePosition<HTMLDivElement>(TIMER_CHIP_POSITION_KEY);

  if (!timer) return null;

  const handleStop = async () => {
    try {
      await stopTimer.mutateAsync({});
      toast.success(t.projectTimesheets.timerStopped);
    } catch {
      toast.error(t.projectTimesheets.failedToStopTimer);
    }
  };

  const handleDiscard = async () => {
    if (!confirmingDiscard) {
      setConfirmingDiscard(true);
      // Revert if the user doesn't follow through, so a stale "Discard?" never
      // sits one click away from throwing work out.
      setTimeout(() => setConfirmingDiscard(false), 4000);
      return;
    }
    try {
      await discardTimer.mutateAsync();
      setConfirmingDiscard(false);
      toast.success(t.projectTimesheets.timerDiscarded);
    } catch {
      toast.error(t.projectTimesheets.failedToDiscardTimer);
    }
  };

  const busy = stopTimer.isPending || discardTimer.isPending;

  return (
    <div
      ref={ref}
      style={style}
      {...dragHandleProps}
      onDoubleClick={resetPosition}
      className={cn(
        'fixed bottom-4 left-20 z-40 flex items-center gap-3 rounded-full',
        'border bg-background/95 py-2 pl-4 pr-2 shadow-lg backdrop-blur',
        'max-w-[min(22rem,calc(100vw-2rem))]',
        // touch-none stops the browser scrolling the page instead of dragging.
        'touch-none select-none',
        isDragging ? 'cursor-grabbing shadow-xl' : 'cursor-grab',
      )}
      role="status"
      aria-live="off"
      aria-label={t.projectTimesheets.timerRunning}
      title={t.projectTimesheets.dragToMove}
    >
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>

      <div className="flex min-w-0 flex-col leading-tight">
        <span className="font-mono text-sm font-semibold tabular-nums">
          {formatElapsed(elapsed)}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {timer.description || t.projectTimesheets.noDescription}
        </span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="default"
          className="h-8 gap-1.5 rounded-full px-3"
          onClick={handleStop}
          disabled={busy}
          title={t.projectTimesheets.stopAndSave}
        >
          <Square className="h-3 w-3 fill-current" />
          <span className="text-xs">{t.projectTimesheets.stop}</span>
        </Button>
        <Button
          size="sm"
          variant={confirmingDiscard ? 'destructive' : 'ghost'}
          className="h-8 rounded-full px-2"
          onClick={handleDiscard}
          disabled={busy}
          title={t.projectTimesheets.discardTimer}
          aria-label={t.projectTimesheets.discardTimer}
        >
          {confirmingDiscard ? (
            <span className="px-1 text-xs">{t.projectTimesheets.confirmDiscard}</span>
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}

/** Icon-only variant for surfaces that already show timer detail nearby. */
export function RunningTimerBadge({ className }: { className?: string }) {
  const { data: timer } = useRunningTimer();
  const elapsed = useElapsedSeconds(timer?.startedAt);
  if (!timer) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5',
        'font-mono text-xs font-medium tabular-nums text-emerald-600 dark:text-emerald-400',
        className,
      )}
    >
      <Timer className="h-3 w-3" />
      {formatElapsed(elapsed)}
    </span>
  );
}
