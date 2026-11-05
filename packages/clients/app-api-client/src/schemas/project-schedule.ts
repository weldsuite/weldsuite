/**
 * WeldFlow delivery, scheduling: typed task dependencies, the computed
 * schedule with its critical path, and phases with stage gates.
 *
 * Request schemas for `/api/task-dependencies`, `/api/project-schedule` and
 * `/api/project-phases`, and the shapes they answer. Design:
 * weldsuite-documentation `design/modules/weldflow-delivery-and-portfolio.md`,
 * ADRs FLOW-015 and FLOW-017.
 *
 * Request bodies are `.strict()`: a field the API does not accept (`id`,
 * `status` on a phase) is a 400 and never silently dropped.
 */

import { z } from 'zod';

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** finish-to-start, start-to-start, finish-to-finish, start-to-finish. */
export const DEPENDENCY_TYPES = ['fs', 'ss', 'ff', 'sf'] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

/** The largest lag or lead, in working days. */
export const MAX_LAG_DAYS = 3650;

export const PHASE_STATUSES = ['upcoming', 'active', 'passed'] as const;
export type PhaseStatus = (typeof PHASE_STATUSES)[number];

/** The automatic gate criteria (flow-domain `gates.ts`). */
export const GATE_CRITERION_KEYS = [
  'deliverable_tasks_done',
  'deliverable_accepted',
  'no_open_risk_above',
  'decision_decided',
  'no_change_request_pending',
  'spend_within_baseline',
] as const;
export type GateCriterionKey = (typeof GATE_CRITERION_KEYS)[number];

export const GATE_RISK_BANDS = ['low', 'medium', 'high', 'critical'] as const;

export type GateLinkKind = 'tasks' | 'deliverable' | 'raid' | 'decision' | 'change_requests' | 'finance';

// ── Building blocks ─────────────────────────────────────────────────────────

const identifier = z.string().min(1).max(255);
/** A calendar date, `YYYY-MM-DD`. */
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in the form YYYY-MM-DD');
/** An RFC 3339 timestamp, `Z` or an offset. */
const isoDateTime = z.string().datetime({ offset: true });
const lagDays = z.number().int().min(-MAX_LAG_DAYS).max(MAX_LAG_DAYS);

// ── Task dependencies ───────────────────────────────────────────────────────

export const createTaskDependencySchema = z
  .object({
    predecessorId: identifier,
    successorId: identifier,
    type: z.enum(DEPENDENCY_TYPES).optional(),
    lagDays: lagDays.optional(),
  })
  .strict();
export type CreateTaskDependencyInput = z.infer<typeof createTaskDependencySchema>;

export const updateTaskDependencySchema = z
  .object({
    type: z.enum(DEPENDENCY_TYPES).optional(),
    lagDays: lagDays.optional(),
  })
  .strict()
  .refine((body) => body.type !== undefined || body.lagDays !== undefined, { message: 'Give a type, a lag, or both' });
export type UpdateTaskDependencyInput = z.infer<typeof updateTaskDependencySchema>;

export const listTaskDependenciesQuerySchema = z.object({
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

// ── Schedule ────────────────────────────────────────────────────────────────

/** Move one task: the start date, the due date, or both (one given keeps the task's duration). */
export const scheduleMoveSchema = z
  .object({
    taskId: identifier,
    startDate: calendarDate.nullish(),
    dueDate: calendarDate.nullish(),
  })
  .strict();
export type ScheduleMoveInput = z.infer<typeof scheduleMoveSchema>;

/** The project calendar and the auto-schedule switch (`projects.settings.schedule`). */
export const updateScheduleSettingsSchema = z
  .object({
    workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
    holidays: z.array(calendarDate).max(1000).optional(),
    autoSchedule: z.boolean().optional(),
  })
  .strict();
export type UpdateScheduleSettingsInput = z.infer<typeof updateScheduleSettingsSchema>;

// ── Phases and gates ────────────────────────────────────────────────────────

/** One criterion of a gate: a catalogue key with parameters, or free text a manager ticks. */
export const gateCriterionInputSchema = z.union([
  z
    .object({
      key: z.enum(GATE_CRITERION_KEYS),
      params: z.record(z.unknown()).optional(),
    })
    .strict(),
  z.object({ manual: z.string().trim().min(1).max(500) }).strict(),
]);
export type GateCriterionInput = z.infer<typeof gateCriterionInputSchema>;

const gateCriteria = z.array(gateCriterionInputSchema).max(30);

export const listPhasesQuerySchema = z.object({
  projectId: z.string().min(1),
});

export const createPhaseSchema = z
  .object({
    projectId: identifier,
    name: z.string().trim().min(1).max(255),
    plannedStart: isoDateTime.nullish(),
    plannedEnd: isoDateTime.nullish(),
    gateCriteria: gateCriteria.optional(),
  })
  .strict();
export type CreatePhaseInput = z.infer<typeof createPhaseSchema>;

export const updatePhaseSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    plannedStart: isoDateTime.nullish(),
    plannedEnd: isoDateTime.nullish(),
    /** Replacing the criteria clears the manual ticks and the waivers of the gate. */
    gateCriteria: gateCriteria.optional(),
  })
  .strict();
