import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { usePermissions } from '@weldsuite/permissions/react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useCapacity, useMemberNames, useResourceRequests } from '@/hooks/queries/use-flow-portfolio-queries';
import { Heatmap } from './_components/heatmap';
import { ProfileDialog, RequestDialog } from './_components/dialogs';
import { RequestsPanel } from './_components/requests-panel';
import { allSkills, formatDay, intlLocaleOf, rangeOf, todayIso } from './_lib/capacity';

const WEEK_OPTIONS = [8, 14, 26] as const;

function SummaryTile({ label, value, note, warn }: Readonly<{ label: string; value: string; note: string; warn?: boolean }>) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-[22px] font-semibold', warn && 'text-orange-700 dark:text-orange-400')}>{value}</div>
      <div className="mt-0.5 text-xs text-foreground/70">{note}</div>
    </div>
  );
}

/** Capacity across projects: booked hours per person and week against contract hours, with resource requests beside it. */
export default function CapacityPage() {
  const { t, format, language } = useI18n();
  const copy = t.flowPortfolio.capacity;
  const locale = intlLocaleOf(language);
  const { can } = usePermissions();
  const canManage = can('portfolio:manage');
  const canBook = canManage || can('projects:update');
  const [from] = useState(todayIso);
  const [weeks, setWeeks] = useState<number>(14);
  const [groupBy, setGroupBy] = useState<'person' | 'skill'>('person');
  const [skill, setSkill] = useState<string | null>(null);
  const [tentative, setTentative] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const range = rangeOf(from, weeks);
  // The skill pills come from everyone, so the filter never hides its own options.
  const everyone = useCapacity({ ...range, tentative });
  const filtered = useCapacity({ ...range, tentative, skill: skill ?? undefined });
  const open = useResourceRequests('open');
  const { nameOf } = useMemberNames();
  const skills = useMemo(() => allSkills(everyone.data?.members ?? []), [everyone.data]);
  const load = skill ? filtered.data : everyone.data;
  const error = skill ? filtered.isError : everyone.isError;
  const requests = open.data ?? [];
  const oldest = requests.reduce((min, r) => Math.min(min, Date.parse(r.createdAt)), Number.POSITIVE_INFINITY);
  const oldestDays = Number.isFinite(oldest) ? Math.max(0, Math.floor((Date.now() - oldest) / 86_400_000)) : null;

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">{copy.title}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{copy.subtitle}</p>
        </div>
        {canBook ? (
          <Button onClick={() => setRequesting(true)}>
            <Plus className="size-4" />
            {copy.requestPerson}
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex items-center gap-2">
          <Label htmlFor="cap-weeks" className="text-[13px] font-normal">
            {copy.weeks}
          </Label>
          <Select value={String(weeks)} onValueChange={(value) => setWeeks(Number(value))}>
            <SelectTrigger id="cap-weeks" className="h-8 w-auto text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WEEK_OPTIONS.map((count) => (
                <SelectItem key={count} value={String(count)}>
                  {format(copy.weeksOption, { weeks: count, from: formatDay(from, locale) })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div role="group" aria-label={copy.groupBy} className="inline-flex rounded-lg bg-muted p-[3px]">
          {(['person', 'skill'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={groupBy === mode}
              onClick={() => setGroupBy(mode)}
              className={cn('rounded-md px-2.5 py-1 text-xs', groupBy === mode ? 'bg-background font-semibold shadow-sm' : 'text-muted-foreground')}
            >
              {mode === 'person' ? copy.person : copy.skill}
            </button>
          ))}
        </div>
        <div role="group" aria-label={copy.skill} className="flex flex-wrap gap-1.5">
          {[null, ...skills].map((name) => (
            <button
              key={name ?? '__all'}
              type="button"
              aria-pressed={skill === name}
              onClick={() => setSkill(name)}
              className={cn(
                'h-7 rounded-full border px-2.5 text-xs font-medium',
                skill === name ? 'border-foreground bg-foreground text-background' : 'bg-background text-foreground/80',
              )}
            >
              {name ?? copy.allSkills}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-[13px]">
          <Switch id="cap-tentative" checked={tentative} onCheckedChange={setTentative} />
          <Label htmlFor="cap-tentative" className="font-normal">
            {copy.showTentative}
          </Label>
        </div>
      </div>

      {error ? (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-destructive/30 p-4 text-sm">
          {t.flowPortfolio.common.loadFailed}
          <Button variant="outline" size="sm" onClick={() => void (skill ? filtered.refetch() : everyone.refetch())}>
            {t.flowPortfolio.common.retry}
          </Button>
        </div>
      ) : null}

      {load ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
          <SummaryTile
            label={copy.summary.booked}
            value={load.summary.percent === null ? '–' : `${Math.round(load.summary.percent)}%`}
            note={format(copy.summary.bookedNote, {
              people: load.summary.memberCount,
              booked: load.summary.bookedHours,
              capacity: load.summary.capacityHours,
            })}
          />
          <SummaryTile
            label={copy.summary.overbooked}
            value={String(load.summary.overbookedPersonWeeks)}
            note={copy.summary.overbookedNote}
            warn={load.summary.overbookedPersonWeeks > 0}
          />
          <SummaryTile
            label={copy.summary.openRequests}
            value={String(requests.length)}
            note={oldestDays === null ? copy.summary.noOpen : format(copy.summary.oldest, { days: oldestDays })}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-start gap-4">
        {load ? (
          <Heatmap load={load} groupBy={groupBy} canEdit={canManage} nameOf={nameOf} onEdit={setEditing} />
        ) : (
          !error && <Skeleton className="h-72 min-w-0 flex-[999_1_720px] rounded-lg" />
        )}
        <RequestsPanel requests={requests} isLoading={open.isLoading} canBook={canBook} nameOf={nameOf} />
      </div>

      <RequestDialog open={requesting} onClose={() => setRequesting(false)} />
      <ProfileDialog memberId={editing} name={editing ? nameOf(editing) : ''} onClose={() => setEditing(null)} />
    </div>
  );
}
