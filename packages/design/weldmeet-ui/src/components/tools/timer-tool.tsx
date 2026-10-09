import { useState } from 'react';
import { Plus, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Toggle } from '@weldsuite/ui/components/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { cn } from '@weldsuite/ui/lib/utils';
import { formatCountdown, type MeetingToolsLabels } from '../../tools/labels';
import { timerRemainingMs, type MeetingToolsStore, type TimerState } from '../../tools/tools-store';
import { useNow } from '../../tools/use-meeting-tools';

const MAX_MINUTES = 24 * 60;

export interface TimerToolProps {
  store: MeetingToolsStore;
  timer: TimerState;
  /** Only the host starts and stops the countdown; everyone sees it. */
  canControl: boolean;
  /** This viewer hears the tones when the countdown ends. */
  soundOn: boolean;
  labels: MeetingToolsLabels;
}

/** A labelled number field, labelled like the fields of the other meeting tools. */
function TimeField({
  label,
  value,
  max,
  onChange,
}: Readonly<{ label: string; value: string; max: number; onChange: (value: string) => void }>) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function TimerTool({ store, timer, canControl, soundOn, labels }: Readonly<TimerToolProps>) {
  const now = useNow(timer.status === 'running');
  const [minutes, setMinutes] = useState('5');
  const [seconds, setSeconds] = useState('0');
  const t = labels.timer;
  const active = timer.status !== 'idle';

  // An emptied field counts as zero, so "0 min 30 s" and "5 min" both work.
  const parsedMinutes = Number(minutes || 0);
  const parsedSeconds = Number(seconds || 0);
  const totalSeconds = parsedMinutes * 60 + parsedSeconds;
  const valid =
    Number.isInteger(parsedMinutes) && parsedMinutes >= 0 &&
    Number.isInteger(parsedSeconds) && parsedSeconds >= 0 && parsedSeconds < 60 &&
    totalSeconds > 0 && totalSeconds <= MAX_MINUTES * 60;

  if (!canControl && !active) {
    return <p className="p-4 text-sm text-muted-foreground">{t.idleHint}</p>;
  }

  return (
    <div className="p-4">
      <Card>
        {active ? (
          <CardContent className="text-center">
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
          </CardContent>
        ) : (
          <>
            <CardHeader>
              <CardTitle>{t.enterTime}</CardTitle>
              <CardDescription>{t.hostHint}</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4">
              <TimeField label={t.customMinutes} value={minutes} max={MAX_MINUTES} onChange={setMinutes} />
              <TimeField label={t.seconds} value={seconds} max={59} onChange={setSeconds} />
            </CardContent>
          </>
        )}

        <CardFooter className="gap-2">
          {/* "+1 minute" and Cancel act on a countdown, so they wait for one. */}
          {canControl && (
            <Tooltip>
              {/* The span takes the hover: a disabled button receives none. */}
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={t.addMinute}
                    disabled={!active}
                    onClick={() => store.addTimerTime(60_000)}
                  >
                    <Plus />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t.addMinute}</TooltipContent>
            </Tooltip>
          )}
          <Toggle
            variant="outline"
            pressed={soundOn}
            onPressedChange={(pressed) => store.setPrefs({ timerSound: pressed })}
            aria-label={t.sound}
            title={t.sound}
          >
            {soundOn ? <Volume2 /> : <VolumeX />}
          </Toggle>
          {canControl && (
            <>
              <Button
                type="button"
                variant="outline"
                className="ml-auto"
                disabled={!active}
                onClick={() => store.stopTimer()}
              >
                {t.cancel}
              </Button>
              {timer.status === 'idle' && (
                <Button type="button" disabled={!valid} onClick={() => store.startTimer(totalSeconds * 1000)}>
                  {t.start}
                </Button>
              )}
              {timer.status === 'running' && (
                <Button type="button" onClick={() => store.pauseTimer()}>
                  {t.pause}
                </Button>
              )}
              {timer.status === 'paused' && (
                <Button type="button" onClick={() => store.resumeTimer()}>
                  {t.resume}
                </Button>
              )}
            </>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
