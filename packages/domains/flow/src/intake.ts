/**
 * Intake rules: project requests, the scoring model and the wire shapes of
 * requests and the workspace settings (design:
 * weldflow-delivery-and-portfolio.md, "Intake").
 *
 * Pure functions, no database, no clock and no Hono context. flow-api's
 * `/api/project-requests` routes use them, and the Rust flow-domain
 * (`intake.rs`) mirrors them one to one. Every message returned here is sent to
 * the client as it is, so both backends answer alike.
 *
 * The score
 * ---------
 *   score = Σ weight × rating ÷ 5        (0 to 100 with weights adding up to 100)
 *
 * A criterion marked `inverse` (risk, effort) counts as `6 − rating`, so a
 * lower rating scores higher. A request has a score only when every criterion
 * of the model is rated; otherwise it is null and the request ranks last.
 */

import {
  PROJECT_REQUEST_STATUSES,
  SCORE_MAX,
  SCORE_MIN,
  type FlowWorkspaceSettings,
  type NeededSkillInput,
  type ProjectRequest,
  type ProjectRequestStatus,
  type RoadmapItem,
  type ScoreBreakdownLine,
  type ScoringCriterionInput,
} from '@weldsuite/app-api-client/schemas/flow-portfolio';
import type { schema } from '@weldsuite/worker-kit/db';
import { CAPACITY_MESSAGES, parseDate, round2 } from './capacity';
import type { NumberSequence } from './task-numbering';

export { PROJECT_REQUEST_STATUSES };
export type { ProjectRequestStatus };

/** The messages of every refusal, sent to the client as they are. */
export const INTAKE_MESSAGES = {
  notEditable: 'Only a new or assessing request can be changed',
  notScorable: 'Only a new or assessing request can be scored',
  notNew: 'Only a new request can be submitted',
  noBoard: 'Add at least one member to the portfolio board first',
  notApproved: 'Only an approved request can be converted',
  projectLinked: 'This project is already linked to another request',
  notDeletable: 'A converted request cannot be deleted',
  weightsTotal: 'The weights must add up to 100',
  duplicateCriteria: 'Every criterion needs its own key',
  requestForbidden: 'You can only change your own requests',
  scoreForbidden: 'Only the portfolio board can score requests',
  convertForbidden: 'You do not have permission to link this project',
} as const;

/** The message for a rating of a criterion the model does not have. */
export function unknownCriterionMessage(key: string): string {
  return `Unknown scoring criterion: ${key}`;
}

// ── Numbering ───────────────────────────────────────────────────────────────

/** Requests are numbered once per workspace: scope `req`, prefix `REQ-`. */
export const REQUEST_SEQUENCE: NumberSequence = { scope: 'req', prefix: 'REQ-' };

