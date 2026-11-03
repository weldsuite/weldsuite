/**
 * RAID log rules — kinds, statuses, numbering, conversion, link and field rules
 * and the shapes a register item takes on the wire and in entity events
 * (design: weldflow-project-control.md; ADRs FLOW-010 and FLOW-011).
 *
 * Pure functions, no database and no Hono context. flow-api's
 * `/api/project-raid` and `/api/project-control-links` routes use them, and the
 * Rust flow-domain mirrors them. Every message returned here is sent to the
 * client as it is, so the two backends answer alike.
 */

import type { schema } from '@weldsuite/worker-kit/db';
import {
  RAID_CLOSED_STATUSES,
  RAID_STATUSES,
  type ControlLink,
  type ControlLinkRelation,
  type ControlLinkType,
  type RaidAssessment,
  type RaidItem,
  type RaidKind,
  type RiskBand,
} from '@weldsuite/app-api-client/schemas/project-control';
import type { NumberSequence } from './task-numbering';
import { riskBand, riskScore, residualPairError } from './risk';

export { RAID_CLOSED_STATUSES, RAID_STATUSES };
export type { RaidKind };

type RaidItemRow = typeof schema.projectRaidItems.$inferSelect;
type RaidAssessmentRow = typeof schema.projectRaidAssessments.$inferSelect;
type ControlLinkRow = typeof schema.projectControlLinks.$inferSelect;

// ── Numbering ───────────────────────────────────────────────────────────────

/** The scope key and display prefix of each kind's numbers. */
const SEQUENCES: Readonly<Record<RaidKind, { key: string; prefix: string }>> = {
  risk: { key: 'rsk', prefix: 'RSK-' },
  assumption: { key: 'asm', prefix: 'A-' },
  issue: { key: 'iss', prefix: 'ISS-' },
  dependency: { key: 'dep', prefix: 'DEP-' },
};

/** The counter of one kind in one project: scope `rsk:<projectId>`, prefix `RSK-`. */
export function raidSequence(kind: RaidKind, projectId: string): NumberSequence {
  const { key, prefix } = SEQUENCES[kind];
  return { scope: `${key}:${projectId}`, prefix };
}

/** The display code of an item: `RSK-4`, `A-1`, `ISS-2`, `DEP-3`. */
export function raidCode(kind: RaidKind, number: number): string {
  return `${SEQUENCES[kind].prefix}${number}`;
}

// ── Statuses ────────────────────────────────────────────────────────────────

/** The status a new item of this kind starts in. */
export function initialRaidStatus(kind: RaidKind): string {
  return RAID_STATUSES[kind][0];
}

/** Whether the status ends the item's life in the register (it is then no longer open). */
export function isClosedStatus(kind: RaidKind, status: string): boolean {
  return (RAID_CLOSED_STATUSES[kind] as readonly string[]).includes(status);
}

/**
 * The `closed_at` an item gets when it is written with `status`: the time it
 * first entered a closed status (kept while it stays closed, even across
 * another closed status), null once it is open again.
 */
export function closedAtFor(kind: RaidKind, status: string, currentClosedAt: Date | null, now: Date): Date | null {
  if (!isClosedStatus(kind, status)) return null;
  return currentClosedAt ?? now;
}

// ── Field rules ─────────────────────────────────────────────────────────────

/**
 * Cross-field rules a request can break after the shape check, on the values
 * the item would end up with. Returns the 400 message, or null.
 */
export function raidFieldsError(
  kind: RaidKind,
  projectId: string,
  fields: {
    residualProbability?: number | null;
    residualImpact?: number | null;
    partyType?: string | null;
    partyProjectId?: string | null;
  },
): string | null {
  if (kind === 'risk') return residualPairError(fields.residualProbability, fields.residualImpact);
  if (kind === 'dependency' && fields.partyProjectId) {
    if (fields.partyType !== 'project') return "partyProjectId requires partyType 'project'";
    if (fields.partyProjectId === projectId) return 'A dependency cannot be on its own project';
  }
  return null;
}

// ── Conversion ──────────────────────────────────────────────────────────────

/** What each kind can be converted into: an assumption that proves wrong becomes a risk, a risk that happens an issue. */
const CONVERSIONS: Readonly<Partial<Record<RaidKind, RaidKind>>> = {
  assumption: 'risk',
  risk: 'issue',
};

