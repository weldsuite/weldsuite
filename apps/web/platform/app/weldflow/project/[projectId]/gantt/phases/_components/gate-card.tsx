import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { GateApproval, PhaseGate } from '@weldsuite/app-api-client/domains/project-schedule';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useRequestGateApproval, useTickCriterion, useWaiveCriterion } from '@/hooks/queries/use-project-schedule-queries';
import { fill, intlLocaleOf, shortDate } from '../../dependencies/_lib/format';
import { describeCriterion, linkHref } from '../_lib/gates';

interface Props {
  projectId: string;
  gate: PhaseGate;
  /** The name of the phase after this one, when there is one. */
  nextName: string | null;
  canManage: boolean;
  /** The current user is the sponsor of the project. */
  isSponsor: boolean;
}

function WaiveDialog({ gate, index, onClose }: Readonly<{ gate: PhaseGate; index: number | null; onClose: () => void }>) {
  const { t } = useI18n();
  const copy = t.flowSchedule.phases;
  const waive = useWaiveCriterion();
  const [note, setNote] = useState('');

  const submit = async () => {
    if (index === null) return;
    try {
      await waive.mutateAsync({ id: gate.id, data: { criterionIndex: index, note: note.trim() } });
      toast.success(copy.states.waived);
      setNote('');
      onClose();
    } catch {
      toast.error(copy.states.waiveFailed);
    }
  };

  return (
    <Dialog open={index !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.gate.waiveTitle}</DialogTitle>
          <DialogDescription>{copy.gate.waiveDescription}</DialogDescription>
        </DialogHeader>
        <label className="grid gap-1 text-sm" htmlFor="waive-note">
          {copy.gate.waiveNote}
          <Textarea id="waive-note" value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} />
        </label>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t.common.actions.cancel}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={note.trim() === '' || waive.isPending}>
            {copy.gate.waiveConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Approvers({ gate }: Readonly<{ gate: PhaseGate }>) {
  const { t } = useI18n();
  const copy = t.flowSchedule.phases.approvers;
  const byApprover = new Map<string, GateApproval>(gate.approvals.map((approval) => [approval.approverId, approval]));
  return (
    <section aria-labelledby="approvers-title" className="rounded-lg border bg-card p-4">
      <h2 id="approvers-title" className="text-sm font-semibold">
        {fill(copy.title, { number: gate.gateNumber })}
      </h2>
      {gate.approverIds.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{copy.none}</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {gate.approverIds.map((approverId, index) => {
            const approval = byApprover.get(approverId);
            return (
              <li key={approverId} className="flex items-center gap-3">
                <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                  {approverId.slice(-2).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{approval?.roleLabel ?? (index === 0 ? copy.sponsor : copy.board)}</div>
                  {approval?.note && <div className="truncate text-xs text-muted-foreground">{approval.note}</div>}
                </div>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {approval ? (copy[approval.decision] ?? approval.decision) : copy.notRequested}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{copy.description}</p>
    </section>
  );
}

function criterionDotClass(satisfied: boolean, blocked: boolean): string {
  if (satisfied) return 'border-emerald-600 bg-emerald-600 text-white';
  return blocked ? 'border-red-600 text-red-600' : 'border-neutral-400';
}

function criterionIcon(satisfied: boolean, blocked: boolean) {
  if (satisfied) return <Check className="size-3" strokeWidth={3.5} />;
  return blocked ? <X className="size-3" strokeWidth={3.5} /> : null;
}

/** The next gate: its criteria with the data behind each, the approval request and who has to approve. */
export function GateCard({ projectId, gate, nextName, canManage, isSponsor }: Readonly<Props>) {
  const { t, language } = useI18n();
  const copy = t.flowSchedule.phases;
  const locale = intlLocaleOf(language);
  const tick = useTickCriterion();
  const request = useRequestGateApproval();
  const [waiveIndex, setWaiveIndex] = useState<number | null>(null);
  const { check } = gate;
  const open = check.total - check.satisfiedCount;
  const waiting = gate.gateRequestedAt !== null;
  const blocked = gate.requestBlockedReason;
  let reason: string | null = null;
  if (blocked) reason = blocked === 'criteria_open' ? fill(copy.gate.blocked.criteria_open, { count: open }) : copy.gate.blocked[blocked];
  let footnote: string | null = reason;
  if (!canManage) footnote = copy.gate.readOnly;
  else if (waiting) footnote = copy.gate.waitingForApproval;
  const title = nextName
    ? fill(copy.gate.title, { number: gate.gateNumber, from: gate.name, to: nextName })
    : fill(copy.gate.titleLast, { number: gate.gateNumber, from: gate.name });
  const percent = check.total === 0 ? 100 : Math.round((check.satisfiedCount / check.total) * 100);

  const submit = async () => {
    try {
      await request.mutateAsync(gate.id);
      toast.success(copy.gate.requested);
    } catch {
      toast.error(copy.gate.requestFailed);
    }
  };

  return (
    <div className="grid content-start gap-4">
      <section aria-labelledby="gate-title" className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{copy.gate.next}</div>
            <h2 id="gate-title" className="text-base font-semibold">
              {title}
            </h2>
            <div className="text-sm text-muted-foreground">{gate.plannedEnd ? fill(copy.gate.planned, { date: shortDate(gate.plannedEnd, locale) }) : copy.gate.noPlanned}</div>
          </div>
          <div className="w-48">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{copy.gate.criteriaMet}</span>
              <span className="tabular-nums">{fill(copy.gate.criteriaCount, { met: check.satisfiedCount, total: check.total })}</span>
            </div>
            <div aria-hidden className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-emerald-600" style={{ width: `${percent}%` }} />
            </div>
          </div>
        </div>

        {check.items.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">{copy.gate.noCriteria}</p>
        ) : (
          <ul className="mt-4 divide-y">
            {check.items.map((item) => {
              const words = describeCriterion(item, { criteria: copy.criteria, editor: copy.editor }, locale);
              const blockedItem = !item.satisfied && item.key === 'no_open_risk_above';
              return (
                <li key={item.index} className="flex items-start gap-3 py-3">
                  <span
                    aria-hidden
                    className={cn(
                      'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2',
                      criterionDotClass(item.satisfied, blockedItem),
                    )}
                  >
                    {criterionIcon(item.satisfied, blockedItem)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{words.title}</span>
                      <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', item.kind === 'manual' ? 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300' : 'bg-muted text-muted-foreground')}>
                        {item.kind === 'manual' ? copy.gate.manual : copy.gate.automatic}
                      </span>
                      {item.waived && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">{copy.gate.waived}</span>}
                    </div>
                    <div className={cn('text-xs', blockedItem ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground')}>
                      {item.waived && item.waiver ? fill(copy.gate.waivedBy, { note: item.waiver.note }) : words.detail}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {item.link && (
                      <Link href={linkHref(projectId, item.link.kind)} className="text-xs underline underline-offset-2">
                        {copy.links[item.link.kind]}
                      </Link>
                    )}
                    {item.kind === 'manual' && canManage && !waiting && (
                      <Button type="button" variant="outline" size="sm" disabled={tick.isPending} onClick={() => tick.mutate({ id: gate.id, index: item.index, met: !item.met }, { onError: () => toast.error(copy.states.tickFailed) })}>
                        {item.met ? copy.gate.markUnmet : copy.gate.markMet}
                      </Button>
                    )}
                    {isSponsor && !item.satisfied && !waiting && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => setWaiveIndex(item.index)}>
                        {copy.gate.waive}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {canManage ? (
            <Button type="button" onClick={() => void submit()} disabled={blocked !== null || request.isPending} aria-describedby="gate-why">
              {request.isPending ? copy.gate.requesting : copy.gate.requestApproval}
            </Button>
          ) : null}
          <span id="gate-why" className="text-xs text-muted-foreground">
            {footnote}
          </span>
        </div>
      </section>

      <Approvers gate={gate} />
      <WaiveDialog gate={gate} index={waiveIndex} onClose={() => setWaiveIndex(null)} />
    </div>
  );
}
