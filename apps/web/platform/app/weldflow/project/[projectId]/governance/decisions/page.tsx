import { useMemo, useState } from 'react';
import { Plus, Scale, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useParams } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import type { Decision, DecisionDetail, DecisionStatus } from '@weldsuite/app-api-client/domains/project-governance';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useDecision, useDecisions, useDeleteDecision } from '@/hooks/queries/use-project-governance-queries';
import { useFormatters, useGovernance, type GovernanceAbilities } from '../_lib/use-governance';
import { ConfirmDelete, EmptyBlock, ErrorBlock, LoadingBlocks, Pill, type Tone } from '../_components/parts';
import { DecisionDialogs, type DecisionDialogState } from './_components/decision-dialogs';

const STATUS_TONE: Record<DecisionStatus, Tone> = { proposed: 'info', decided: 'success', superseded: 'neutral' };
const FILTERS = ['all', 'proposed', 'decided', 'superseded'] as const;
type Filter = (typeof FILTERS)[number];

/** Governance › Decisions: the decision log with its list and the selected decision. */
export default function DecisionsPage() {
  const { t, format } = useI18n();
  const copy = t.flowGovernance.decisions;
  const params = useParams();
  const projectId = String(params.projectId ?? '');
  const { abilities, memberOptions, memberOf } = useGovernance(projectId);
  const decisionsQuery = useDecisions(projectId);
  const formatters = useFormatters();

  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DecisionDialogState | null>(null);

  const decisions = useMemo(() => decisionsQuery.data ?? [], [decisionsQuery.data]);
  const counts = useMemo(
    () => ({
      all: decisions.length,
      proposed: decisions.filter((d) => d.status === 'proposed').length,
      decided: decisions.filter((d) => d.status === 'decided').length,
      superseded: decisions.filter((d) => d.status === 'superseded').length,
    }),
    [decisions],
  );
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return decisions.filter(
      (d) =>
        (filter === 'all' || d.status === filter) &&
        (!needle || `${d.code} ${d.title} ${d.context ?? ''}`.toLowerCase().includes(needle)),
    );
  }, [decisions, filter, search]);

  const current = visible.find((d) => d.id === selectedId) ?? visible[0] ?? null;
  const detailQuery = useDecision(current?.id ?? null);
  const memberName = (id: string | null) => memberOf(id)?.name ?? id ?? t.flowGovernance.common.unassigned;

  const dialogs = (
    <DecisionDialogs
      projectId={projectId}
      memberOptions={memberOptions}
      decisions={decisions}
      state={dialog}
      onClose={() => setDialog(null)}
      onSaved={(id) => {
        setDialog(null);
        setSelectedId(id);
      }}
    />
  );

  if (decisionsQuery.isLoading) return <LoadingBlocks label={copy.title} />;
  if (decisionsQuery.isError) return <ErrorBlock onRetry={() => void decisionsQuery.refetch()} />;
  if (decisions.length === 0) {
    return (
      <>
        <EmptyBlock
          icon={<Scale aria-hidden className="size-6" />}
          title={copy.emptyTitle}
          description={abilities.create ? copy.emptyDescription : copy.emptyReadOnly}
          action={
            abilities.create ? (
              <Button type="button" onClick={() => setDialog({ kind: 'create' })}>
                <Plus aria-hidden />
                {copy.record}
              </Button>
            ) : undefined
          }
        />
        {dialogs}
      </>
    );
  }

  const subline = (d: Decision): string => {
    if (d.status === 'proposed') {
      return d.decisionDueAt
        ? format(copy.proposedDue, { name: memberName(d.deciderId ?? d.createdBy), date: formatters.shortDate(d.decisionDueAt) })
        : format(copy.proposedBy, { name: memberName(d.deciderId ?? d.createdBy) });
    }
    return d.decidedBy ? memberName(d.decidedBy) : '';
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <label className="flex h-9 min-w-40 flex-[0_1_16rem] items-center gap-2 rounded-lg border bg-background px-2.5">
          <Search aria-hidden className="size-4 text-muted-foreground" />
          <span className="sr-only">{copy.searchLabel}</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={copy.searchPlaceholder}
            className="w-full bg-transparent text-sm outline-none"
          />
        </label>
        <div role="group" aria-label={copy.filterLabel} className="inline-flex rounded-lg bg-muted p-[3px]">
          {FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                filter === value ? 'bg-background font-semibold shadow-sm' : 'text-muted-foreground',
              )}
            >
              {copy.filters[value]}
              {value === 'all' ? null : <span className="ml-1 tabular-nums">{counts[value]}</span>}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {abilities.create ? (
          <Button type="button" onClick={() => setDialog({ kind: 'create' })}>
            <Plus aria-hidden />
            {copy.record}
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <section aria-label={copy.listLabel} className="min-w-0 max-w-full flex-[1_1_22rem] overflow-hidden rounded-lg border bg-card sm:max-w-[32.5rem]">
          {visible.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">{copy.noMatch}</p>
          ) : (
            <ul>
              {visible.map((d) => {
                const on = d.id === current?.id;
                return (
                  <li key={d.id} className="border-b last:border-b-0">
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => setSelectedId(d.id)}
                      className={cn(
                        'w-full border-l-[3px] px-4 py-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                        on ? 'border-l-foreground bg-muted/60' : 'border-l-transparent hover:bg-muted/40',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{d.code}</span>
                        <Pill tone={STATUS_TONE[d.status]}>{copy.statuses[d.status]}</Pill>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {d.status === 'proposed' && d.decisionDueAt
                            ? format(copy.due, { date: formatters.shortDate(d.decisionDueAt) })
                            : formatters.shortDate(d.decidedAt ?? d.createdAt)}
                        </span>
                      </span>
                      <span className={cn('mt-1 block text-sm font-medium leading-snug', d.status === 'superseded' && 'line-through')}>{d.title}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{subline(d)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <article className="min-w-0 flex-[999_1_32rem] rounded-lg border bg-card p-5 sm:p-6">
          {current ? (
            <DecisionDetailView
              decision={current}
              detail={detailQuery.data ?? null}
              loading={detailQuery.isLoading}
              onEdit={(d) => setDialog({ kind: 'edit', decision: d })}
              onDecide={() => setDialog({ kind: 'decide', decision: current })}
              onSupersede={() => setDialog({ kind: 'supersede', decision: current })}
              onDeleted={() => setSelectedId(null)}
              abilities={abilities}
              memberName={memberName}
            />
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">{copy.selectPrompt}</p>
          )}
        </article>
      </div>

      {dialogs}
    </div>
  );
}

type DecisionsCopy = ReturnType<typeof useI18n>['t']['flowGovernance']['decisions'];

function decisionMeta(
  row: Decision,
  env: { copy: DecisionsCopy; format: ReturnType<typeof useI18n>['format']; formatters: ReturnType<typeof useFormatters> },
  memberName: (id: string | null) => string,
): string {
  const { copy, format, formatters } = env;
  if (row.status === 'proposed') {
    if (row.decisionDueAt) return format(copy.proposedDue, { name: memberName(row.createdBy), date: formatters.date(row.decisionDueAt) });
    return format(copy.proposedBy, { name: memberName(row.createdBy) });
  }
  if (row.decidedBy) return format(copy.decidedBy, { name: memberName(row.decidedBy), date: formatters.date(row.decidedAt) });
  return format(copy.decidedByUnknown, { date: formatters.date(row.decidedAt) });
}

function ProposedBanner({
  row,
  declined,
  canRecord,
  onDecide,
  memberName,
}: Readonly<{
  row: Decision;
  declined: DecisionDetail['approvals'][number] | undefined;
  canRecord: boolean;
  onDecide: () => void;
  memberName: (id: string | null) => string;
}>) {
  const { t, format } = useI18n();
  const copy = t.flowGovernance.decisions;
  const formatters = useFormatters();
  let waiting: string = copy.waitingOpen;
  if (row.deciderId) {
    waiting = row.decisionDueAt
      ? format(copy.waitingNamedDue, { name: memberName(row.deciderId), date: formatters.date(row.decisionDueAt) })
      : format(copy.waitingNamed, { name: memberName(row.deciderId) });
  }
  let declinedText = '';
  if (declined) {
    const name = memberName(declined.approverId);
    declinedText = declined.note ? format(copy.declined, { name, note: declined.note }) : format(copy.declinedNoNote, { name });
  }
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-blue-50 px-3.5 py-3 text-sm text-blue-900 dark:bg-blue-950/50 dark:text-blue-200">
      <span className="min-w-0 flex-1 basis-64">
        {waiting}
        {declined ? <span className="mt-1 block text-xs opacity-80">{declinedText}</span> : null}
      </span>
      {canRecord ? (
        <Button type="button" size="sm" onClick={onDecide}>
          {copy.actions.record}
        </Button>
      ) : null}
    </div>
  );
}

function OptionsList({ options }: Readonly<{ options: Decision['options'] }>) {
  const { t } = useI18n();
  const copy = t.flowGovernance.decisions;
  if (options.length === 0) return <p className="text-sm text-muted-foreground">{copy.noOptions}</p>;
  return (
    <ol className="flex flex-col gap-2">
      {options.map((option, index) => (
        <li
          key={`${option.title}-${index}`}
          className={cn('flex gap-2.5 rounded-lg border px-3 py-2.5', option.chosen && 'border-green-600/40 bg-green-50 dark:bg-green-950/30')}
        >
          <span
            aria-hidden
            className={cn(
              'inline-flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white',
              option.chosen ? 'bg-green-700' : 'bg-muted-foreground/60',
            )}
          >
            {option.chosen ? '✓' : index + 1}
          </span>
          <div>
            <div className="font-medium">
              {option.title}
              {option.chosen ? <span className="font-semibold text-green-700 dark:text-green-400"> · {copy.chosen}</span> : null}
            </div>
            {option.note ? <div className="mt-0.5 text-xs text-muted-foreground">{option.note}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function LinkedList({ detail, loading }: Readonly<{ detail: DecisionDetail | null; loading: boolean }>) {
  const { t } = useI18n();
  if (loading && !detail) return null;
  if (!detail || detail.links.length === 0) return <p className="text-sm text-muted-foreground">{t.flowGovernance.common.noLinks}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {detail.links.map((link) => (
        <span key={link.id} className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs">
          <span className="text-muted-foreground">{t.flowGovernance.common.linkKinds[link.target.type]}</span>
          <span className="font-semibold">{link.target.code ?? link.target.title}</span>
        </span>
      ))}
    </div>
  );
}

function DecisionDetailView({
  decision,
  detail,
  loading,
  onEdit,
  onDecide,
  onSupersede,
  onDeleted,
  abilities,
  memberName,
}: Readonly<{
  decision: Decision;
  detail: DecisionDetail | null;
  loading: boolean;
  onEdit: (detail: DecisionDetail) => void;
  onDecide: () => void;
  onSupersede: () => void;
  onDeleted: () => void;
  abilities: GovernanceAbilities;
  memberName: (id: string | null) => string;
}>) {
  const { t, format } = useI18n();
  const copy = t.flowGovernance.decisions;
  const formatters = useFormatters();
  const remove = useDeleteDecision();
  const [confirming, setConfirming] = useState(false);

  const sections = copy.sections;
  const row = detail ?? decision;
  const declined = (detail?.approvals ?? []).find((approval) => approval.decision === 'rejected');

  const meta = decisionMeta(row, { copy, format, formatters }, memberName);

  const onDelete = async () => {
    try {
      await remove.mutateAsync(decision.id);
      toast.success(copy.toasts.deleted);
      setConfirming(false);
      onDeleted();
    } catch {
      toast.error(t.flowGovernance.common.deleteFailed);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-muted-foreground">{row.code}</span>
        <Pill tone={STATUS_TONE[row.status]}>{copy.statuses[row.status]}</Pill>
        <div className="flex-1" />
        {detail && abilities.update ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onEdit(detail)}>
            {copy.actions.edit}
          </Button>
        ) : null}
        {abilities.remove ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            {copy.actions.delete}
          </Button>
        ) : null}
      </div>
      <h2 className="mt-2.5 text-xl font-semibold leading-tight">{row.title}</h2>
      <p className="mt-1.5 text-[13px] text-muted-foreground">{meta}</p>

      {row.status === 'proposed' ? (
        <ProposedBanner row={row} declined={declined} canRecord={abilities.update} onDecide={onDecide} memberName={memberName} />
      ) : null}

      {row.status === 'superseded' && detail?.supersededBy ? (
        <div className="mt-4 rounded-lg bg-muted px-3.5 py-3 text-sm text-foreground/80">
          {format(copy.replacedBy, { code: detail.supersededBy.code })}
        </div>
      ) : null}
      {row.status === 'decided' && detail && detail.supersedes.length > 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{format(copy.replaces, { codes: detail.supersedes.map((s) => s.code).join(', ') })}</p>
      ) : null}

      <h3 className="mt-6 mb-1.5 text-[13px] font-semibold text-foreground/80">{sections.context}</h3>
      <p className="leading-relaxed whitespace-pre-line">{row.context || <span className="text-muted-foreground">{copy.noContext}</span>}</p>

      <h3 className="mt-6 mb-2 text-[13px] font-semibold text-foreground/80">{sections.options}</h3>
      <OptionsList options={row.options} />

      <h3 className="mt-6 mb-2 text-[13px] font-semibold text-foreground/80">{sections.consequences}</h3>
      {row.consequences.length === 0 ? (
        <p className="text-sm text-muted-foreground">{copy.noConsequences}</p>
      ) : (
        <ul className="list-disc space-y-1 pl-[1.1rem] leading-relaxed">
          {row.consequences.map((consequence, index) => (
            <li key={index}>{consequence}</li>
          ))}
        </ul>
      )}

      <h3 className="mt-6 mb-2 text-[13px] font-semibold text-foreground/80">{sections.linked}</h3>
      <LinkedList detail={detail} loading={loading} />

      {detail && row.status === 'decided' && abilities.manage ? (
        <div className="mt-6">
          <Button type="button" variant="outline" size="sm" onClick={onSupersede}>
            {copy.actions.supersede}
          </Button>
        </div>
      ) : null}

      <ConfirmDelete open={confirming} code={row.code} pending={remove.isPending} onCancel={() => setConfirming(false)} onConfirm={() => void onDelete()} />
    </div>
  );
}
