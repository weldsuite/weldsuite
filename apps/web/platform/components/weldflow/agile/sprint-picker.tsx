import { useMemo } from 'react';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { Sprint } from '@weldsuite/app-api-client/schemas/flow-agile';
import { useI18n } from '@/lib/i18n/provider';
import { groupSprints } from '@/app/weldflow/lib/sprint-metrics';

const ALL = '__all__';

/**
 * Picks the sprint the Pipeline shows: the running one first, the planned
 * ones, "All open work", then the past sprints. `null` is all open work.
 */
export function SprintPicker({
  sprints,
  value,
  onChange,
  className,
}: Readonly<{ sprints: readonly Sprint[]; value: string | null; onChange: (sprintId: string | null) => void; className?: string }>) {
  const { t, format } = useI18n();
  const copy = t.flowAgileSprints.picker;
  const status = t.flowAgile.sprintStatus;
  const groups = useMemo(() => groupSprints(sprints), [sprints]);

  const statusOf = (sprint: Sprint): string => (sprint.status in status ? status[sprint.status as keyof typeof status] : sprint.status);
  const option = (sprint: Sprint) => (
    <SelectItem key={sprint.id} value={sprint.id}>
      {format(copy.option, { name: sprint.name, status: statusOf(sprint) })}
    </SelectItem>
  );

  return (
    <Select value={value ?? ALL} onValueChange={(next) => onChange(next === ALL ? null : next)}>
      <SelectTrigger size="sm" aria-label={copy.label} className={className ?? 'w-auto min-w-48 max-w-72'}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {groups.active ? (
          <SelectGroup>
            <SelectLabel>{copy.groupActive}</SelectLabel>
            {option(groups.active)}
          </SelectGroup>
        ) : null}
        {groups.planned.length > 0 ? (
          <SelectGroup>
            <SelectLabel>{copy.groupPlanned}</SelectLabel>
            {groups.planned.map(option)}
          </SelectGroup>
        ) : null}
        <SelectItem value={ALL}>{copy.allOpen}</SelectItem>
        {groups.past.length > 0 ? (
          <SelectGroup>
            <SelectLabel>{copy.groupPast}</SelectLabel>
            {groups.past.map(option)}
          </SelectGroup>
        ) : null}
      </SelectContent>
    </Select>
  );
}
