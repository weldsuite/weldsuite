/** My HR → Schedule → Shifts: switches between the list and the calendar of your shifts. */

import { CalendarDays, List } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';

export type ShiftsView = 'list' | 'calendar';

export function ShiftsViewToggle({ value, onChange }: Readonly<{ value: ShiftsView; onChange: (view: ShiftsView) => void }>) {
  const t = useTranslations();
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={value}
      // Radix sends '' when the pressed item is pressed again; one view always stays on.
      onValueChange={(next) => next && onChange(next as ShiftsView)}
      aria-label={t('weldhr.me.schedule.view.label')}
      className="shrink-0 shadow-none"
    >
      <ToggleGroupItem
        value="list"
        aria-label={t('weldhr.me.schedule.view.list')}
        title={t('weldhr.me.schedule.view.list')}
        className="w-8 text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
      >
        <List className="h-4 w-4" />
      </ToggleGroupItem>
      <ToggleGroupItem
        value="calendar"
        aria-label={t('weldhr.me.schedule.view.calendar')}
        title={t('weldhr.me.schedule.view.calendar')}
        className="w-8 text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
      >
        <CalendarDays className="h-4 w-4" />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
