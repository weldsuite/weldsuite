import { useMemo, useState } from 'react';
import { PackageOpen, Plus } from 'lucide-react';
import { useParams } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import type { Deliverable, DeliverableStatus } from '@weldsuite/app-api-client/domains/project-governance';
import { useI18n } from '@/lib/i18n/provider';
import {
  useBaselineVersions,
  useDecisions,
  useDeliverables,
  useScope,
} from '@/hooks/queries/use-project-governance-queries';
import { useFormatters, useGovernance } from '../governance/_lib/use-governance';
import { Bar, EmptyBlock, ErrorBlock, LoadingBlocks, MemberLabel, Pill, type Tone } from '../governance/_components/parts';
import { DeliverableDialogs, type DeliverableDialogState } from './_components/deliverable-dialogs';
import { ScopeDialog } from './_components/scope-dialog';

const STATUS_TONE: Record<DeliverableStatus, Tone> = { not_started: 'neutral', in_progress: 'info', accepted: 'success', rejected: 'danger' };

/** Scope › Scope: the statement, in and out of scope, the baseline versions and the deliverables. */
export default function ScopePage() {
  const { t, format } = useI18n();
  const copy = t.flowGovernance.scope;
  const params = useParams();
  const projectId = String(params.projectId ?? '');
  const { abilities, memberOf, memberOptions } = useGovernance(projectId);
  const formatters = useFormatters();
  const scopeQuery = useScope(projectId);
  const deliverablesQuery = useDeliverables(projectId);
  const baselinesQuery = useBaselineVersions(projectId);
  const decisionsQuery = useDecisions(projectId);

  const [editingScope, setEditingScope] = useState(false);
  const [dialog, setDialog] = useState<DeliverableDialogState | null>(null);

  const deliverables = useMemo(() => deliverablesQuery.data ?? [], [deliverablesQuery.data]);
  const accepted = deliverables.filter((d) => d.status === 'accepted').length;
  const memberName = (id: string | null) => memberOf(id)?.name ?? id ?? t.flowGovernance.common.unassigned;

  if (scopeQuery.isLoading || deliverablesQuery.isLoading) return <LoadingBlocks label={copy.title} rows={3} />;
  if (scopeQuery.isError || deliverablesQuery.isError || !scopeQuery.data) {
    return <ErrorBlock onRetry={() => void Promise.all([scopeQuery.refetch(), deliverablesQuery.refetch()])} />;
  }
  const scope = scopeQuery.data;
  const baselines = baselinesQuery.data ?? [];
  const current = baselines[0];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-stretch gap-4">
        <section aria-labelledby="scope-statement" className="min-w-0 flex-[999_1_32rem] rounded-lg border bg-card p-5">
          <div className="flex items-center gap-2">
            <h2 id="scope-statement" className="flex-1 text-[15px] font-semibold">
              {copy.statement.title}
            </h2>
            {abilities.update ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setEditingScope(true)}>
                {t.flowGovernance.common.edit}
              </Button>
            ) : null}
          </div>
          <p className="mt-2.5 text-[15px] leading-relaxed whitespace-pre-line">
            {scope.statement || <span className="text-muted-foreground">{copy.statement.empty}</span>}
          </p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 text-[13px] font-semibold text-green-700 dark:text-green-400">{copy.inScope}</h3>
              {scope.inScope.length === 0 ? (
                <p className="text-sm text-muted-foreground">{copy.noInScope}</p>
              ) : (
                <ul className="list-disc space-y-1 pl-[1.1rem] text-[13px] leading-relaxed">
                  {scope.inScope.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-[13px] font-semibold text-red-700 dark:text-red-400">{copy.outOfScope}</h3>
              {scope.outOfScope.length === 0 ? (
                <p className="text-sm text-muted-foreground">{copy.noOutOfScope}</p>
              ) : (
                <ul className="flex flex-col gap-1.5 text-[13px]">
                  {scope.outOfScope.map((item, index) => (
                    <li key={index} className="flex flex-wrap items-center gap-1.5">
                      {item.text}
                      {item.link || item.reason ? (
                        <span className="rounded-md border px-1.5 text-[11px] text-muted-foreground">
                          {[item.link?.code ?? item.link?.title, item.reason].filter(Boolean).join(' · ')}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

        <section aria-labelledby="scope-baseline" className="min-w-0 max-w-full flex-[1_1_21rem] rounded-lg border bg-card p-5 sm:max-w-[28.75rem]">
          <h2 id="scope-baseline" className="text-[15px] font-semibold">
            {copy.baseline.title}
          </h2>
          <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{copy.baseline.description}</p>
          {current ? (
            <>
              <div className="mt-3.5 rounded-lg bg-muted px-3.5 py-3">
                <div className="text-xs text-muted-foreground">{copy.baseline.current}</div>
                <div className="mt-0.5 text-lg font-semibold">{format(copy.baseline.versionLine, { version: current.version, date: formatters.date(current.createdAt) })}</div>
                <div className="mt-0.5 text-xs text-foreground/70">
                  {format(copy.baseline.summaryShort, { count: current.snapshot?.deliverables?.length ?? 0 })}
                  {current.snapshot?.goLive ? ` · go-live ${formatters.shortDate(current.snapshot.goLive)}` : ''}
                </div>
              </div>
              <ol aria-label={copy.baseline.history} className="mt-3.5 flex flex-col gap-2.5 text-[13px]">
                {baselines.map((version) => (
                  <li key={version.id} className="flex gap-2.5">
                    <span className="w-7 shrink-0 font-semibold">v{version.version}</span>
                    <span className="flex-1 text-foreground/80">{version.changeRequestId ? copy.baseline.byChange : copy.baseline.signedOff}</span>
                    <span className="whitespace-nowrap text-muted-foreground">{formatters.shortDate(version.createdAt)}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="mt-3.5 rounded-lg bg-muted px-3.5 py-3 text-sm text-muted-foreground">{copy.baseline.empty}</p>
          )}
        </section>
      </div>

      <section aria-labelledby="scope-deliverables" className="overflow-hidden rounded-lg border bg-card">
        <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3.5">
          <h2 id="scope-deliverables" className="flex-1 text-[15px] font-semibold">
            {copy.deliverables.title}
          </h2>
          {deliverables.length > 0 ? (
            <span className="text-xs text-muted-foreground">{format(copy.deliverables.accepted, { accepted, total: deliverables.length })}</span>
          ) : null}
          {abilities.create ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setDialog({ kind: 'create' })}>
              <Plus aria-hidden />
              {copy.deliverables.add}
            </Button>
          ) : null}
        </div>
        {deliverables.length === 0 ? (
          <div className="p-4">
            <EmptyBlock
              icon={<PackageOpen aria-hidden className="size-6" />}
              title={copy.deliverables.empty}
              description={abilities.create ? copy.deliverables.emptyDescription : copy.deliverables.emptyReadOnly}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-4 py-2.5 font-medium">{copy.deliverables.columns.deliverable}</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">{copy.deliverables.columns.owner}</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">{copy.deliverables.columns.tasks}</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">{copy.deliverables.columns.criteria}</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">{copy.deliverables.columns.raid}</th>
                  <th scope="col" className="py-2.5 pr-4 pl-2 font-medium">{copy.deliverables.columns.status}</th>
                </tr>
              </thead>
              <tbody>
                {deliverables.map((d) => (
                  <DeliverableRow key={d.id} d={d} memberName={memberName} memberOf={memberOf} onOpen={() => setDialog({ kind: 'detail', deliverable: d })} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editingScope ? (
        <ScopeDialog projectId={projectId} scope={scope} decisions={decisionsQuery.data ?? []} onClose={() => setEditingScope(false)} />
      ) : null}
      <DeliverableDialogs
        projectId={projectId}
        state={dialog}
        memberOptions={memberOptions}
        abilities={abilities}
        memberName={memberName}
        onState={setDialog}
      />
    </div>
  );
}

function DeliverableRow({
  d,
  memberName,
  memberOf,
  onOpen,
}: Readonly<{
  d: Deliverable;
  memberName: (id: string | null) => string;
  memberOf: ReturnType<typeof useGovernance>['memberOf'];
  onOpen: () => void;
}>) {
  const { t, format } = useI18n();
  const copy = t.flowGovernance.scope.deliverables;
  const percent = d.taskProgress.total ? Math.round((d.taskProgress.done / d.taskProgress.total) * 100) : 0;
  return (
    <tr className="border-t">
      <td className="px-4 py-3">
        <button type="button" onClick={onOpen} aria-label={format(copy.open, { code: d.code })} className="flex flex-wrap items-center gap-2 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <span className="text-xs text-muted-foreground">{d.code}</span>
          <span className="font-medium">{d.title}</span>
          {d.clientVisible ? <span className="rounded-md bg-muted px-1.5 text-[11px] text-muted-foreground">{copy.clientVisible}</span> : null}
        </button>
      </td>
      <td className="px-2 py-3">
        {d.ownerId ? <MemberLabel userId={d.ownerId} member={memberOf(d.ownerId)} /> : <span className="text-xs text-muted-foreground">{memberName(null)}</span>}
      </td>
      <td className="w-40 px-2 py-3">
        {d.taskProgress.total > 0 ? (
          <span className="flex items-center gap-2">
            <Bar percent={percent} label={format(copy.tasksCount, d.taskProgress)} />
            <span className="text-xs whitespace-nowrap text-muted-foreground">{format(copy.tasksCount, d.taskProgress)}</span>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{copy.noTasks}</span>
        )}
      </td>
      <td className="px-2 py-3 text-xs whitespace-nowrap text-foreground/80">
        {d.criteriaTotal > 0 ? format(copy.criteriaCount, { met: d.criteriaMet, total: d.criteriaTotal }) : copy.noCriteria}
      </td>
      <td className="px-2 py-3">
        <span className="flex gap-1">
          {d.raid.map((r) => (
            <span key={r.id} title={r.title} className="rounded-md border px-1.5 py-px text-xs whitespace-nowrap">
              {r.code}
            </span>
          ))}
        </span>
      </td>
      <td className="py-3 pr-4 pl-2">
        <Pill tone={STATUS_TONE[d.status]}>{copy.statuses[d.status]}</Pill>
      </td>
    </tr>
  );
}
