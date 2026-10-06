import { useState } from 'react';
import { Pause, Play, Square } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { cn } from '@weldsuite/ui/lib/utils';
import { formatCountdown, formatLabel, type MeetingToolsLabels } from '../../tools/labels';
import { timerRemainingMs, type MeetingToolsStore, type TimerState } from '../../tools/tools-store';
import { useNow } from '../../tools/use-meeting-tools';

const PRESET_MINUTES = [1, 3, 5, 10, 15, 30];
const MAX_MINUTES = 24 * 60;

export interface TimerToolProps {
  store: MeetingToolsStore;
  timer: TimerState;
  /** Only the host starts and stops the countdown; everyone sees it. */
  canControl: boolean;
  labels: MeetingToolsLabels;
}

export function TimerTool({ store, timer, canControl, labels }: TimerToolProps) {
  const now = useNow(timer.status === 'running');
  const [minutes, setMinutes] = useState('5');
  const t = labels.timer;
  const active = timer.status !== 'idle';
  const parsedMinutes = Number(minutes);
  const validMinutes = Number.isFinite(parsedMinutes) && parsedMinutes > 0 && parsedMinutes <= MAX_MINUTES;

  return (
    <div className="p-4 space-y-5">
      {active ? (
        <div className="rounded-xl bg-muted/40 px-4 py-8 text-center">
          <div
            role="timer"
            className={cn(
              'font-mono text-5xl font-semibold tabular-nums',
              timer.status === 'paused' && 'text-muted-foreground',
            )}
          >
            {formatCountdown(timerRemainingMs(timer, now))}
          </div>
          {timer.status === 'paused' && <p className="mt-2 text-xs text-muted-foreground">{t.paused}</p>}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{canControl ? t.hostHint : t.idleHint}</p>
      )}

      {canControl && !active && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {PRESET_MINUTES.map((preset) => (
              <Button
                key={preset}
                type="button"
                variant={String(preset) === minutes ? 'secondary' : 'outline'}
                size="sm"
                onClick={() => setMinutes(String(preset))}
              >
                {formatLabel(t.presetMinutes, { count: preset })}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_MINUTES}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              aria-label={t.customMinutes}
              className="w-24"
            />
            <span className="text-sm text-muted-foreground">{t.customMinutes}</span>
          </div>
          <Button
            type="button"
            className="w-full"
            disabled={!validMinutes}
            onClick={() => store.startTimer(parsedMinutes * 60_000)}
          >
            <Play className="h-4 w-4" />
            {t.start}
          </Button>
        </div>
      )}

      {canControl && active && (
        <div className="grid grid-cols-3 gap-2">
          {timer.status === 'running' ? (
            <Button type="button" variant="outline" size="sm" onClick={() => store.pauseTimer()}>
              <Pause className="h-4 w-4" />
              {t.pause}
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={() => store.resumeTimer()}>
              <Play className="h-4 w-4" />
              {t.resume}
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => store.addTimerTime(60_000)}>
            {t.addMinute}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => store.stopTimer()}>
            <Square className="h-4 w-4" />
            {t.stop}
          </Button>
        </div>
      )}
    </div>
  );
}