/** The display code of a request: `REQ-14`. */
export function requestCode(number: number): string {
  return `${REQUEST_SEQUENCE.prefix}${number}`;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

/** The model a workspace starts with, until it saves its own. */
export const DEFAULT_SCORING_MODEL: readonly ScoringCriterionInput[] = [
  { key: 'value', label: 'Value', weight: 35, inverse: false },
  { key: 'fit', label: 'Strategic fit', weight: 25, inverse: false },
  { key: 'urgency', label: 'Urgency', weight: 15, inverse: false },
  { key: 'risk', label: 'Risk', weight: 15, inverse: true },
  { key: 'effort', label: 'Effort', weight: 10, inverse: true },
];

/** The 400 message for a scoring model, or null: each key once, the weights adding up to 100. */
export function scoringModelError(model: readonly ScoringCriterionInput[]): string | null {
  if (new Set(model.map((criterion) => criterion.key)).size !== model.length) return INTAKE_MESSAGES.duplicateCriteria;
  const total = model.reduce((sum, criterion) => sum + criterion.weight, 0);
  return total === 100 ? null : INTAKE_MESSAGES.weightsTotal;
}

/** The 400 message for the ratings of a request, or null: every key must be a criterion of the model (the first unknown one, by key, is named). */
export function scoresError(model: readonly ScoringCriterionInput[], scores: Readonly<Record<string, number>>): string | null {
  const known = new Set(model.map((criterion) => criterion.key));
  const unknown = Object.keys(scores)
    .filter((key) => !known.has(key))
    .sort();
  return unknown.length > 0 ? unknownCriterionMessage(unknown[0]) : null;
}

function isRated(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= SCORE_MIN && value <= SCORE_MAX;
}

/** What a rating adds up as: the rating, or `6 − rating` for an inverse criterion. */
function counted(criterion: ScoringCriterionInput, value: number): number {
  return criterion.inverse ? SCORE_MAX + SCORE_MIN - value : value;
}

/**
 * The weighted sum of the ratings, to two decimals, or null when a criterion
 * of the model is not rated yet.
 */
export function scoreRequest(model: readonly ScoringCriterionInput[], scores: Readonly<Record<string, number>>): number | null {
  if (model.length === 0) return null;
  let total = 0;
  for (const criterion of model) {
    const value = scores[criterion.key];
    if (!isRated(value)) return null;
    total += criterion.weight * counted(criterion, value);
  }
  return round2(total / SCORE_MAX);
}

/** How the score adds up, criterion by criterion (points are `weight × counted rating ÷ 5`). */
export function scoreBreakdown(
  model: readonly ScoringCriterionInput[],
  scores: Readonly<Record<string, number>>,
): ScoreBreakdownLine[] {
  return model.map((criterion) => {
    const value = scores[criterion.key];
    const rated = isRated(value);
    return {
      key: criterion.key,
      label: criterion.label,
      weight: criterion.weight,
      inverse: criterion.inverse,
      value: rated ? value : null,
      points: rated ? round2((criterion.weight * counted(criterion, value)) / SCORE_MAX) : null,
    };
  });
}

// ── Request rules ───────────────────────────────────────────────────────────

/** Statuses in which a request can still be edited and scored. */
export const OPEN_REQUEST_STATUSES: readonly ProjectRequestStatus[] = ['new', 'assessing'];

export function isOpenRequestStatus(status: string): boolean {
  return (OPEN_REQUEST_STATUSES as readonly string[]).includes(status);
}

/** The 400 message for a request's desired dates, or null: each a real date when set, the end not before the start. */
export function desiredDatesError(start: string | null | undefined, end: string | null | undefined): string | null {
  const startDays = start ? parseDate(start) : null;
  const endDays = end ? parseDate(end) : null;
  if ((start && startDays === null) || (end && endDays === null)) return CAPACITY_MESSAGES.invalidDate;
  if (startDays !== null && endDays !== null && endDays < startDays) return CAPACITY_MESSAGES.periodOrder;
  return null;
}

/** Needed skills as stored: skill names trimmed (the schema trims already), hours only when given. */
export function normalizeNeededSkills(skills: readonly NeededSkillInput[]): NeededSkillInput[] {
  return skills.map((need) => (need.hoursPerWeek === undefined ? { skill: need.skill } : { skill: need.skill, hoursPerWeek: need.hoursPerWeek }));
}

/** A money amount as the numeric column stores it: two decimals. */
export function amountText(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toFixed(2);
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

type RequestRow = typeof schema.projectRequests.$inferSelect;
type SettingsRow = typeof schema.flowWorkspaceSettings.$inferSelect;

/** A request as the routes answer it and the events carry it. */
export function presentProjectRequest(row: RequestRow): ProjectRequest {
  return {
    id: row.id,
    number: row.number,
    code: requestCode(row.number),
    title: row.title,
    requestedBy: row.requestedBy,
    businessCase: row.businessCase,
    estimatedCost: row.estimatedCost,
    estimatedValue: row.estimatedValue,
    scores: row.scores,
    score: row.score === null ? null : Number(row.score),
    neededSkills: row.neededSkills,
    desiredStart: row.desiredStart,
    desiredEnd: row.desiredEnd,
    status: row.status,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    projectId: row.projectId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The workspace settings, or the defaults for a workspace that has none yet. */
export function presentSettings(row: SettingsRow | null): FlowWorkspaceSettings {
  return {
    id: row ? row.id : null,
    scoringModel: row ? row.scoringModel : [...DEFAULT_SCORING_MODEL],
    portfolioBoardIds: row ? row.portfolioBoardIds : [],
    expenseApprovalLimit: row ? row.expenseApprovalLimit : null,
    updatedBy: row ? row.updatedBy : null,
    updatedAt: row ? row.updatedAt.toISOString() : null,
  };
}

/** The roadmap's order: by start, a project before a request that starts the same day, then by id. */
export function sortRoadmapItems(items: readonly RoadmapItem[]): RoadmapItem[] {
  const rank = (item: RoadmapItem) => (item.type === 'project' ? 0 : 1);
  return [...items].sort(
    (a, b) =>
      (a.startsOn < b.startsOn ? -1 : a.startsOn > b.startsOn ? 1 : 0) ||
      rank(a) - rank(b) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

// ── Approvals of a request ──────────────────────────────────────────────────

type ApprovalRow = typeof schema.flowApprovals.$inferSelect;

/** One board member's answer on a request, as the detail shows it. */
export interface RequestApproval {
  id: string;
  approverKind: string;
  approverId: string;
  roleLabel: string | null;
  step: number;
  decision: string;
  note: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  delegatedFrom: string | null;
  createdAt: string;
}

export function presentRequestApproval(row: ApprovalRow): RequestApproval {
  return {
    id: row.id,
    approverKind: row.approverKind,
    approverId: row.approverId,
    roleLabel: row.roleLabel,
    step: row.step,
    decision: row.decision,
    note: row.note,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedBy: row.decidedBy,
    delegatedFrom: row.delegatedFrom,
    createdAt: row.createdAt.toISOString(),
  };
}
