import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import type { PhaseSummary, ScheduleDeliverable } from '@weldsuite/app-api-client/domains/project-schedule';
import { useI18n } from '@/lib/i18n/provider';
import { useCreatePhase, useDeletePhase, useReorderPhases, useUpdatePhase } from '@/hooks/queries/use-project-schedule-queries';
import { FIELD_CLASS } from '../../dependencies/_components/add-dependency-dialog';
import {
  CRITERION_KINDS,
  criteriaChanged,
  criterionOf,
  draftComplete,
  draftOf,
  emptyCriterion,
  moveItem,
  type CriterionDraft,
  type CriterionKind,
} from '../_lib/gates';

interface PhaseDraft {
  /** Absent for a phase that does not exist yet. */
  id?: string;
  key: string;
  name: string;
  start: string;
  end: string;
  criteria: CriterionDraft[];
  passed: boolean;
  gateRequested: boolean;
  removed: boolean;
}

export interface DecisionOption {
  id: string;
  label: string;
}

const dateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
const isoOf = (date: string) => (date ? `${date}T00:00:00.000Z` : null);

function draftsOf(phases: readonly PhaseSummary[]): PhaseDraft[] {
  return phases.map((phase) => ({
    id: phase.id,
    key: phase.id,
    name: phase.name,
    start: dateInput(phase.plannedStart),
    end: dateInput(phase.plannedEnd),
    criteria: phase.gateCriteria.map(draftOf),
    passed: phase.status === 'passed',
    gateRequested: phase.gateRequestedAt !== null,
    removed: false,
  }));
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  phases: readonly PhaseSummary[];
  deliverables: readonly ScheduleDeliverable[];
  decisions: readonly DecisionOption[];
}

function CriterionRow({
  draft,
  locked,
  deliverables,
  decisions,
  onChange,
  onRemove,
}: Readonly<{
  draft: CriterionDraft;
  locked: boolean;
  deliverables: readonly ScheduleDeliverable[];
  decisions: readonly DecisionOption[];
  onChange: (next: CriterionDraft) => void;
  onRemove: () => void;
}>) {
  const { t } = useI18n();
  const copy = t.flowSchedule.phases.editor;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label={copy.criteria}
        className={`${FIELD_CLASS} sm:w-64`}
        value={draft.kind}
        disabled={locked}
        onChange={(event) => onChange({ ...emptyCriterion(event.target.value as CriterionKind), text: draft.text })}
      >
        {CRITERION_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {copy.criterionKeys[kind]}
          </option>
        ))}
      </select>
      {draft.kind === 'manual' && (
        <input aria-label={copy.manualText} placeholder={copy.manualText} className={`${FIELD_CLASS} min-w-48 flex-1`} maxLength={500} value={draft.text} disabled={locked} onChange={(event) => onChange({ ...draft, text: event.target.value })} />
      )}
      {(draft.kind === 'deliverable_tasks_done' || draft.kind === 'deliverable_accepted') && (
        <select aria-label={copy.deliverable} className={`${FIELD_CLASS} min-w-40 flex-1`} value={draft.deliverableId} disabled={locked} onChange={(event) => onChange({ ...draft, deliverableId: event.target.value })}>
          <option value="">{deliverables.length === 0 ? copy.noDeliverables : copy.pick}</option>
          {deliverables.map((deliverable) => (
            <option key={deliverable.id} value={deliverable.id}>
              {`${deliverable.code} ${deliverable.title}`}
            </option>
          ))}
        </select>
      )}
      {draft.kind === 'decision_decided' && (
        <select aria-label={copy.decision} className={`${FIELD_CLASS} min-w-40 flex-1`} value={draft.decisionId} disabled={locked} onChange={(event) => onChange({ ...draft, decisionId: event.target.value })}>
          <option value="">{decisions.length === 0 ? copy.noDecisions : copy.pick}</option>
          {decisions.map((decision) => (
            <option key={decision.id} value={decision.id}>
              {decision.label}
            </option>
          ))}
        </select>
      )}
      {draft.kind === 'no_open_risk_above' && (
        <select aria-label={copy.band} className={`${FIELD_CLASS} w-36`} value={draft.band} disabled={locked} onChange={(event) => onChange({ ...draft, band: event.target.value })}>
          {(['low', 'medium', 'high', 'critical'] as const).map((band) => (
            <option key={band} value={band}>
              {copy.bands[band]}
            </option>
          ))}
        </select>
      )}
      <Button type="button" variant="ghost" size="icon" aria-label={copy.removeCriterion} disabled={locked} onClick={onRemove}>
        <Trash2 aria-hidden className="size-4" />
      </Button>
    </div>
  );
}

