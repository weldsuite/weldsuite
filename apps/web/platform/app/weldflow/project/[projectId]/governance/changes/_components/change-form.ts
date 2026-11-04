import { z } from 'zod';
import type { ChangeRequestDetail, CreateChangeRequestInput } from '@weldsuite/app-api-client/domains/flow-approvals';

export interface ChangeFormCopy {
  titleRequired: string;
  numberInvalid: string;
}

/** The create/edit form. Numbers are typed text so an empty box means "no figure". */
export function changeFormSchema(copy: ChangeFormCopy) {
  const optionalNumber = (integer: boolean) =>
    z.string().refine((value) => {
      if (value.trim() === '') return true;
      const n = Number(value);
      return Number.isFinite(n) && (!integer || Number.isInteger(n));
    }, copy.numberInvalid);
  return z.object({
    title: z.string().trim().min(1, copy.titleRequired).max(255),
    description: z.string().max(10000),
    costDelta: optionalNumber(false),
    scheduleDeltaDays: optionalNumber(true),
    goLive: z.string(),
    milestoneMoves: z.array(z.object({ milestoneId: z.string().min(1), to: z.string().min(1) })),
    addDeliverables: z.array(z.object({ title: z.string().trim().min(1, copy.titleRequired).max(255) })),
  });
}

export type ChangeFormValues = z.infer<ReturnType<typeof changeFormSchema>>;

const dayIso = (day: string) => new Date(`${day}T00:00:00.000Z`).toISOString();
const isoDay = (iso: string) => iso.slice(0, 10);

export function emptyChangeForm(): ChangeFormValues {
  return { title: '', description: '', costDelta: '', scheduleDeltaDays: '', goLive: '', milestoneMoves: [], addDeliverables: [] };
}

/** The form's starting values for an existing change. */
export function changeFormFrom(change: ChangeRequestDetail): ChangeFormValues {
  const plan = (change.planChanges ?? {}) as { goLive?: string | null; milestones?: Array<{ milestoneId: string; to: string }> };
  const scope = (change.scopeChanges ?? {}) as { add?: Array<{ title: string }> };
  return {
    title: change.title,
    description: change.description ?? '',
    costDelta: change.costDelta === null ? '' : String(Number(change.costDelta)),
    scheduleDeltaDays: change.scheduleDeltaDays === null ? '' : String(change.scheduleDeltaDays),
    goLive: plan.goLive ? isoDay(plan.goLive) : '',
    milestoneMoves: (plan.milestones ?? []).map((move) => ({ milestoneId: move.milestoneId, to: isoDay(move.to) })),
    addDeliverables: (scope.add ?? []).map((item) => ({ title: item.title })),
  };
}

/**
 * The request body of a form. Deliverable moves and removals the form has no
 * control for (made through the API) are kept from `existing`, so an edit does
 * not drop them.
 */
export function changeBodyFrom(values: ChangeFormValues, existing?: Pick<ChangeRequestDetail, 'planChanges' | 'scopeChanges'>): Omit<CreateChangeRequestInput, 'projectId'> {
  const kept = (existing?.planChanges ?? {}) as { deliverables?: unknown[] };
  const keptScope = (existing?.scopeChanges ?? {}) as { remove?: string[]; add?: Array<Record<string, unknown>> };
  const milestones = values.milestoneMoves.map((move) => ({ milestoneId: move.milestoneId, to: dayIso(move.to) }));
  const planChanges = {
    ...(values.goLive ? { goLive: dayIso(values.goLive) } : {}),
    ...(milestones.length > 0 ? { milestones } : {}),
    ...(kept.deliverables && kept.deliverables.length > 0 ? { deliverables: kept.deliverables } : {}),
  };
  const added = values.addDeliverables.map((item) => {
    const previous = (keptScope.add ?? []).find((candidate) => candidate.title === item.title);
    return previous ? { title: item.title, description: previous.description, ownerId: previous.ownerId, plannedStart: previous.plannedStart, plannedEnd: previous.plannedEnd } : { title: item.title };
  });
  const scopeChanges = {
    ...(added.length > 0 ? { add: added } : {}),
    ...(keptScope.remove && keptScope.remove.length > 0 ? { remove: keptScope.remove } : {}),
  };
  return {
    title: values.title.trim(),
    description: values.description.trim() ? values.description.trim() : null,
    costDelta: values.costDelta.trim() === '' ? null : Number(values.costDelta),
    scheduleDeltaDays: values.scheduleDeltaDays.trim() === '' ? null : Number(values.scheduleDeltaDays),
    planChanges: Object.keys(planChanges).length > 0 ? (planChanges as never) : null,
    scopeChanges: Object.keys(scopeChanges).length > 0 ? (scopeChanges as never) : null,
  };
}
