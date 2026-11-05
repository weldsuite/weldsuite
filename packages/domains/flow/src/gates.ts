/**
 * Phases and stage gates: the criteria catalogue, the gate check and the rules
 * of the phase lifecycle (design: weldflow-delivery-and-portfolio.md, "Pass a
 * stage gate"; ADR FLOW-017).
 *
 * Pure functions, no database and no clock. A criterion is a key of the
 * catalogue below with parameters (or a manual criterion: free text the
 * project manager ticks). `checkGate` evaluates the criteria over facts the
 * caller read from the project's data; nothing is stored but the result at
 * approval time. flow-api's `/api/project-phases` routes use it and the Rust
 * flow-domain (`gates.rs`) mirrors it, messages and fact shapes included.
 */

import type { GateCriterion, ProjectPhase } from '@weldsuite/db/schema/project-delivery';
import type { Phase } from '@weldsuite/app-api-client/schemas/project-schedule';
import { RISK_BAND_RANGES } from './risk';
import type { RiskBand } from './risk';
import { compareText } from './compare';

export type { GateCriterion };

/** The automatic criteria. Adding one is a code change, here and in Rust. */
export const GATE_CRITERION_KEYS = [
  'deliverable_tasks_done',
  'deliverable_accepted',
  'no_open_risk_above',
  'decision_decided',
  'no_change_request_pending',
  'spend_within_baseline',
] as const;
export type GateCriterionKey = (typeof GATE_CRITERION_KEYS)[number];

export const GATE_RISK_BANDS = ['low', 'medium', 'high', 'critical'] as const satisfies readonly RiskBand[];

export const GATE_MESSAGES = {
  unknownCriterion: 'Unknown gate criterion',
  deliverableRequired: 'This criterion needs a deliverableId',
  decisionRequired: 'This criterion needs a decisionId',
  bandRequired: 'This criterion needs a band: low, medium, high or critical',
  manualTextRequired: 'A manual criterion needs a text',
  invalidCriterion: 'A criterion is a catalogue key with parameters, or a manual text',
  deliverableNotFound: 'A criterion points at a deliverable that does not exist in this project',
  decisionNotFound: 'A criterion points at a decision that does not exist in this project',
  phaseNotActive: 'Only the active phase can request its gate',
  alreadyRequested: 'Approval of this gate has already been requested',
  phasePassed: 'This phase has passed its gate and can no longer be changed',
  notAllSatisfied: 'Not every criterion is met or waived',
  noApprover: 'The project has no sponsor or project manager to approve the gate',
  notSponsor: 'Only the project sponsor can waive a criterion',
  notManager: 'You do not have manage access to this project',
  criterionNotFound: 'This phase has no such criterion',
  alreadyMet: 'This criterion is already met',
  alreadyWaived: 'This criterion has already been waived',
  notManual: 'Only manual criteria can be ticked',
  waiveAfterRequest: 'The gate is already waiting for approval',
  reorderIncomplete: 'List every phase of the project exactly once',
  reorderPassed: 'Passed phases keep their place at the start',
  reorderActive: 'The active phase stays ahead of the phases still to come',
  noteRequired: 'A note is required to waive a criterion',
} as const;

const SPEND_STATUSES = ['approved', 'billed'] as const;
/** Time entries that count as spend to date. */
export const SPEND_TIME_ENTRY_STATUSES: readonly string[] = SPEND_STATUSES;

// ── Criteria ────────────────────────────────────────────────────────────────

export function isManualCriterion(criterion: GateCriterion): criterion is { manual: string; met?: boolean; metAt?: string | null } {
  return typeof (criterion as { manual?: unknown }).manual === 'string';
}

