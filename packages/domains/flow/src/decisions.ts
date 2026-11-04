/**
 * Decision log rules: numbering, the fields a decision may carry in each
 * status, deciding, superseding, the approval a named decider is asked for and
 * the shapes a decision takes on the wire and in entity events (design:
 * weldflow-project-control.md; ADRs FLOW-011 and FLOW-016).
 *
 * Pure functions, no database and no Hono context. flow-api's
 * `/api/project-decisions` routes use them, and the Rust flow-domain mirrors
 * them. Every message returned here is sent to the client as it is, so the two
 * backends answer alike.
 */

import type { schema } from '@weldsuite/worker-kit/db';
import type {
  Decision,
  DecisionApproval,
  DecisionOptionInput,
} from '@weldsuite/app-api-client/schemas/project-governance';
import type { ApprovalRowInput, ApprovalRow } from './approvals';
import type { NumberSequence } from './task-numbering';

type DecisionRow = typeof schema.projectDecisions.$inferSelect;
type ApprovalRowDb = ApprovalRow;

/** One option as it is stored: every field present. */
export interface StoredDecisionOption {
  title: string;
  note: string | null;
  chosen: boolean;
}

export const DECISION_MESSAGES = {
  oneChosen: 'Only one option can be chosen',
  chooseTaken: 'Choose the option that was taken',
  noSuchOption: 'The chosen option does not exist',
  proposedOnly: 'deciderId and decisionDueAt only apply to a proposed decision',
  decidedOnly: 'decidedBy and decidedAt only apply to a decided decision',
  alreadyDecided: 'This decision has already been decided',
  supersededNotDecidable: 'A superseded decision cannot be decided',
  notDeciderOrManager: 'Only the project manager or the named decider can record a decision',
  decidedEdit: 'A decided or superseded decision can only change its title, context and consequences',
  notDecided: 'Only a decided decision can be superseded',
  alreadySuperseded: 'This decision has already been superseded',
  selfSupersede: 'A decision cannot replace itself',
  otherProject: 'The replacing decision must be in the same project',
  supersederSuperseded: 'A superseded decision cannot replace another',
} as const;

// ── Numbering ───────────────────────────────────────────────────────────────

/** The counter of a project's decisions: scope `dec:<projectId>`, prefix `DEC-`. */
export function decisionSequence(projectId: string): NumberSequence {
  return { scope: `dec:${projectId}`, prefix: 'DEC-' };
}

/** The display code of a decision: `DEC-7`. */
export function decisionCode(number: number): string {
  return `DEC-${number}`;
}

// ── Options ─────────────────────────────────────────────────────────────────

/** Options as they are stored: a missing note is null and a missing `chosen` is false. */
export function normalizeOptions(options: readonly DecisionOptionInput[] | undefined): StoredDecisionOption[] {
  return (options ?? []).map((option) => ({
    title: option.title,
    note: option.note ?? null,
    chosen: option.chosen === true,
  }));
}

/** The same options with exactly the one at `index` chosen. */
export function chooseOption(options: readonly StoredDecisionOption[], index: number): StoredDecisionOption[] {
  return options.map((option, position) => ({ ...option, chosen: position === index }));
}

/** More than one option marked chosen is a mistake in any status. */
export function optionsError(options: readonly StoredDecisionOption[]): string | null {
  return options.filter((option) => option.chosen).length > 1 ? DECISION_MESSAGES.oneChosen : null;
}

/** Whether one of the options is marked as the one taken. */
export function hasChosenOption(options: readonly StoredDecisionOption[]): boolean {
  return options.some((option) => option.chosen);
}

// ── Create and edit ─────────────────────────────────────────────────────────

/**
 * The cross-field rules of a new decision, after the shape check. A decided
 * decision has the option that was taken (when there are options) and no
 * decider to ask; a proposed one has no decider of record yet.
 */
export function decisionCreateError(input: {
  status: 'proposed' | 'decided';
  options: readonly StoredDecisionOption[];
  deciderId?: string | null;
  decisionDueAt?: string | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
}): string | null {
  const options = optionsError(input.options);
  if (options) return options;
  if (input.status === 'decided') {
    if (input.deciderId || input.decisionDueAt) return DECISION_MESSAGES.proposedOnly;
    if (input.options.length > 0 && !hasChosenOption(input.options)) return DECISION_MESSAGES.chooseTaken;
    return null;
  }
  if (input.decidedBy || input.decidedAt) return DECISION_MESSAGES.decidedOnly;
  return null;
}

/** The refusal (409) of an edit that changes more than a decided decision allows, or null. */
export function decisionEditLockedError(
  status: string,
  body: { options?: unknown; deciderId?: unknown; decisionDueAt?: unknown },
): string | null {
  if (status === 'proposed') return null;
  const locked = body.options !== undefined || body.deciderId !== undefined || body.decisionDueAt !== undefined;
  return locked ? DECISION_MESSAGES.decidedEdit : null;
}