interface SaveContext {
  projectId: string;
  phases: readonly PhaseSummary[];
  create: ReturnType<typeof useCreatePhase>;
  update: ReturnType<typeof useUpdatePhase>;
  remove: ReturnType<typeof useDeletePhase>;
}

type PhaseUpdate = Parameters<ReturnType<typeof useUpdatePhase>['mutateAsync']>[0]['data'];

function changedFields(draft: PhaseDraft, stored: PhaseSummary): PhaseUpdate {
  const data: PhaseUpdate = {};
  if (draft.name.trim() !== stored.name) data.name = draft.name.trim();
  if (draft.start !== dateInput(stored.plannedStart)) data.plannedStart = isoOf(draft.start);
  if (draft.end !== dateInput(stored.plannedEnd)) data.plannedEnd = isoOf(draft.end);
  if (!draft.gateRequested && criteriaChanged(stored.gateCriteria, draft.criteria)) data.gateCriteria = draft.criteria.map(criterionOf);
  return data;
}

/** Write one draft to the API; resolves to the id the phase takes in the order, or null when it has none. */
async function syncDraft(draft: PhaseDraft, ctx: SaveContext): Promise<string | null> {
  if (draft.removed) {
    if (draft.id) await ctx.remove.mutateAsync(draft.id);
    return null;
  }
  if (draft.passed) return draft.id ?? null;
  const stored = ctx.phases.find((phase) => phase.id === draft.id);
  if (!stored) {
    const created = await ctx.create.mutateAsync({
      projectId: ctx.projectId,
      name: draft.name.trim(),
      plannedStart: isoOf(draft.start),
      plannedEnd: isoOf(draft.end),
      gateCriteria: draft.criteria.map(criterionOf),
    });
    return created.data.id;
  }
  const data = changedFields(draft, stored);
  if (Object.keys(data).length > 0) await ctx.update.mutateAsync({ id: stored.id, data });
  return stored.id;
}