/** The status the source is closed with: an assumption is `invalid`, a risk `occurred`. */
const SOURCE_STATUS_AFTER_CONVERSION: Readonly<Partial<Record<RaidKind, string>>> = {
  assumption: 'invalid',
  risk: 'occurred',
};

/** The 400 message when `from` cannot be converted to `to`, or null. */
export function conversionError(from: RaidKind, to: RaidKind): string | null {
  const target = CONVERSIONS[from];
  if (!target) return 'Only assumptions and risks can be converted';
  if (target !== to) {
    return from === 'assumption' ? 'An assumption can only be converted to a risk' : 'A risk can only be converted to an issue';
  }
  return null;
}

/**
 * The 400 message when the conversion body carries the wrong fields for its
 * target: a risk needs (and only a risk takes) probability and impact, only an
 * issue takes a severity. Returns null when it is fine.
 */
export function conversionInputError(
  to: 'risk' | 'issue',
  input: { probability?: number; impact?: number; severity?: string },
): string | null {
  if (to === 'issue') {
    const hasRatings = input.probability !== undefined || input.impact !== undefined;
    return hasRatings ? 'probability and impact only apply when converting to a risk' : null;
  }
  if (input.probability === undefined || input.impact === undefined) {
    return 'probability and impact are required to convert to a risk';
  }
  return input.severity === undefined ? null : 'severity only applies when converting to an issue';
}

/** The status the source item ends in after a conversion. */
export function sourceStatusAfterConversion(from: RaidKind): string {
  const status = SOURCE_STATUS_AFTER_CONVERSION[from];
  if (!status) throw new RangeError(`A ${from} cannot be converted`);
  return status;
}

/** The severity of an issue raised from a risk of this band (the two scales share their names). */
export function severityForBand(band: RiskBand): 'low' | 'medium' | 'high' | 'critical' {
  return band;
}

// ── Links ───────────────────────────────────────────────────────────────────

export interface LinkRef {
  type: ControlLinkType;
  id: string;
}

export interface LinkEnd extends LinkRef {
  projectId: string;
  /** The register kind, for a `raid_item`. */
  kind?: RaidKind;
}

/** What a register item can affect or threaten. */
const AFFECTED_TYPES: readonly ControlLinkType[] = ['task', 'milestone', 'deliverable', 'benefit'];

/** What a task or deliverable can implement. */
const IMPLEMENTED_TYPES: readonly ControlLinkType[] = ['decision', 'change_request', 'benefit'];

/**
 * The shape rules of a link, before either end is looked up: two different
 * objects, and the relation going the right way between the right types.
 *
 *   mitigates, resolves   task → raid_item
 *   raised_from           raid_item → raid_item
 *   affects, threatens    raid_item → task, milestone, deliverable or benefit
 *   implements            task or deliverable → decision, change_request or benefit
 *   decided_by            anything but a decision → decision
 *
 * Returns the 400 message, or null.
 */
export function linkShapeError(input: { from: LinkRef; to: LinkRef; relation: ControlLinkRelation }): string | null {
  const { from, to, relation } = input;
  if (from.type === to.type && from.id === to.id) return 'A link needs two different objects';
  switch (relation) {
    case 'mitigates':
    case 'resolves':
      return from.type === 'task' && to.type === 'raid_item'
        ? null
        : `The '${relation}' relation goes from a task to a register item`;
    case 'raised_from':
      return from.type === 'raid_item' && to.type === 'raid_item'
        ? null
        : "The 'raised_from' relation goes from a register item to the register item it was raised from";
    case 'affects':
    case 'threatens':
      return from.type === 'raid_item' && AFFECTED_TYPES.includes(to.type)
        ? null
        : `The '${relation}' relation goes from a register item to a task, milestone, deliverable or benefit`;
    case 'implements':
      return (from.type === 'task' || from.type === 'deliverable') && IMPLEMENTED_TYPES.includes(to.type)
        ? null
        : "The 'implements' relation goes from a task or deliverable to a decision, change request or benefit";
    case 'decided_by':
      return from.type !== 'decision' && to.type === 'decision'
        ? null
        : "The 'decided_by' relation goes from an object to the decision that settled it";
  }
}

/**
 * The rules of a link once both ends are known. A task can only mitigate a
 * risk or resolve an issue, and the ends belong to one project, except that a
 * dependency may affect or threaten a milestone of another project (the caller
 * must be able to write both). Returns the 400 message, or null.
 */
