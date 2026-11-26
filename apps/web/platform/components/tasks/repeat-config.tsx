
import { Check, ChevronDown } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Command, CommandGroup, CommandItem, CommandList } from '@weldsuite/ui/components/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText } from '@weldsuite/ui/components/input-group';
import { PickerCheck } from '@weldsuite/ui/components/picker-menu';

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
  /** The first line, for no repeat ("Never"); "No repeat" by default. */
  noneLabel?: string;
  /** Called after a choice that is complete on its own (no repeat or a preset), to close the popover. */
  onDone?: () => void;
}

/** Keeps a key inside a field: the list would read Enter and the arrows as its own. */
const keepKeys = (e: React.KeyboardEvent) => e.stopPropagation();

/**
 * Popover-body contents for the repeat picker, built like the platform's other field pickers:
 * shadcn's Command list with a check on the right of the chosen line. "No repeat" first, the
 * presets, then Custom, which shows "Every [n] [unit]" under the list as shadcn's input group
 * (the number, and the unit in a dropdown at its end). Place it in a
 * `<PopoverContent className="p-0">`.
 */
export function RepeatConfigMenu({
  repeat,
  repeatInterval,
  repeatUnit,
  onRepeatChange,
  onIntervalChange,
  onUnitChange,
  noneLabel,
  onDone,
}: Readonly<RepeatConfigMenuProps>) {
  const t = useTranslations();
  const labels = repeatLabels(t);
  const unitLabels = repeatUnitLabels(t);
  const clear = () => {
    onRepeatChange(null);
    onIntervalChange(1);
    onUnitChange('days');
    onDone?.();
  };
  return (
    <Command className="outline-hidden">
      <CommandList>
        <CommandGroup>
          <CommandItem value="none" onSelect={clear}>
            {noneLabel ?? t('sweep.shared.noRepeat')}
            <PickerCheck selected={!repeat} />
          </CommandItem>
          {REPEAT_ORDER.map((key) => (
            <CommandItem
              key={key}
              value={key}
              onSelect={() => {
                onRepeatChange(key);
                onDone?.();
              }}
            >
              {labels[key]}
              <PickerCheck selected={repeat === key} />
            </CommandItem>
          ))}
          <CommandItem value="custom" onSelect={() => onRepeatChange('custom')}>
            {t('sweep.shared.custom')}
            <PickerCheck selected={repeat === 'custom'} />
          </CommandItem>
        </CommandGroup>
      </CommandList>
      {repeat === 'custom' && (
        <div className="border-t p-2">
          <InputGroup>
            <InputGroupAddon>
              <InputGroupText>{t('sweep.shared.every')}</InputGroupText>
            </InputGroupAddon>
            <InputGroupInput
              type="number"
              min={1}
              value={repeatInterval}
              onChange={(e) => onIntervalChange(Math.max(1, Number.parseInt(e.target.value) || 1))}
              onKeyDown={keepKeys}
              aria-label={t('sweep.shared.every')}
            />
            <InputGroupAddon align="inline-end">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <InputGroupButton onKeyDown={keepKeys}>
                    {unitLabels[repeatUnit]}
                    <ChevronDown />
                  </InputGroupButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onKeyDown={keepKeys}>
                  {REPEAT_UNIT_ORDER.map((key) => (
                    <DropdownMenuItem key={key} onSelect={() => onUnitChange(key)}>
                      {unitLabels[key]}
                      <Check className={repeatUnit === key ? 'ml-auto' : 'ml-auto opacity-0'} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </InputGroupAddon>
          </InputGroup>
        </div>
      )}
    </Command>
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