/** Edit the lifecycle: add, rename, re-date, reorder and remove phases, and the criteria of each gate. Saved in one go. */
export function PhaseEditor({ open, onOpenChange, projectId, phases, deliverables, decisions }: Readonly<Props>) {
  const { t } = useI18n();
  const copy = t.flowSchedule.phases.editor;
  const [drafts, setDrafts] = useState<PhaseDraft[]>(() => draftsOf(phases));
  const [saving, setSaving] = useState(false);
  const create = useCreatePhase();
  const update = useUpdatePhase();
  const remove = useDeletePhase();
  const reorder = useReorderPhases();

  useEffect(() => {
    if (open) setDrafts(draftsOf(phases));
    // Reopening starts from what is stored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const change = (key: string, patch: Partial<PhaseDraft>) => setDrafts((all) => all.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  const live = drafts.filter((draft) => !draft.removed);
  const valid = live.every((draft) => draft.name.trim() !== '' && draft.criteria.every(draftComplete) && !(draft.start && draft.end && draft.end < draft.start));

  const save = async () => {
    setSaving(true);
    try {
      const order: string[] = [];
      for (const draft of drafts) {
        const id = await syncDraft(draft, { projectId, phases, create, update, remove });
        if (id) order.push(id);
      }
      if (order.length > 1) await reorder.mutateAsync({ projectId, ids: order });
      onOpenChange(false);
    } catch {
      toast.error(copy.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {live.map((draft, index) => (
            <fieldset key={draft.key} className="grid gap-3 rounded-lg border p-3" disabled={draft.passed}>
              <legend className="px-1 text-xs text-muted-foreground">{draft.passed ? copy.passedLocked : `${index + 1}`}</legend>
              <div className="flex flex-wrap items-end gap-2">
                <label className="grid min-w-40 flex-1 gap-1 text-xs text-muted-foreground">
                  {copy.name}
                  <input className={FIELD_CLASS} maxLength={255} value={draft.name} onChange={(event) => change(draft.key, { name: event.target.value })} />
                </label>
                <label className="grid gap-1 text-xs text-muted-foreground">
                  {copy.start}
                  <input type="date" className={FIELD_CLASS} value={draft.start} onChange={(event) => change(draft.key, { start: event.target.value })} />
                </label>
                <label className="grid gap-1 text-xs text-muted-foreground">
                  {copy.end}
                  <input type="date" className={FIELD_CLASS} value={draft.end} min={draft.start || undefined} onChange={(event) => change(draft.key, { end: event.target.value })} />
                </label>
                {!draft.passed && (
                  <div className="flex gap-1">
                    <Button type="button" variant="ghost" size="icon" aria-label={copy.moveUp} disabled={index === 0 || live[index - 1].passed} onClick={() => setDrafts((all) => reorderLive(all, draft.key, -1))}>
                      <ArrowUp aria-hidden className="size-4" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon" aria-label={copy.moveDown} disabled={index === live.length - 1} onClick={() => setDrafts((all) => reorderLive(all, draft.key, 1))}>
                      <ArrowDown aria-hidden className="size-4" />
                    </Button>
                    <Button type="button" variant="ghost" size="icon" aria-label={copy.remove} onClick={() => (draft.id ? change(draft.key, { removed: true }) : setDrafts((all) => all.filter((other) => other.key !== draft.key)))}>
                      <Trash2 aria-hidden className="size-4" />
                    </Button>
                  </div>
                )}
              </div>
              <div className="grid gap-2">
                <div className="text-xs font-medium text-muted-foreground">{copy.criteria}</div>
                {draft.gateRequested && !draft.passed && <p className="text-xs text-muted-foreground">{copy.lockedCriteria}</p>}
                {draft.criteria.map((criterion, at) => (
                  <CriterionRow
                    key={at}
                    draft={criterion}
                    locked={draft.passed || draft.gateRequested}
                    deliverables={deliverables}
                    decisions={decisions}
                    onChange={(next) => change(draft.key, { criteria: draft.criteria.map((entry, i) => (i === at ? next : entry)) })}
                    onRemove={() => change(draft.key, { criteria: draft.criteria.filter((_, i) => i !== at) })}
                  />
                ))}
                {!draft.passed && !draft.gateRequested && (
                  <div>
                    <Button type="button" variant="outline" size="sm" onClick={() => change(draft.key, { criteria: [...draft.criteria, emptyCriterion('manual')] })}>
                      <Plus aria-hidden className="size-3.5" />
                      {copy.addCriterion}
                    </Button>
                  </div>
                )}
              </div>
            </fieldset>
          ))}
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setDrafts((all) => [
                  ...all,
                  { key: `new-${all.length}-${Date.now()}`, name: copy.newPhaseName, start: '', end: '', criteria: [], passed: false, gateRequested: false, removed: false },
                ])
              }
            >
              <Plus aria-hidden className="size-4" />
              {copy.add}
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {copy.close}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!valid || saving}>
            {copy.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Move a phase among the live ones by one place, keeping the removed ones where they are. */
function reorderLive(all: readonly PhaseDraft[], key: string, delta: number): PhaseDraft[] {
  const liveKeys = all.filter((draft) => !draft.removed).map((draft) => draft.key);
  const moved = moveItem(liveKeys, liveKeys.indexOf(key), delta);
  const byKey = new Map(all.map((draft) => [draft.key, draft]));
  let at = 0;
  return all.map((draft) => (draft.removed ? draft : (byKey.get(moved[at++]) as PhaseDraft)));
}