/** The time a stored date or an ISO string stands for, in milliseconds (null when absent). */
function millis(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * Whether editing a proposed decision asks for its approval again: the named
 * decider or the due date changed, or the decider already declined (editing a
 * declined proposal sends it back to the decider).
 */
export function needsRerouting(input: {
  existingDeciderId: string | null;
  nextDeciderId: string | null;
  existingDueAt: Date | null;
  nextDueAt: Date | null;
  approvals: readonly Pick<ApprovalRowDb, 'decision'>[];
}): boolean {
  if (input.existingDeciderId !== input.nextDeciderId) return true;
  if (millis(input.existingDueAt) !== millis(input.nextDueAt)) return true;
  return input.approvals.some((approval) => approval.decision === 'rejected');
}

// ── Deciding and superseding ────────────────────────────────────────────────

/** The refusal (409) of deciding a decision that is not proposed, or null. */
export function decideStateError(status: string): string | null {
  if (status === 'decided') return DECISION_MESSAGES.alreadyDecided;
  if (status === 'superseded') return DECISION_MESSAGES.supersededNotDecidable;
  return null;
}

/**
 * The refusal (400) of the body of a decide, or null: with options the one
 * taken has to be named (or already marked), and has to exist.
 */
export function decideInputError(options: readonly StoredDecisionOption[], chosenIndex: number | undefined): string | null {
  if (chosenIndex !== undefined && chosenIndex >= options.length) return DECISION_MESSAGES.noSuchOption;
  if (options.length > 0 && chosenIndex === undefined && !hasChosenOption(options)) return DECISION_MESSAGES.chooseTaken;
  return null;
}

/** The options once a decision is taken: the named one chosen, else as they were. */
export function optionsAfterDecide(options: readonly StoredDecisionOption[], chosenIndex: number | undefined): StoredDecisionOption[] {
  return chosenIndex === undefined ? [...options] : chooseOption(options, chosenIndex);
}

/** The member who may record a decision: the project manager, or the named decider (who is in the project). */
export function mayRecordDecision(input: { isManager: boolean; isNamedDecider: boolean }): boolean {
  return input.isManager || input.isNamedDecider;
}

/** The refusal (409) of superseding a decision that is not decided, or null. */
export function supersedeSourceError(status: string): string | null {
  if (status === 'superseded') return DECISION_MESSAGES.alreadySuperseded;
  return status === 'decided' ? null : DECISION_MESSAGES.notDecided;
}

/** The refusal of the replacing decision (400, or 409 when it is itself superseded), or null. */
export function supersedeTargetError(
  source: { id: string; projectId: string },
  target: { id: string; projectId: string; status: string },
): { status: 400 | 409; message: string } | null {
  if (source.id === target.id) return { status: 400, message: DECISION_MESSAGES.selfSupersede };
  if (source.projectId !== target.projectId) return { status: 400, message: DECISION_MESSAGES.otherProject };
  if (target.status === 'superseded') return { status: 409, message: DECISION_MESSAGES.supersederSuperseded };
  return null;
}

// ── Approvals ───────────────────────────────────────────────────────────────

/** The approval a proposed decision asks of its named decider (rule `decision`, FLOW-016). */
export function decisionApprovalRows(deciderId: string, dueAt: Date | null): ApprovalRowInput[] {
  return [
    {
      approverId: deciderId,
      roleLabel: 'Decider',
      step: 1,
      rule: { code: 'decision', params: { rule: 'named_decider' } },
      dueAt,
    },
  ];
}

/**
 * What a settled approval does to the decision. Approved: it becomes decided,
 * by the member who answered (the decider or their delegate), as of `now`.
 * Rejected: nothing, it stays proposed and the answer's note stays on the
 * approval row. Null means leave the row alone.
 */
export function decisionResolution(
  outcome: 'approved' | 'rejected',
  actorId: string | null,
  fallbackDeciderId: string | null,
  now: Date,
): { status: 'decided'; decidedBy: string | null; decidedAt: Date } | null {
  if (outcome !== 'approved') return null;
  return { status: 'decided', decidedBy: actorId ?? fallbackDeciderId, decidedAt: now };
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

/** A decision as the routes answer it. */
export function presentDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    code: decisionCode(row.number),
    title: row.title,
    status: row.status,
    context: row.context,
    options: normalizeOptions(row.options),
    consequences: row.consequences,
    deciderId: row.deciderId,
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt),
    decisionDueAt: iso(row.decisionDueAt),
    supersededById: row.supersededById,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: iso(row.deletedAt),
  };
}

/** One approver's answer on a proposed decision. */
export function presentDecisionApproval(row: ApprovalRowDb): DecisionApproval {
  return {
    id: row.id,
    approverId: row.approverId,
    decision: row.decision,
    note: row.note,
    dueAt: iso(row.dueAt),
    decidedAt: iso(row.decidedAt),
    delegatedFrom: row.delegatedFrom,
  };
}

/** The payload of a `project_decision` event: ids and statuses, no free text beyond the title. */
export function decisionEventData(row: DecisionRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    code: decisionCode(row.number),
    title: row.title,
    status: row.status,
    deciderId: row.deciderId,
    decidedBy: row.decidedBy,
    supersededById: row.supersededById,
  };
}