export function linkEndsError(input: { from: LinkEnd; to: LinkEnd; relation: ControlLinkRelation }): string | null {
  const { from, to, relation } = input;
  if (relation === 'mitigates' && to.kind !== 'risk') return 'A task can only mitigate a risk';
  if (relation === 'resolves' && to.kind !== 'issue') return 'A task can only resolve an issue';
  if (from.projectId !== to.projectId) {
    const crossProject = from.type === 'raid_item' && from.kind === 'dependency' && to.type === 'milestone';
    if (!crossProject) return 'Both ends of a link must be in the same project';
  }
  return null;
}

/** The relations that make a task part of an item's progress. */
export const PROGRESS_RELATIONS: readonly ControlLinkRelation[] = ['mitigates', 'resolves'];

// ── Wire shapes ─────────────────────────────────────────────────────────────

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

/**
 * A register item as the routes answer it: the row, with timestamps as ISO
 * strings, plus `code`, `band` and `residualScore` (risks only) and the task
 * progress.
 */
export function presentRaidItem(row: RaidItemRow, taskProgress: { done: number; total: number }): RaidItem {
  const isRisk = row.kind === 'risk';
  const score = isRisk && row.probability !== null && row.impact !== null ? riskScore(row.probability, row.impact) : null;
  const residualScore =
    row.residualProbability !== null && row.residualImpact !== null
      ? riskScore(row.residualProbability, row.residualImpact)
      : null;
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    number: row.number,
    code: raidCode(row.kind, row.number),
    title: row.title,
    description: row.description,
    status: row.status,
    category: row.category,
    ownerId: row.ownerId,
    dueAt: iso(row.dueAt),
    closedAt: iso(row.closedAt),
    customFields: row.customFields,
    probability: row.probability,
    impact: row.impact,
    score,
    band: score === null ? null : riskBand(score),
    residualProbability: row.residualProbability,
    residualImpact: row.residualImpact,
    residualScore,
    strategy: row.strategy,
    trigger: row.trigger,
    costImpact: row.costImpact,
    scheduleImpactDays: row.scheduleImpactDays,
    reviewIntervalDays: row.reviewIntervalDays,
    confidence: row.confidence,
    ifWrong: row.ifWrong,
    severity: row.severity,
    escalatedAt: iso(row.escalatedAt),
    direction: row.direction,
    partyType: row.partyType,
    partyProjectId: row.partyProjectId,
    partyName: row.partyName,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: iso(row.deletedAt),
    taskProgress,
  };
}

/** One assessment of a risk as the routes answer it. */
export function presentRaidAssessment(row: RaidAssessmentRow): RaidAssessment {
  return {
    id: row.id,
    itemId: row.itemId,
    projectId: row.projectId,
    probability: row.probability,
    impact: row.impact,
    score: riskScore(row.probability, row.impact),
    band: riskBand(riskScore(row.probability, row.impact)),
    residualProbability: row.residualProbability,
    residualImpact: row.residualImpact,
    note: row.note,
    assessedBy: row.assessedBy,
    assessedAt: row.assessedAt.toISOString(),
  };
}

/** A link row as the routes answer it. */
export function presentControlLink(row: ControlLinkRow): ControlLink {
  return {
    id: row.id,
    projectId: row.projectId,
    fromType: row.fromType,
    fromId: row.fromId,
    toType: row.toType,
    toId: row.toId,
    relation: row.relation,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

// ── Entity event payloads ───────────────────────────────────────────────────

/**
 * The payload of a `project_raid_item` event: ids and statuses, no free text
 * beyond the title. `score` and `band` are null for anything but a risk.
 */
export function raidEventData(row: RaidItemRow) {
  const score = row.kind === 'risk' && row.probability !== null && row.impact !== null ? riskScore(row.probability, row.impact) : null;
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    number: row.number,
    code: raidCode(row.kind, row.number),
    title: row.title,
    status: row.status,
    ownerId: row.ownerId,
    score,
    band: score === null ? null : riskBand(score),
  };
}

/** The payload of a `project_control_link` event. */
export function controlLinkEventData(row: ControlLinkRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    fromType: row.fromType,
    fromId: row.fromId,
    toType: row.toType,
    toId: row.toId,
    relation: row.relation,
  };
}