function paramText(params: Record<string, unknown> | undefined, key: string): string | null {
  const value = params?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** The refusal for a criterion of a request, or null when it is a known key with its parameters. */
export function criterionError(criterion: unknown): string | null {
  if (criterion === null || typeof criterion !== 'object' || Array.isArray(criterion)) return GATE_MESSAGES.invalidCriterion;
  const value = criterion as Record<string, unknown>;
  if ('manual' in value) {
    return typeof value.manual === 'string' && value.manual.trim().length > 0 ? null : GATE_MESSAGES.manualTextRequired;
  }
  const key = value.key;
  if (typeof key !== 'string' || !(GATE_CRITERION_KEYS as readonly string[]).includes(key)) return GATE_MESSAGES.unknownCriterion;
  const params = (value.params ?? undefined) as Record<string, unknown> | undefined;
  switch (key as GateCriterionKey) {
    case 'deliverable_tasks_done':
    case 'deliverable_accepted':
      return paramText(params, 'deliverableId') ? null : GATE_MESSAGES.deliverableRequired;
    case 'decision_decided':
      return paramText(params, 'decisionId') ? null : GATE_MESSAGES.decisionRequired;
    case 'no_open_risk_above':
      return (GATE_RISK_BANDS as readonly string[]).includes(paramText(params, 'band') ?? '') ? null : GATE_MESSAGES.bandRequired;
    case 'no_change_request_pending':
    case 'spend_within_baseline':
      return null;
  }
}

/** The first refusal among a phase's criteria, or null. */
export function criteriaError(criteria: readonly unknown[]): string | null {
  for (const criterion of criteria) {
    const refusal = criterionError(criterion);
    if (refusal) return refusal;
  }
  return null;
}

/** A criterion as it is stored: a manual one starts unmet. */
export function normalizeCriterion(criterion: GateCriterion): GateCriterion {
  if (isManualCriterion(criterion)) {
    return { manual: criterion.manual.trim(), met: criterion.met === true, metAt: criterion.met === true ? (criterion.metAt ?? null) : null };
  }
  const params = criterion.params && Object.keys(criterion.params).length > 0 ? criterion.params : undefined;
  return params ? { key: criterion.key, params } : { key: criterion.key };
}

/** What a set of criteria needs read from the project. */
export interface GateFactsNeeded {
  deliverableIds: string[];
  decisionIds: string[];
  risks: boolean;
  changeRequests: boolean;
  spend: boolean;
}

export function gateFactsNeeded(criteria: readonly GateCriterion[]): GateFactsNeeded {
  const needed: GateFactsNeeded = { deliverableIds: [], decisionIds: [], risks: false, changeRequests: false, spend: false };
  for (const criterion of criteria) {
    if (isManualCriterion(criterion)) continue;
    const params = criterion.params;
    switch (criterion.key as GateCriterionKey) {
      case 'deliverable_tasks_done':
      case 'deliverable_accepted': {
        const id = paramText(params, 'deliverableId');
        if (id && !needed.deliverableIds.includes(id)) needed.deliverableIds.push(id);
        break;
      }
      case 'decision_decided': {
        const id = paramText(params, 'decisionId');
        if (id && !needed.decisionIds.includes(id)) needed.decisionIds.push(id);
        break;
      }
      case 'no_open_risk_above':
        needed.risks = true;
        break;
      case 'no_change_request_pending':
        needed.changeRequests = true;
        break;
      case 'spend_within_baseline':
        needed.spend = true;
        break;
    }
  }
  return needed;
}

// ── Facts and the check ─────────────────────────────────────────────────────

export interface GateDeliverableFact {
  id: string;
  number: number;
  title: string;
  status: string;
  /** Live, non-cancelled tasks of the deliverable that are done, and all of them. */
  tasksDone: number;
  tasksTotal: number;
}

export interface GateRiskFact {
  id: string;
  number: number;
  title: string;
  score: number;
}

export interface GateDecisionFact {
  id: string;
  number: number;
  title: string;
  status: string;
  decisionDueAt: string | null;
}

export interface GateChangeFact {
  id: string;
  number: number;
  title: string;
}

export interface GateSpendFact {
  /** Approved time-entry cost to date, a decimal string with two decimals. */
  spent: string;
  /** The latest baseline's budgeted amount, or null when there is none. */
  budget: string | null;
  currency: string | null;
  baselineVersion: number | null;
}

/** What the criteria are evaluated over: only what `gateFactsNeeded` asked for is read. */
export interface GateFacts {
  deliverables: GateDeliverableFact[];
  /** Open risks (not closed, not deleted) of the project. */
  risks: GateRiskFact[];
  decisions: GateDecisionFact[];
  /** Change requests waiting for approval. */
  changeRequests: GateChangeFact[];
  spend: GateSpendFact | null;
}

export const EMPTY_GATE_FACTS: Readonly<GateFacts> = {
  deliverables: [],
  risks: [],
  decisions: [],
  changeRequests: [],
  spend: null,
};

/** Where the data behind a criterion lives; the UI maps it to a page. */
export type GateLinkKind = 'tasks' | 'deliverable' | 'raid' | 'decision' | 'change_requests' | 'finance';

export interface GateLink {
  kind: GateLinkKind;
  id: string | null;
}

export interface GateWaiver {
  index: number;
  note: string;
  by: string;
  at: string;
}

export interface GateCheckItem {
  /** Position in the phase's `gateCriteria`. */
  index: number;
  kind: 'automatic' | 'manual';
  /** The catalogue key; null for a manual criterion. */
  key: string | null;
  /** The text of a manual criterion. */
  text: string | null;
  params: Record<string, unknown> | null;
  /** The data says it is met (or the manager ticked it). */
  met: boolean;
  /** Not met, but the sponsor waived it. */
  waived: boolean;
  waiver: GateWaiver | null;
  /** Met or waived. */
  satisfied: boolean;
  /** What was found, for the screen to word: counts, codes, titles, amounts. */
  facts: Record<string, unknown>;
  link: GateLink | null;
}

export interface GateCheck {
  items: GateCheckItem[];
  total: number;
  metCount: number;
  waivedCount: number;
  satisfiedCount: number;
  allSatisfied: boolean;
}

const deliverableCode = (number: number) => `D${number}`;
const riskCode = (number: number) => `RSK-${number}`;
const decisionCode = (number: number) => `DEC-${number}`;
const changeCode = (number: number) => `CR-${number}`;

/** Amounts as the numeric columns hold them; an unreadable one counts as 0. */
function amount(value: string | null): number {
  const parsed = value === null ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface Evaluation {
  met: boolean;
  facts: Record<string, unknown>;
  link: GateLink | null;
}

function evaluate(criterion: GateCriterion, facts: GateFacts): Evaluation {
  if (isManualCriterion(criterion)) return { met: criterion.met === true, facts: { metAt: criterion.metAt ?? null }, link: null };
  const params = criterion.params;
  switch (criterion.key as GateCriterionKey) {
    case 'deliverable_tasks_done': {
      const id = paramText(params, 'deliverableId') ?? '';
      const found = facts.deliverables.find((d) => d.id === id);
      if (!found) return { met: false, facts: { deliverableId: id, missing: true }, link: { kind: 'tasks', id } };
      return {
        met: found.tasksTotal > 0 && found.tasksDone === found.tasksTotal,
        facts: { deliverableId: id, code: deliverableCode(found.number), title: found.title, done: found.tasksDone, total: found.tasksTotal },
        link: { kind: 'tasks', id },
      };
    }
    case 'deliverable_accepted': {
      const id = paramText(params, 'deliverableId') ?? '';
      const found = facts.deliverables.find((d) => d.id === id);
      if (!found) return { met: false, facts: { deliverableId: id, missing: true }, link: { kind: 'deliverable', id } };
      return {
        met: found.status === 'accepted',
        facts: { deliverableId: id, code: deliverableCode(found.number), title: found.title, status: found.status },
        link: { kind: 'deliverable', id },
      };
    }
    case 'no_open_risk_above': {
      const band = (paramText(params, 'band') ?? 'critical') as RiskBand;
      const floor = RISK_BAND_RANGES[band]?.min ?? RISK_BAND_RANGES.critical.min;
      const over = facts.risks
        .filter((risk) => risk.score >= floor)
        .sort((a, b) => b.score - a.score || a.number - b.number || compareText(a.id, b.id));
      const top = over[0] ?? null;
      return {
        met: over.length === 0,
        facts: {
          band,
          count: over.length,
          top: top ? { id: top.id, code: riskCode(top.number), title: top.title, score: top.score } : null,
        },
        link: { kind: 'raid', id: top?.id ?? null },
      };
    }
    case 'decision_decided': {
      const id = paramText(params, 'decisionId') ?? '';
      const found = facts.decisions.find((d) => d.id === id);
      if (!found) return { met: false, facts: { decisionId: id, missing: true }, link: { kind: 'decision', id } };
      return {
        met: found.status === 'decided' || found.status === 'superseded',
        facts: { decisionId: id, code: decisionCode(found.number), title: found.title, status: found.status, decisionDueAt: found.decisionDueAt },
        link: { kind: 'decision', id },
      };
    }
    case 'no_change_request_pending': {
      const first = facts.changeRequests[0] ?? null;
      return {
        met: facts.changeRequests.length === 0,
        facts: {
          count: facts.changeRequests.length,
          first: first ? { id: first.id, code: changeCode(first.number), title: first.title } : null,
        },
        link: { kind: 'change_requests', id: first?.id ?? null },
      };
    }
    case 'spend_within_baseline': {
      const spend = facts.spend;
      if (!spend || spend.budget === null) {
        return {
          met: false,
          facts: { spent: spend?.spent ?? '0.00', budget: null, currency: spend?.currency ?? null, baselineVersion: spend?.baselineVersion ?? null },
          link: { kind: 'finance', id: null },
        };
      }
      return {
        met: amount(spend.spent) <= amount(spend.budget),
        facts: { spent: spend.spent, budget: spend.budget, currency: spend.currency, baselineVersion: spend.baselineVersion },
        link: { kind: 'finance', id: null },
      };
    }
    default:
      return { met: false, facts: { unknownKey: criterion.key }, link: null };
  }
}

/**
 * Evaluate a phase's criteria over the facts. A waiver (by criterion position)
 * counts for a criterion that is not met; a met one is simply met.
 */
export function checkGate(criteria: readonly GateCriterion[], facts: GateFacts, waivers: readonly GateWaiver[] = []): GateCheck {
  const items = criteria.map((criterion, index): GateCheckItem => {
    const result = evaluate(criterion, facts);
    const waiver = waivers.find((w) => w.index === index) ?? null;
    const waived = !result.met && waiver !== null;
    const manual = isManualCriterion(criterion);
    return {
      index,
      kind: manual ? 'manual' : 'automatic',
      key: manual ? null : criterion.key,
      text: manual ? criterion.manual : null,
      params: manual ? null : (criterion.params ?? null),
      met: result.met,
      waived,
      waiver: waived ? waiver : null,
      satisfied: result.met || waived,
      facts: result.facts,
      link: result.link,
    };
  });
  const metCount = items.filter((item) => item.met).length;
  const waivedCount = items.filter((item) => item.waived).length;
  return {
    items,
    total: items.length,
    metCount,
    waivedCount,
    satisfiedCount: metCount + waivedCount,
    allSatisfied: items.every((item) => item.satisfied),
  };
}

/** The result stored on the phase when a gate is requested and when it is decided. */
export function gateResultOf(check: GateCheck, criteria: readonly GateCriterion[], waivers: readonly GateWaiver[], checkedAt: string) {
  return {
    checkedAt,
    criteria: check.items.map((item) => ({ criterion: criteria[item.index], met: item.met, detail: item.facts })),
    waived: waivers.filter((w) => check.items[w.index] !== undefined).map((w) => ({ index: w.index, note: w.note, by: w.by, at: w.at })),
  };
}

// ── Phase lifecycle ─────────────────────────────────────────────────────────

export interface PhaseLike {
  id: string;
  position: number;
  status: string;
}

/**
 * The phase that has to become active so the project always has one: when no
 * phase is active, the first upcoming one (by position, then id). Null when
 * one is active already or nothing is left to start.
 */
export function phaseToActivate(phases: readonly PhaseLike[]): string | null {
  if (phases.some((phase) => phase.status === 'active')) return null;
  const upcoming = phases
    .filter((phase) => phase.status === 'upcoming')
    .sort((a, b) => a.position - b.position || compareText(a.id, b.id));
  return upcoming[0]?.id ?? null;
}

/** The phase after `phaseId` that is still to come (by position, then id), or null. */
export function nextUpcomingPhase(phases: readonly PhaseLike[], phaseId: string): string | null {
  const ordered = [...phases].sort((a, b) => a.position - b.position || compareText(a.id, b.id));
  const at = ordered.findIndex((phase) => phase.id === phaseId);
  if (at < 0) return null;
  return ordered.slice(at + 1).find((phase) => phase.status === 'upcoming')?.id ?? null;
}

/**
 * The refusal for a reorder: every live phase exactly once, the passed phases
 * first, in the order they had, then the active phase ahead of every upcoming
 * one. `nextUpcomingPhase` only looks after the phase that just passed, so an
 * upcoming phase placed before the active one would never be started.
 */
export function reorderError(phases: readonly PhaseLike[], ids: readonly string[]): string | null {
  const live = new Set(phases.map((phase) => phase.id));
  if (ids.length !== live.size || new Set(ids).size !== ids.length || ids.some((id) => !live.has(id))) {
    return GATE_MESSAGES.reorderIncomplete;
  }
  const passed = [...phases]
    .filter((phase) => phase.status === 'passed')
    .sort((a, b) => a.position - b.position || compareText(a.id, b.id))
    .map((phase) => phase.id);
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const leading = ids.slice(0, passed.length);
  const restPassed = ids.slice(passed.length).some((id) => byId.get(id)?.status === 'passed');
  if (restPassed || leading.some((id, index) => id !== passed[index])) return GATE_MESSAGES.reorderPassed;
  const activeAt = ids.findIndex((id) => byId.get(id)?.status === 'active');
  if (activeAt >= 0 && ids.slice(0, activeAt).some((id) => byId.get(id)?.status === 'upcoming')) {
    return GATE_MESSAGES.reorderActive;
  }
  return null;
}

/** Why a gate cannot be requested (in the order the checks run). */
export type GateRequestBlock = 'phase_passed' | 'phase_not_active' | 'already_requested' | 'criteria_open' | 'no_approver';

export const GATE_REQUEST_BLOCK_MESSAGES: Readonly<Record<GateRequestBlock, string>> = {
  phase_passed: GATE_MESSAGES.phasePassed,
  phase_not_active: GATE_MESSAGES.phaseNotActive,
  already_requested: GATE_MESSAGES.alreadyRequested,
  criteria_open: GATE_MESSAGES.notAllSatisfied,
  no_approver: GATE_MESSAGES.noApprover,
};

/** The phase's gate, as a request for approval sees it: `null` when it can be requested, else why not. */
export function gateRequestBlock(
  phase: { status: string; gateRequestedAt: Date | null },
  check: Pick<GateCheck, 'allSatisfied'>,
  hasApprover: boolean,
): GateRequestBlock | null {
  if (phase.status === 'passed') return 'phase_passed';
  if (phase.status !== 'active') return 'phase_not_active';
  if (phase.gateRequestedAt !== null) return 'already_requested';
  if (!check.allSatisfied) return 'criteria_open';
  if (!hasApprover) return 'no_approver';
  return null;
}

/** The refusal message of {@link gateRequestBlock}, or null. */
export function gateRequestError(
  phase: { status: string; gateRequestedAt: Date | null },
  check: Pick<GateCheck, 'allSatisfied'>,
  hasApprover: boolean,
): string | null {
  const block = gateRequestBlock(phase, check, hasApprover);
  return block ? GATE_REQUEST_BLOCK_MESSAGES[block] : null;
}

/** The gate approvers: the sponsor, and the first change board member when there is one and it is someone else. */
export function gateApproverIds(sponsor: string | null, boardMemberIds: readonly string[] | undefined): string[] {
  if (!sponsor) return [];
  const board = boardMemberIds?.[0];
  return board && board !== sponsor ? [sponsor, board] : [sponsor];
}

// ── Presenting ──────────────────────────────────────────────────────────────

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/** A phase as every route answers it. */
export function presentPhase(row: ProjectPhase): Phase {
  return {
    id: row.id,
    projectId: row.projectId,
    position: row.position,
    name: row.name,
    plannedStart: iso(row.plannedStart),
    plannedEnd: iso(row.plannedEnd),
    status: row.status,
    gateCriteria: row.gateCriteria as Phase['gateCriteria'],
    gateResult: (row.gateResult ?? null) as Phase['gateResult'],
    gateRequestedAt: iso(row.gateRequestedAt),
    passedAt: iso(row.passedAt),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The entity-event payload of a phase. */
export function phaseEventData(row: ProjectPhase, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    status: row.status,
    position: row.position,
    plannedStart: iso(row.plannedStart),
    plannedEnd: iso(row.plannedEnd),
    ...extra,
  };
}
