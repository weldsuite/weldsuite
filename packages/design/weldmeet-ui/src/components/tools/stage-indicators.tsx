import { LayoutGrid, Radio, Timer as TimerIcon } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';
import { formatCountdown, formatLabel } from '../../tools/labels';
import { TIMER_ENDED_CUE_MS, breakoutRoomOf, timerRemainingMs } from '../../tools/tools-store';
import { useNow } from '../../tools/use-meeting-tools';
import type { MeetingToolsController } from '../../tools/use-meeting-tools-controller';

const CHIP_CLASS =
  'flex items-center gap-1.5 rounded-lg bg-black/70 px-2.5 py-1 text-[13px] font-medium text-white shadow-lg ring-1 ring-white/10 backdrop-blur';

/**
 * What everyone has to be able to see without opening a panel: the running
 * countdown, that the meeting is being streamed, and which breakout room they
 * are in. Sits in the top-left corner of the stage.
 */
export function StageIndicators({ tools }: { tools: MeetingToolsController }) {
  const { state, livestream, labels, store } = tools;
  const { timer, breakout } = state;
  // The "Time's up" cue only needs the clock until it has had its ten seconds.
  const showTimeUp = timer.endedAt !== null && Date.now() - timer.endedAt < TIMER_ENDED_CUE_MS;
  const now = useNow(timer.status === 'running' || showTimeUp);

  const remaining = timerRemainingMs(timer, now);
  const showTimer = timer.status !== 'idle';
  const room = breakoutRoomOf(breakout, store.selfKey);

  if (!showTimer && !showTimeUp && !livestream.isLive && !breakout.active) return null;

  return (
    <div className="absolute top-3 left-3 z-20 flex flex-wrap items-center gap-2 pointer-events-none">
      {livestream.isLive && (
        // A visible label, like the recording badge: people must be able to
        // tell that the meeting is being streamed to an audience.
        <span role="status" title={labels.livestream.notice} className={cn(CHIP_CLASS, 'bg-red-600/90')}>
          <Radio className="h-3.5 w-3.5" aria-hidden />
          {labels.livestream.live}
        </span>
      )}
      {showTimer && (
        <span
          role="timer"
          aria-label={labels.rows.timer}
          className={cn(
            CHIP_CLASS,
            'tabular-nums',
            timer.status === 'running' && remaining <= 10_000 && 'bg-red-600/90',
          )}
        >
          <TimerIcon className="h-3.5 w-3.5" aria-hidden />
          {formatCountdown(remaining)}
          {timer.status === 'paused' && <span className="text-white/70">{labels.timer.paused}</span>}
        </span>
      )}
      {!showTimer && showTimeUp && (
        <span role="status" className={cn(CHIP_CLASS, 'bg-red-600/90')}>
          <TimerIcon className="h-3.5 w-3.5" aria-hidden />
          {labels.timer.timeUp}
        </span>
      )}
      {breakout.active && (
        <span role="status" className={CHIP_CLASS}>
          <LayoutGrid className="h-3.5 w-3.5" aria-hidden />
          {formatLabel(labels.breakout.stageBadge, { room: room?.name ?? labels.breakout.mainRoom })}
        </span>
      )}
    </div>
  );
}
