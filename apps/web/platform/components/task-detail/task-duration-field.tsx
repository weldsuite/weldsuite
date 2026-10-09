'use client';

import React, { useState } from 'react';
import { Check, Timer, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';

const DURATION_PRESETS = [15, 30, 45, 60, 90, 120];

/** 90 -> "1h 30m", 30 -> "30m", 120 -> "2h". */
export function formatDurationMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const rest = mins % 60;
  return `${Math.floor(mins / 60)}h${rest ? ` ${rest}m` : ''}`;
}

interface TaskDurationFieldProps {
  /** Estimated time in minutes (`tasks.duration`). */
  duration: number | null | undefined;
  /** Called with the new minutes, or null to clear the estimate. */
  onChange: (minutes: number | null) => void;
}

/**
 * "Time estimate" row for the task panel. Shows the estimate chosen in the
 * create dialog and lets it be changed or cleared with the same presets.
 */
export function TaskDurationField({ duration, onChange }: Readonly<TaskDurationFieldProps>) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const hasDuration = duration != null && duration > 0;

  return (
    <div className="flex items-center gap-3">
      <div className="flex w-32 flex-shrink-0 items-center gap-2">
        <Timer className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t('sweep.shared.timeEstimate')}</span>
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            className={cn(
              'group/field -mx-[5px] inline-flex h-8 cursor-pointer items-center self-start rounded-md px-[5px] text-left text-sm transition-colors',
              hasDuration && 'border border-transparent hover:border-border hover:bg-muted/40',
            )}
          >
            {hasDuration ? (
              <span className="text-cyan-700 dark:text-cyan-400">{formatDurationMinutes(duration)}</span>
            ) : (
              <span className="text-muted-foreground group-hover/field:underline">
                {t('sweep.shared.setTimeEstimate')}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-1" align="start">
          <div className="flex flex-col">
            {DURATION_PRESETS.map((mins) => (
              <Button
                variant="ghost"
                key={mins}
                onClick={() => {
                  onChange(mins);
                  setOpen(false);
                }}
                className="flex items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-secondary"
              >
                <span>{formatDurationMinutes(mins)}</span>
                {duration === mins && <Check className="h-3.5 w-3.5 text-primary" />}
              </Button>
            ))}
            <div className="my-1 h-px bg-gray-200 dark:bg-border" />
            <div className="px-2 py-1.5">
              <label
                htmlFor="task-duration-custom"
                className="text-xs font-medium text-gray-500 dark:text-muted-foreground"
              >
                {t('sweep.shared.customMinutes')}
              </label>
              <Input
                id="task-duration-custom"
                type="number"
                min="1"
                defaultValue={hasDuration && !DURATION_PRESETS.includes(duration) ? duration : ''}
                className="mt-1 h-7 text-sm"
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key !== 'Enter') return;
                  const minutes = Number.parseInt(e.currentTarget.value, 10);
                  if (Number.isFinite(minutes) && minutes > 0) {
                    onChange(minutes);
                    setOpen(false);
                  }
                }}
              />
            </div>
            {hasDuration && (
              <>
                <div className="my-1 h-px bg-gray-200 dark:bg-border" />
                <Button
                  variant="ghost"
                  onClick={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                  className="flex items-center rounded px-2 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5 text-red-600" />
                  <span>{t('sweep.shared.clear')}</span>
                </Button>
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