export type UpdatePhaseInput = z.infer<typeof updatePhaseSchema>;

export const reorderPhasesSchema = z
  .object({
    projectId: identifier,
    /** Every live phase of the project once, in the new order. */
    ids: z.array(identifier).max(100),
  })
  .strict();
export type ReorderPhasesInput = z.infer<typeof reorderPhasesSchema>;

export const waiveCriterionSchema = z
  .object({
    criterionIndex: z.number().int().min(0).max(1000),
    note: z.string().trim().min(1).max(2000),
  })
  .strict();
export type WaiveCriterionInput = z.infer<typeof waiveCriterionSchema>;

export const tickCriterionSchema = z.object({ met: z.boolean() }).strict();
export type TickCriterionInput = z.infer<typeof tickCriterionSchema>;

// ── Responses ───────────────────────────────────────────────────────────────

export interface TaskDependency {
  id: string;
  projectId: string;
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  /** Working days; negative is lead time. */
  lagDays: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleSettings {
  /** ISO weekdays that are working days: 1 = Monday ... 7 = Sunday. */
  workingDays: number[];
  /** Non-working dates, `YYYY-MM-DD`. */
  holidays: string[];
  autoSchedule: boolean;
}

/** A task of the schedule: what it is, its stored dates, and what the calculation made of them. */
export interface ScheduleTask {
  id: string;
  number: number | null;
  title: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  parentTaskId: string | null;
  deliverableId: string | null;
  progress: string;
  /** The stored dates (ISO timestamps). */
  startDate: string | null;
  dueDate: string | null;
  /** In the network: has dates and is not cancelled. */
  scheduled: boolean;
  done: boolean;
  /** Planned dates as the calendar reads them (`YYYY-MM-DD`). */
  plannedStart: string | null;
  plannedFinish: string | null;
  durationDays: number | null;
  earlyStart: string | null;
  earlyFinish: string | null;
  lateStart: string | null;
  lateFinish: string | null;
  /** Working days the task can slip without moving the project finish; null for done and unscheduled tasks. */
  totalFloat: number | null;
  critical: boolean;
  /** Working days the early start lies after the planned start. */
  shiftDays: number;
  /** Has at least one link to another task of the network. */
  linked: boolean;
}

export interface ScheduleConflict {
  linkId: string;
  predecessorId: string;
  successorId: string;
  type: DependencyType;
  lagDays: number;
  /** The earliest start the link allows the successor. */
  requiredStart: string;
  plannedStart: string;
  shortByDays: number;
}

export interface ScheduleDeliverable {
  id: string;
  /** `D3`. */
  code: string;
  title: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  /** The latest early finish of its tasks. */
  projectedEnd: string | null;
  /** Working days the projected end lies after the planned end (negative: before). */
  slipDays: number | null;
}

export interface ScheduleGoLive {
  /** The date the project has to be live. */
  date: string | null;
  /** The latest baseline's go-live, else the project's end date. */
  source: 'baseline' | 'project' | null;
  baselineVersion: number | null;
}

export interface ScheduleSummary {
  taskCount: number;
  scheduledCount: number;
  /** Scheduled tasks with no link to another task. */
  unlinkedCount: number;
  linkCount: number;
  criticalCount: number;
  /** Working days from the first critical task's start to the project finish; null without a critical path. */
  criticalSpanDays: number | null;
  conflictCount: number;
}

export interface ProjectSchedule {
  projectId: string;
  settings: ScheduleSettings;
  goLive: ScheduleGoLive;
  /** The latest early finish of the network. */
  finish: string | null;
  /** Working days from the finish to go-live: positive is float, negative is late. */
  goLiveSlackDays: number | null;
  /** The change control limit (working days of delay the project manager may approve alone), for the impact notes. */
  scheduleLimitDays: number;
  tasks: ScheduleTask[];
  dependencies: TaskDependency[];
  conflicts: ScheduleConflict[];
  /** Task ids on the critical path, in start order. */
  criticalPath: string[];
  cyclicTaskIds: string[];
  deliverables: ScheduleDeliverable[];
  summary: ScheduleSummary;
}

/** One task's planned dates and the dates it would have after a move. */
export interface MovedTask {
  taskId: string;
  fromStart: string | null;
  fromFinish: string | null;
  toStart: string;
  toFinish: string;
  /** Working days later (negative for the moved task itself dragged earlier). */
  shiftDays: number;
}

export interface MoveDeliverableImpact {
  id: string;
  code: string;
  title: string;
  plannedEnd: string | null;
  endBefore: string | null;
  endAfter: string | null;
  shiftDays: number;
}

export interface ScheduleMoveImpact {
  taskId: string;
  /** The dates the moved task gets. */
  task: { startDate: string; dueDate: string };
  /** The moved task first, then the dependents it pushes, by new start. */
  moved: MovedTask[];
  /** Conflicts the move creates when nothing but the task itself moves. */
  newConflicts: ScheduleConflict[];
  before: { finish: string | null; goLiveSlackDays: number | null };
  after: { finish: string | null; goLiveSlackDays: number | null };
  /** Deliverables whose end moves. */
  deliverables: MoveDeliverableImpact[];
  goLive: ScheduleGoLive;
  /** The move pushes the project finish past go-live: a change request moves the go-live date, nothing else does. */
  exceedsGoLive: boolean;
  /** Working days the project finish moves. */
  finishShiftDays: number;
  autoSchedule: boolean;
  scheduleLimitDays: number;
}

export interface ScheduleMoveResult extends ScheduleMoveImpact {
  /** True once the tasks of `moved` have been written. */
  applied: true;
}

export interface GateWaiver {
  index: number;
  note: string;
  by: string;
  at: string;
}

export interface GateLink {
  kind: GateLinkKind;
  id: string | null;
}

export interface GateCheckItem {
  index: number;
  kind: 'automatic' | 'manual';
  key: string | null;
  text: string | null;
  params: Record<string, unknown> | null;
  met: boolean;
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

export interface GateApproval {
  id: string;
  approverId: string;
  roleLabel: string | null;
  step: number;
  decision: 'pending' | 'approved' | 'approved_with_conditions' | 'rejected' | 'info_requested';
  note: string | null;
  decidedAt: string | null;
}

/** The criteria as stored on the phase: a catalogue key with parameters, or a manual one. */
export type StoredGateCriterion =
  | { key: string; params?: Record<string, unknown> }
  | { manual: string; met?: boolean; metAt?: string | null };

export interface StoredGateResult {
  checkedAt: string;
  criteria: Array<{ criterion: StoredGateCriterion; met: boolean; detail?: Record<string, unknown> | null }>;
  waived: Array<{ index: number; note: string; by: string; at: string }>;
}

export interface Phase {
  id: string;
  projectId: string;
  position: number;
  name: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  status: PhaseStatus;
  gateCriteria: StoredGateCriterion[];
  /** The criteria and waivers at the moment the gate was requested or decided. */
  gateResult: StoredGateResult | null;
  gateRequestedAt: string | null;
  passedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A phase as a list shows it: the phase, its gate number, the criteria met and, for a gate that was asked, its approvals. */
export interface PhaseSummary extends Phase {
  /** 1-based number of the phase's gate in the lifecycle. */
  gateNumber: number;
  criteriaCount: number;
  approvals: GateApproval[];
}

export interface PhaseList {
  currentPhaseId: string | null;
  phases: PhaseSummary[];
}

/** One phase with its gate evaluated now. */
export interface PhaseGate extends PhaseSummary {
  check: GateCheck;
  /** Who would be asked to approve the gate: the sponsor, and one change board member. */
  approverIds: string[];
  /** Why the gate cannot be requested right now, or null when it can. */
  requestBlockedReason: 'phase_passed' | 'phase_not_active' | 'already_requested' | 'criteria_open' | 'no_approver' | null;
}

export interface PhaseGateRequestResult {
  phase: PhaseGate;
  approvals: GateApproval[];
}
