import { useState, useRef, useEffect } from 'react';
import { Pin } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Calendar } from '@weldsuite/ui/components/calendar';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';

interface PinDurationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPin: (expiresAt?: string, notify?: boolean) => void;
}

type DurationOption = '24h' | '7d' | '30d' | 'custom' | 'forever';

function getExpiresAt(option: DurationOption, customDate?: Date): string | undefined {
  const now = new Date();
  switch (option) {
    case '24h':
      return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    case '7d':
      return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    case '30d':
      return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    case 'custom':
      return customDate ? customDate.toISOString() : undefined;
    case 'forever':
      return undefined;
  }
}

export function PinDurationDialog({
  open,
  onOpenChange,
  onPin,
}: PinDurationDialogProps) {
  const { t } = useI18n();
  const DURATION_OPTIONS: { value: DurationOption; label: string }[] = [
    { value: '24h', label: t.weldchat.pinDuration.durations.h24 },
    { value: '7d', label: t.weldchat.pinDuration.durations.d7 },
    { value: '30d', label: t.weldchat.pinDuration.durations.d30 },
    { value: 'custom', label: t.weldchat.pinDuration.durations.custom },
    { value: 'forever', label: t.weldchat.pinDuration.durations.forever },
  ];
  const [selected, setSelected] = useState<DurationOption>('forever');
  const [customDate, setCustomDate] = useState<Date | undefined>(undefined);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const calendarRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const reset = () => {
    setSelected('forever');
    setCustomDate(undefined);
    setCalendarOpen(false);
  };

  const handlePin = (notify: boolean) => {
    const expiresAt = getExpiresAt(selected, customDate);
    onPin(expiresAt, notify);
    onOpenChange(false);
    reset();
  };

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  // Close calendar when clicking outside of it and the trigger
  useEffect(() => {
    if (!calendarOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        calendarRef.current && !calendarRef.current.contains(target) &&
        triggerRef.current && !triggerRef.current.contains(target)
      ) {
        setCalendarOpen(false);
      }
    };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, [calendarOpen]);

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pin className="h-4 w-4" />
            {t.weldchat.pinDuration.title}
          </DialogTitle>
          <DialogDescription>
            {t.weldchat.pinDuration.description}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {DURATION_OPTIONS.map((option) => (
            <Button
              key={option.value}
              variant="ghost"
              onClick={() => { setSelected(option.value); setCalendarOpen(false); }}
              className={cn(
                'relative flex items-center justify-center rounded-lg border px-3.5 py-3 transition-all',
                selected === option.value
                  ? 'border-primary bg-primary/5 shadow-sm'
                  : 'border-border hover:border-muted-foreground/40 hover:bg-accent/50',
              )}
            >
              <span className={cn(
                'text-sm font-semibold',
                selected === option.value ? 'text-primary' : 'text-foreground',
              )}>
                {option.label}
              </span>
            </Button>
          ))}
        </div>
        {selected === 'custom' && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t.weldchat.pinDuration.unpinOn}</label>
            <div className="relative">
              <Button
                ref={triggerRef}
                variant="outline"
                className="w-full justify-start font-normal"
                onClick={() => setCalendarOpen((prev) => !prev)}
              >
                {customDate ? customDate.toLocaleDateString() : t.weldchat.pinDuration.selectDate}
              </Button>
              {calendarOpen && (
                <div
                  ref={calendarRef}
                  className="absolute left-0 top-full mt-1 z-50 rounded-md border bg-popover p-0 shadow-md"
                >
                  <Calendar
                    mode="single"
                    selected={customDate}
                    defaultMonth={customDate || tomorrow}
                    captionLayout="dropdown"
                    disabled={{ before: tomorrow }}
                    onSelect={(date) => {
                      setCustomDate(date);
                      setCalendarOpen(false);
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => { onOpenChange(false); reset(); }}>
            {t.weldchat.pinDuration.cancel}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePin(false)}
            disabled={selected === 'custom' && !customDate}
          >
            {t.weldchat.pinDuration.pinSilently}
          </Button>
          <Button
            size="sm"
            onClick={() => handlePin(true)}
            disabled={selected === 'custom' && !customDate}
          >
            {t.weldchat.pinDuration.pinWithAlert}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
