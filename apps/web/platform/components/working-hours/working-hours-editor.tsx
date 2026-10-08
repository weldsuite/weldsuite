import { Plus, X } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Switch } from '@weldsuite/ui/components/switch';
import { Input } from '@weldsuite/ui/components/input';
import type { DayHours, WorkingHours } from '@/hooks/queries/use-settings-queries';

const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

export const DEFAULT_HOURS: WorkingHours = {
  monday: { isOpen: true, openTime: '09:00', closeTime: '17:00' },
  tuesday: { isOpen: true, openTime: '09:00', closeTime: '17:00' },
  wednesday: { isOpen: true, openTime: '09:00', closeTime: '17:00' },
  thursday: { isOpen: true, openTime: '09:00', closeTime: '17:00' },
  friday: { isOpen: true, openTime: '09:00', closeTime: '17:00' },
  saturday: { isOpen: false },
  sunday: { isOpen: false },
};

// Breaks have no id; give each break object a stable render key (carried over
// when a break is replaced immutably) so removing one doesn't shift the inputs.
const breakKeys = new WeakMap<object, string>();
let breakKeySeq = 0;

function getBreakKey(brk: object): string {
  let key = breakKeys.get(brk);
  if (!key) {
    breakKeySeq += 1;
    key = `break-${breakKeySeq}`;
    breakKeys.set(brk, key);
  }
  return key;
}

function DayRow({
  day,
  hours,
  onChange,
  disabled,
}: Readonly<{
  day: { key: string; label: string };
  hours: DayHours;
  onChange: (hours: DayHours) => void;
  disabled?: boolean;
}>) {
  const t = useTranslations();
  const addBreak = () => {
    onChange({
      ...hours,
      breaks: [...(hours.breaks || []), { start: '12:00', end: '13:00' }],
    });
  };

  const removeBreak = (index: number) => {
    onChange({
      ...hours,
      breaks: (hours.breaks || []).filter((_, i) => i !== index),
    });
  };

  const updateBreak = (index: number, field: 'start' | 'end', value: string) => {
    const breaks = [...(hours.breaks || [])];
    const previous = breaks[index];
    const next = { ...previous, [field]: value };
    if (previous) breakKeys.set(next, getBreakKey(previous));
    breaks[index] = next;
    onChange({ ...hours, breaks });
  };

  return (
    <div className="flex items-start gap-4 py-3">
      <div className="flex items-center gap-3 w-32 pt-1">
        <Switch
          checked={hours.isOpen}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange({
              ...hours,
              isOpen: checked,
              openTime: checked ? hours.openTime || '09:00' : hours.openTime,
              closeTime: checked ? hours.closeTime || '17:00' : hours.closeTime,
            })
          }
        />
        <span className="text-sm font-medium">{day.label}</span>
      </div>

      {hours.isOpen ? (
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <Input
              type="time"
              value={hours.openTime || '09:00'}
              disabled={disabled}
              onChange={(e) => onChange({ ...hours, openTime: e.target.value })}
              className="w-24 [&::-webkit-calendar-picker-indicator]:hidden"
            />
            <span className="text-sm text-muted-foreground px-1">{t('sweep.shared.to')}</span>
            <Input
              type="time"
              value={hours.closeTime || '17:00'}
              disabled={disabled}
              onChange={(e) => onChange({ ...hours, closeTime: e.target.value })}
              className="w-24 [&::-webkit-calendar-picker-indicator]:hidden"
            />
            <Button variant="outline" size="sm" onClick={addBreak} className="ml-2 shadow-none h-[36px]" disabled={disabled}>
              <Plus className="h-3 w-3" />
              {t('sweep.shared.break')}
            </Button>
          </div>

          {hours.breaks?.map((brk, i) => (
            <div key={getBreakKey(brk)} className="flex items-center gap-2 relative">
              <span className="text-xs text-muted-foreground absolute right-full mr-2 whitespace-nowrap">{t('sweep.shared.breakLabel')}</span>
              <Input
                type="time"
                value={brk.start}
                disabled={disabled}
                onChange={(e) => updateBreak(i, 'start', e.target.value)}
                className="w-24 [&::-webkit-calendar-picker-indicator]:hidden"
              />
              <span className="text-sm text-muted-foreground px-1">{t('sweep.shared.to')}</span>
              <Input
                type="time"
                value={brk.end}
                disabled={disabled}
                onChange={(e) => updateBreak(i, 'end', e.target.value)}
                className="w-24 [&::-webkit-calendar-picker-indicator]:hidden"
              />
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeBreak(i)} disabled={disabled}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <span className="text-sm text-muted-foreground pt-1">{t('sweep.shared.notWorking')}</span>
      )}
    </div>
  );
}

export function WorkingHoursEditor({
  value,
  onChange,
  disabled,
}: Readonly<{
  value: WorkingHours;
  onChange: (hours: WorkingHours) => void;
  disabled?: boolean;
}>) {
  const t = useTranslations();
  const days = DAY_KEYS.map((key) => ({ key, label: t(`sweep.shared.weekday.${key}`) }));
  return (
    <div className="space-y-1">
      {days.map((day) => (
        <DayRow
          key={day.key}
          day={day}
          hours={value[day.key as keyof WorkingHours] || { isOpen: false }}
          onChange={(dayHours) => onChange({ ...value, [day.key]: dayHours })}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
