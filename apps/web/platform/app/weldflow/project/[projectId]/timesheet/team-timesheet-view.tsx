
import { useMemo } from 'react';
import { format } from 'date-fns';
import { AlertCircle, Download, Users } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { cn } from '@/lib/utils';
import { PageLoader } from '@/components/page-loader';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  useTeamTimesheet,
  type TeamTimesheetEntry,
  type TeamTimesheetMember,
} from '@/hooks/queries/use-team-timesheet-queries';

interface TeamTimesheetViewProps {
  projectId: string;
  /** Inclusive range, `yyyy-MM-dd`. Driven by the page's week/month navigation. */
  fromDate: string;
  toDate: string;
  /** Label for the active range, shown in the export filename. */
  rangeLabel: string;
}

/** Minutes → a compact `7.5h` / `45m` label. */
function formatDuration(minutes: number): string {
  if (!minutes) return '0h';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

/** RFC 4180 quoting — descriptions routinely contain commas and quotes. */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(entries: TeamTimesheetEntry[], headers: string[]): string {
  const rows = entries.map((e) =>
    [
      e.date,
      e.userName,
      e.task?.title ?? '',
      e.description ?? '',
      (e.duration / 60).toFixed(2),
      e.billable ? 'yes' : 'no',
      e.status,
    ]
      .map(csvCell)
      .join(','),
  );
  return [headers.map(csvCell).join(','), ...rows].join('\r\n');
}

export function TeamTimesheetView({
  projectId,
  fromDate,
  toDate,
  rangeLabel,
}: TeamTimesheetViewProps) {
  const st = useTranslations();
  const { data, isLoading, error } = useTeamTimesheet(projectId, { fromDate, toDate });

  const maxMemberMinutes = useMemo(
    () => Math.max(1, ...(data?.members ?? []).map((m) => m.totalMinutes)),
    [data?.members],
  );

  const handleExport = () => {
    if (!data) return;
    const csv = buildCsv(data.entries, [
      st('sweep.weldflow.timesheetPage.teamExportDate'),
      st('sweep.weldflow.timesheetPage.member'),
      st('sweep.weldflow.timesheetPage.task'),
      st('sweep.weldflow.timesheetPage.teamExportDescription'),
      st('sweep.weldflow.timesheetPage.teamExportHours'),
      st('sweep.weldflow.timesheetPage.billable'),
      st('sweep.weldflow.timesheetPage.teamExportStatus'),
    ]);
    // A BOM keeps Excel from mangling non-ASCII names on open.
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `timesheet-${data.projectName || projectId}-${rangeLabel}.csv`
      .replace(/\s+/g, '-')
      .toLowerCase();
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <AlertCircle className="h-10 w-10 text-red-400" />
          <p className="text-sm font-medium">
            {st('sweep.weldflow.timesheetPage.teamLoadFailed')}
          </p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { totals, members, entries } = data;
  const contributors = members.filter((m) => m.entryCount > 0);

  return (
    <div className="flex-1 overflow-auto">
      <div className="p-4 space-y-4">
        {/* Roll-up across the whole team for the active range. */}
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          <SummaryTile
            label={st('sweep.weldflow.timesheetPage.teamTotalHours')}
            value={formatDuration(totals.totalMinutes)}
          />
          <SummaryTile
            label={st('sweep.weldflow.timesheetPage.billable')}
            value={formatDuration(totals.billableMinutes)}
            tone="billable"
          />
          <SummaryTile
            label={st('sweep.weldflow.timesheetPage.notBillable')}
            value={formatDuration(totals.nonBillableMinutes)}
            tone="muted"
          />
          <SummaryTile
            label={st('sweep.weldflow.timesheetPage.teamContributors')}
            value={`${totals.contributorCount}/${totals.memberCount}`}
          />
        </div>

        {/* Per-member totals */}
        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Users className="h-4 w-4 text-muted-foreground" />
              {st('sweep.weldflow.timesheetPage.teamPerMember')}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 shadow-none"
              onClick={handleExport}
              disabled={!entries.length}
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              {st('sweep.weldflow.timesheetPage.teamExport')}
            </Button>
          </div>

          {members.length === 0 ? (
            <p className="px-4 py-8 text-sm text-center text-muted-foreground">
              {st('sweep.weldflow.timesheetPage.teamNoMembers')}
            </p>
          ) : (
            <div className="divide-y divide-border">
              {members.map((member) => (
                <MemberRow
                  key={member.userId}
                  member={member}
                  maxMinutes={maxMemberMinutes}
                  formerLabel={st('sweep.weldflow.timesheetPage.teamFormerMember')}
                />
              ))}
            </div>
          )}
        </div>

        {/* Every entry behind those totals */}
        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <span className="text-sm font-medium">
              {st('sweep.weldflow.timesheetPage.teamAllEntries')}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {totals.entryCount}
            </span>
          </div>

          {entries.length === 0 ? (
            <p className="px-4 py-8 text-sm text-center text-muted-foreground">
              {st('sweep.weldflow.timesheetPage.teamNoEntries')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="font-medium px-4 py-2">
                      {st('sweep.weldflow.timesheetPage.teamExportDate')}
                    </th>
                    <th className="font-medium px-4 py-2">
                      {st('sweep.weldflow.timesheetPage.member')}
                    </th>
                    <th className="font-medium px-4 py-2">
                      {st('sweep.weldflow.timesheetPage.task')}
                    </th>
                    <th className="font-medium px-4 py-2 text-right">
                      {st('sweep.weldflow.timesheetPage.teamExportHours')}
                    </th>
                    <th className="font-medium px-4 py-2">
                      {st('sweep.weldflow.timesheetPage.billable')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {entries.map((entry) => (
                    <tr key={entry.id} className="hover:bg-muted/40">
                      <td className="px-4 py-2 whitespace-nowrap tabular-nums text-muted-foreground">
                        {format(new Date(`${String(entry.date).slice(0, 10)}T00:00:00`), 'd MMM')}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">{entry.userName}</td>
                      <td className="px-4 py-2">
                        <span className="block truncate max-w-[420px]">
                          {entry.task?.title ||
                            entry.description ||
                            st('sweep.weldflow.timesheetPage.noTask')}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">
                        {formatDuration(entry.duration)}
                      </td>
                      <td className="px-4 py-2">
                        <Badge
                          variant={entry.billable ? 'default' : 'secondary'}
                          className="font-normal"
                        >
                          {entry.billable
                            ? st('sweep.weldflow.timesheetPage.billable')
                            : st('sweep.weldflow.timesheetPage.notBillable')}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* The rollup above stays exact even when this list is capped. */}
          {data.entriesTruncated && (
            <p className="px-4 py-2 text-xs text-muted-foreground border-t border-border">
              {st('sweep.weldflow.timesheetPage.teamEntriesTruncated')}
            </p>
          )}
        </div>

        {contributors.length === 0 && members.length > 0 && (
          <p className="text-xs text-center text-muted-foreground">
            {st('sweep.weldflow.timesheetPage.teamNobodyLogged')}
          </p>
        )}
      </div>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'billable' | 'muted';
}) {
  return (
    <div className="rounded-lg border border-border px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          'text-xl font-semibold tabular-nums mt-0.5',
          tone === 'billable' && 'text-emerald-600 dark:text-emerald-400',
          tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function MemberRow({
  member,
  maxMinutes,
  formerLabel,
}: {
  member: TeamTimesheetMember;
  maxMinutes: number;
  formerLabel: string;
}) {
  const billableShare = member.totalMinutes
    ? (member.billableMinutes / member.totalMinutes) * 100
    : 0;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium">
        {member.initials}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{member.name}</span>
          {!member.isActiveMember && (
            <Badge variant="outline" className="font-normal text-[10px] px-1.5 py-0">
              {formerLabel}
            </Badge>
          )}
        </div>
        {/* Billable share of this member's own logged time. */}
        <div className="mt-1 h-1.5 w-full max-w-[260px] overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-emerald-500/80"
            style={{ width: `${billableShare}%` }}
          />
        </div>
      </div>

      <div className="shrink-0 text-right">
        <div className="text-sm font-semibold tabular-nums">
          {formatDuration(member.totalMinutes)}
        </div>
        <div className="text-[11px] text-muted-foreground tabular-nums">
          {formatDuration(member.billableMinutes)} · {formatDuration(member.nonBillableMinutes)}
        </div>
      </div>

      {/* Relative bar so the busiest member reads at a glance. */}
      <div className="hidden sm:block w-24 shrink-0">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary/70"
            style={{ width: `${(member.totalMinutes / maxMinutes) * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
