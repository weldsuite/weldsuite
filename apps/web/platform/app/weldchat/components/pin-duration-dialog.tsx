import { useId, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { DatePicker } from '@weldsuite/ui/components/date-picker';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { useI18n } from '@/lib/i18n/provider';
import { useDateLocale } from '@/lib/i18n/date-locale';

interface PinDurationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `notify`: the server posts a "pinned a message" notice in the chat. */
  onPin: (expiresAt?: string, notify?: boolean) => void;
}

type DurationOption = '24h' | '7d' | '30d' | 'custom' | 'forever';

const DURATION_MS: Partial<Record<DurationOption, number>> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** When a pin made now ends; undefined for one that stays (or a custom date not picked yet). */
export function pinExpiresAt(option: DurationOption, now: Date, customDate?: Date): Date | undefined {
  const ms = DURATION_MS[option];
  if (ms) return new Date(now.getTime() + ms);
  return option === 'custom' ? customDate : undefined;
}

function startOfTomorrow(): Date {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Pin a message: one select for how long it stays pinned (each choice says
 * until when), a date field for a custom end, and a switch for telling the
 * chat about it.
 */
export function PinDurationDialog({
  open,
  onOpenChange,
  onPin,
}: Readonly<PinDurationDialogProps>) {
  const { t } = useI18n();
  const tp = t.weldchat.pinDuration;
  const { intlLocale, dateFnsLocale } = useDateLocale();
  const durationId = useId();
  const dateId = useId();
  const notifyId = useId();
  const [selected, setSelected] = useState<DurationOption>('forever');
  const [customDate, setCustomDate] = useState<Date | undefined>(undefined);
  const [notify, setNotify] = useState(true);

  const options: { value: DurationOption; label: string }[] = [
    { value: '24h', label: tp.durations.h24 },
    { value: '7d', label: tp.durations.d7 },
    { value: '30d', label: tp.durations.d30 },
    { value: 'custom', label: tp.durations.custom },
    { value: 'forever', label: tp.durations.forever },
  ];
  const now = new Date();
  /** "Until Sun, 22 Nov, 17:05" for 24 hours; the day alone for longer pins. */
  const untilText = (option: DurationOption): string | undefined => {
    const end = DURATION_MS[option] ? pinExpiresAt(option, now) : undefined;
    if (!end) return undefined;
    const date = new Intl.DateTimeFormat(intlLocale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      ...(option === '24h' ? { hour: '2-digit', minute: '2-digit' } : {}),
    }).format(end);
    return tp.until.replace('{date}', date);
  };

  const reset = () => {
    setSelected('forever');
    setCustomDate(undefined);
    setNotify(true);
  };
  const close = () => {
    onOpenChange(false);
    reset();
  };
  const canPin = selected !== 'custom' || !!customDate;
  const handlePin = () => {
    if (!canPin) return;
    onPin(pinExpiresAt(selected, new Date(), customDate)?.toISOString(), notify);
    close();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      {/* No description: the title and the fields say it all. */}
      <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{tp.title}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-1.5">
          <Label htmlFor={durationId}>{tp.keepPinned}</Label>
          <Select value={selected} onValueChange={(value) => setSelected(value as DurationOption)}>
            <SelectTrigger id={durationId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            {/* As wide as the field; each choice says until when, in the open list only. */}
            <SelectContent className="w-[var(--radix-select-trigger-width)]">
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value} description={untilText(option.value)}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selected === 'custom' && (
          <div className="grid gap-1.5">
            <Label htmlFor={dateId}>{tp.unpinOn}</Label>
            <DatePicker
              id={dateId}
              date={customDate}
              onDateChange={setCustomDate}
              placeholder={tp.selectDate}
              locale={dateFnsLocale}
              disabledDays={{ before: startOfTomorrow() }}
            />
          </div>
        )}

        <div className="flex items-center justify-between gap-4">
          <Label htmlFor={notifyId} className="font-normal">{tp.notify}</Label>
          <Switch id={notifyId} checked={notify} onCheckedChange={setNotify} />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={close}>
            {tp.cancel}
          </Button>
          <Button size="sm" onClick={handlePin} disabled={!canPin}>
            {tp.pin}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
