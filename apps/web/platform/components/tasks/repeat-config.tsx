
import { Check, Trash2 } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { cn } from '@/lib/utils';

export type RepeatFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom';
export type RepeatUnit = 'days' | 'weeks' | 'months' | 'years';

const REPEAT_ORDER: Exclude<RepeatFrequency, 'custom'>[] = ['daily', 'weekly', 'biweekly', 'monthly', 'yearly'];
const REPEAT_UNIT_ORDER: RepeatUnit[] = ['days', 'weeks', 'months', 'years'];

type Translator = (path: string, params?: Record<string, unknown>) => string;

function repeatLabels(t: Translator): Record<Exclude<RepeatFrequency, 'custom'>, string> {
  return {
    daily: t('sweep.shared.taskRepeat.daily'),
    weekly: t('sweep.shared.taskRepeat.weekly'),
    biweekly: t('sweep.shared.taskRepeat.biweekly'),
    monthly: t('sweep.shared.taskRepeat.monthly'),
    yearly: t('sweep.shared.taskRepeat.yearly'),
  };
}

function repeatUnitLabels(t: Translator): Record<RepeatUnit, string> {
  return {
    days: t('sweep.shared.repeatUnit.days'),
    weeks: t('sweep.shared.repeatUnit.weeks'),
    months: t('sweep.shared.repeatUnit.months'),
    years: t('sweep.shared.repeatUnit.years'),
  };
}

interface RepeatConfigMenuProps {
  /** Current frequency selection, null = no repeat */
  repeat: RepeatFrequency | null;
  repeatInterval: number;
  repeatUnit: RepeatUnit;
  onRepeatChange: (value: RepeatFrequency | null) => void;
  onIntervalChange: (value: number) => void;
  onUnitChange: (value: RepeatUnit) => void;
}

/**
 * Popover-body contents for the repeat configuration picker.
 * Renders a list of preset frequencies, a custom row with interval + unit selects,
 * and a clear button. Intended to be placed inside a <PopoverContent>.
 */
export function RepeatConfigMenu({
  repeat,
  repeatInterval,
  repeatUnit,
  onRepeatChange,
  onIntervalChange,
  onUnitChange,
}: RepeatConfigMenuProps) {
  const t = useTranslations();
  const labels = repeatLabels(t);
  const unitLabels = repeatUnitLabels(t);
  return (
    <>
      {REPEAT_ORDER.map((key) => (
        <Button
          key={key}
          type="button"
          variant="ghost"
          onClick={() => onRepeatChange(key)}
          className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-secondary rounded h-auto"
        >
          <span>{labels[key]}</span>
          {repeat === key && <Check className="h-3.5 w-3.5 text-primary" />}
        </Button>
      ))}
      <div className="h-px bg-gray-200 dark:bg-accent my-1" />
      <Button
        type="button"
        variant="ghost"
        onClick={() => onRepeatChange('custom')}
        className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-secondary rounded h-auto"
      >
        <span>{t('sweep.shared.custom')}</span>
        {repeat === 'custom' && <Check className="h-3.5 w-3.5 text-primary" />}
      </Button>
      {repeat === 'custom' && (
        <div className="flex items-center gap-2 px-2 py-2 mt-1">
          <span className="text-sm text-muted-foreground">{t('sweep.shared.every')}</span>
          <Input
            type="number"
            min={1}
            value={repeatInterval}
            onChange={(e) => onIntervalChange(Math.max(1, parseInt(e.target.value) || 1))}
            className="w-16 text-center"
          />
          <Select
            value={repeatUnit}
            onValueChange={(value) => onUnitChange(value as RepeatUnit)}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REPEAT_UNIT_ORDER.map((key) => (
                <SelectItem key={key} value={key}>{unitLabels[key]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {repeat && (
        <>
          <div className="h-px bg-gray-200 dark:bg-accent my-1" />
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              onRepeatChange(null);
              onIntervalChange(1);
              onUnitChange('days');
            }}
            className="flex items-center w-full px-2 py-1.5 text-sm text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-950 rounded h-auto"
          >
            <Trash2 className="h-3.5 w-3.5 mr-2" />
            <span>{t('sweep.shared.clear')}</span>
          </Button>
        </>
      )}
    </>
  );
}

// Fallback English labels for callers that don't have a translator on hand
// (e.g. call sites outside this module's ownership) — keeps `repeatLabel`
// backward-compatible for those without forcing every caller to thread `t`.
const FALLBACK_REPEAT_LABELS: Record<Exclude<RepeatFrequency, 'custom'>, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  yearly: 'Yearly',
};

/** Returns a short human-readable label for the current repeat selection */
export function repeatLabel(
  repeat: RepeatFrequency | null,
  repeatInterval: number,
  repeatUnit: RepeatUnit,
  t?: Translator,
): string | null {
  if (!repeat) return null;
  if (repeat === 'custom') {
    return t
      ? t('sweep.shared.everyIntervalUnit', { interval: repeatInterval, unit: repeatUnit })
      : `Every ${repeatInterval} ${repeatUnit}`;
  }
  return (t ? repeatLabels(t)[repeat] : FALLBACK_REPEAT_LABELS[repeat]) ?? null;
}

/** Convert repeat state to the API payload shape */
export function buildRepeatPayload(
  repeat: RepeatFrequency | null,
  repeatInterval: number,
  repeatUnit: RepeatUnit,
): { frequency: string; interval?: number; unit?: string } | null {
  if (!repeat) return null;
  if (repeat === 'custom') {
    return { frequency: 'custom', interval: repeatInterval, unit: repeatUnit };
  }
  return { frequency: repeat };
}

/** Inline select row for simple (non-custom) repeat, used in quick-create cards */
function SimpleRepeatSelect({
  value,
  onChange,
  className,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  className?: string;
}) {
  const t = useTranslations();
  return (
    <Select
      value={value ?? 'none'}
      onValueChange={(v) => onChange(v === 'none' ? null : v)}
    >
      <SelectTrigger className={cn('h-8 text-sm', className)}>
        <SelectValue placeholder={t('sweep.shared.noRepeat')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">{t('sweep.shared.noRepeat')}</SelectItem>
        <SelectItem value="daily">{t('sweep.shared.taskRepeat.daily')}</SelectItem>
        <SelectItem value="weekly">{t('sweep.shared.taskRepeat.weekly')}</SelectItem>
        <SelectItem value="biweekly">{t('sweep.shared.taskRepeat.biweekly')}</SelectItem>
        <SelectItem value="monthly">{t('sweep.shared.taskRepeat.monthly')}</SelectItem>
        <SelectItem value="custom">{t('sweep.shared.customEditDetails')}</SelectItem>
      </SelectContent>
    </Select>
  );
}
