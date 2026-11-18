import { useMemo, useState } from 'react';
import { useAtom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { PanelRight, Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Toggle } from '@weldsuite/ui/components/toggle';
import { usePermissions } from '@weldsuite/permissions/react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useCapacity, useMemberNames, useResourceRequests } from '@/hooks/queries/use-flow-portfolio-queries';
import { Heatmap } from './_components/heatmap';
import { ProfileDialog, RequestDialog } from './_components/dialogs';
import { RequestsPanel } from './_components/requests-panel';
import { allSkills, formatDay, intlLocaleOf, rangeOf, todayIso } from './_lib/capacity';
import { WorkloadShell, WorkloadViewSwitch } from '../workload-shell';

const WEEK_OPTIONS = [8, 14, 26] as const;

/** Whether the resource requests panel is shown beside the heatmap, remembered per browser. */
const showRequestsAtom = atomWithStorage('weldflow.capacity.showRequests', true, undefined, { getOnInit: true });

/**
 * Workload › Capacity: booked hours per person and week across projects
 * against contract hours, with the resource requests beside it.
 */
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
  const [showRequests, setShowRequests] = useAtom(showRequestsAtom);

  const range = rangeOf(from, weeks);
  // The skill pills come from everyone, so the filter never hides its own options.
  const everyone = useCapacity({ ...range, tentative });
  const filtered = useCapacity({ ...range, tentative, skill: skill ?? undefined });
  const open = useResourceRequests('open');
  const { nameOf, pictureOf } = useMemberNames();
  const skills = useMemo(() => allSkills(everyone.data?.members ?? []), [everyone.data]);
  const load = skill ? filtered.data : everyone.data;
  const error = skill ? filtered.isError : everyone.isError;
  const retry = () => {
    (skill ? filtered : everyone).refetch().catch(() => undefined);
  };
  const requests = open.data ?? [];

  return (
    <WorkloadShell>
      {/* The same bar as the timeline's toolbar, so switching views keeps it in place, with the view's controls in it. */}
      <div className="flex items-center gap-2 border-b bg-background px-4 pt-[10px] pb-[10px]">
        <WorkloadViewSwitch />
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-2">
            <Label htmlFor="cap-weeks" className="text-[13px] font-normal">
              {copy.weeks}
            </Label>
            <Select value={String(weeks)} onValueChange={(value) => setWeeks(Number(value))}>
              <SelectTrigger id="cap-weeks" size="sm" className="w-auto text-[13px]">
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
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Toggle variant="outline" size="sm" className="px-2.5 text-[13px]" pressed={showRequests} onPressedChange={setShowRequests}>
            <PanelRight />
            {copy.requests.title}
          </Toggle>
          {canBook ? (
            <Button size="sm" className="h-8" onClick={() => setRequesting(true)}>
              <Plus className="size-4" />
              {copy.requestPerson}
            </Button>
          ) : null}
        </div>
      </div>

      {/* Edge to edge under the toolbar, like the timeline: the heatmap fills the page, the requests sit in a column on the right. */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {error ? (
            <div role="alert" className="flex items-center gap-3 border-b px-4 py-3 text-sm">
              {t.flowPortfolio.common.loadFailed}
              <Button variant="outline" size="sm" onClick={retry}>
                {t.flowPortfolio.common.retry}
              </Button>
            </div>
          ) : null}
          {load ? (
            <Heatmap load={load} groupBy={groupBy} canEdit={canManage} nameOf={nameOf} pictureOf={pictureOf} onEdit={setEditing} />
          ) : (
            !error && <Skeleton className="m-4 h-72 rounded-lg" />
          )}
        </div>
        {showRequests ? <RequestsPanel requests={requests} isLoading={open.isLoading} canBook={canBook} nameOf={nameOf} /> : null}
      </div>

      <RequestDialog open={requesting} onClose={() => setRequesting(false)} />
      <ProfileDialog memberId={editing} name={editing ? nameOf(editing) : ''} onClose={() => setEditing(null)} />
    </WorkloadShell>
  );
}
