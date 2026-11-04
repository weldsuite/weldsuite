import {
  pgTable,
  varchar,
  text,
  timestamp,
  boolean,
  smallint,
  integer,
  numeric,
  jsonb,
  date,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { projects } from './projects';
import { tasks } from './tasks';

/**
 * WeldFlow delivery and portfolio (docs: weldsuite-documentation,
 * design/modules/weldflow-delivery-and-portfolio.md; ADRs FLOW-015 to
 * FLOW-021): the approvals behind "My reviews", task dependencies and the
 * computed schedule, phases and stage gates, status reports, stakeholders and
 * RACI, finance snapshots, lessons, templates, capacity and project intake.
 * The project-control registers (decisions, change requests, deliverables,
 * baselines, benefits) are in `./project-control`.
 *
 * Tenant DB only. Conventions, as in project control: ids are varchar(30) made
 * with `generateId(<prefix>)`, timestamps are `timestamptz`, rows are soft
 * deleted (`deleted_at`) unless the table says otherwise, and the jsonb
 * columns are typed with the interfaces in this file. Where the design is
 * vague the choice is made here and written in the table's comment.
 *
 * Id prefixes: flow_approvals `apr`, flow_approval_delegations `apd`,
 * task_dependencies `tdp`, project_phases `phs`, project_status_reports `rpt`,
 * project_stakeholders `stk`, project_raci `rac`, project_finance_snapshots
 * `fsn`, project_lessons `les`, project_templates `tpl`, flow_member_profiles
 * `fmp`, resource_bookings `bkg`, resource_requests `rrq`, project_requests
 * `prq`, flow_workspace_settings `fws`.
 */

// ── Approvals (FLOW-016) ────────────────────────────────────────────────────

/**
 * What an approval row is about. The design lists the first six; `project_close`
 * is added for closing a project (FLOW-016 names it as a subject, the design's
 * data model table leaves it out): `subject_id` is the project id, rule `close`.
 */
export const APPROVAL_SUBJECT_TYPES = [
  'change_request',
  'gate',
  'deliverable',
  'decision',
  'risk_acceptance',
  'project_request',
  'project_close',
] as const;
export type ApprovalSubjectType = (typeof APPROVAL_SUBJECT_TYPES)[number];

/** `member`: a workspace member (user id). `contact`: a CRM contact on the client portal (FLOW-020). */
export const APPROVER_KINDS = ['member', 'contact'] as const;
export type ApproverKind = (typeof APPROVER_KINDS)[number];

/**
 * `pending` and `info_requested` are open (the approver can still answer);
 * `approved`, `approved_with_conditions` and `rejected` are final. A final
 * answer is never changed.
 */
export const APPROVAL_DECISIONS = [
  'pending',
  'approved',
  'approved_with_conditions',
  'rejected',
  'info_requested',
] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/**
 * Why this person was asked: a code from the catalogue in flow-domain
 * (`approvals.ts`, `APPROVAL_RULE_CODES`) plus the parameters it used, such as
 * `{ code: 'change_board_over_limit', params: { costDelta: 8000, costLimit: 5000 } }`.
 * My reviews shows it next to the row.
 */
export interface ApprovalRule {
  code: string;
  params?: Record<string, unknown>;
}

/**
 * One row per approver per subject (FLOW-016). Rows with the same `step` run
 * in parallel, a later step waits for the earlier one. The table stores the
 * answers; the subject's own handler (flow-domain `registerApprovalSubject`)
 * decides whether the subject is now approved, rejected or still waiting.
 *
 * `created_by` is the requester (who is told when a review is overdue).
 * `decided_by` is who answered: the approver, or the delegate who answered for
 * them. `delegated_from` is set when the row was created for a delegate (the
 * member who delegated). `reminded_at` and `overdue_notified_at` belong to the
 * `approval_due` sweep, so a reminder goes out once. Clearing a subject's
 * approvals (a change edited after submission, a withdrawn request) soft
 * deletes its rows.
 *
 * My reviews reads the (`approver_id`, `decision`, `due_at`) index.
 */
export const flowApprovals = pgTable(
  'flow_approvals',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    /** Null for a project request (it is not a project yet). */
    projectId: varchar('project_id', { length: 255 }).references(() => projects.id),
    subjectType: varchar('subject_type', { length: 30 }).$type<ApprovalSubjectType>().notNull(),
    subjectId: varchar('subject_id', { length: 255 }).notNull(),
    approverKind: varchar('approver_kind', { length: 10 }).$type<ApproverKind>().notNull().default('member'),
    /** A workspace member's user id, or a CRM contact id for `approver_kind` `contact`. */
    approverId: varchar('approver_id', { length: 255 }).notNull(),
    roleLabel: varchar('role_label', { length: 100 }),
    /** 1-based. Same step = in parallel. */
    step: integer('step').notNull().default(1),
    rule: jsonb('rule').$type<ApprovalRule>().notNull(),
    decision: varchar('decision', { length: 30 }).$type<ApprovalDecision>().notNull().default('pending'),
    note: text('note'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: varchar('decided_by', { length: 255 }),
    delegatedFrom: varchar('delegated_from', { length: 255 }),
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    overdueNotifiedAt: timestamp('overdue_notified_at', { withTimezone: true }),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('flow_approvals_approver_decision_due_idx').on(table.approverId, table.decision, table.dueAt),
    index('flow_approvals_subject_idx').on(table.subjectType, table.subjectId),
    index('flow_approvals_project_decision_idx').on(table.projectId, table.decision),
    index('flow_approvals_decision_due_idx').on(table.decision, table.dueAt),
    check(
      'flow_approvals_subject_type_check',
      sql`${table.subjectType} in ('change_request', 'gate', 'deliverable', 'decision', 'risk_acceptance', 'project_request', 'project_close')`,
    ),
    check('flow_approvals_approver_kind_check', sql`${table.approverKind} in ('member', 'contact')`),
    check(
      'flow_approvals_decision_check',
      sql`${table.decision} in ('pending', 'approved', 'approved_with_conditions', 'rejected', 'info_requested')`,
    ),
    check('flow_approvals_step_check', sql`${table.step} >= 1`),
  ],
);

export type FlowApproval = typeof flowApprovals.$inferSelect;
export type NewFlowApproval = typeof flowApprovals.$inferInsert;

/**
 * "While I am away, my reviews go to X." Active between `starts_at` (inclusive)
 * and `ends_at` (exclusive): new approval rows for the member are created for
 * the delegate (`delegated_from` set), and the delegate may also answer rows
 * the member already had. One hop only: a delegate's own delegation is not
 * followed.
 */
export const flowApprovalDelegations = pgTable(
  'flow_approval_delegations',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    memberId: varchar('member_id', { length: 255 }).notNull(),
    delegateId: varchar('delegate_id', { length: 255 }).notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('flow_approval_delegations_member_idx').on(table.memberId, table.startsAt, table.endsAt),
    index('flow_approval_delegations_delegate_idx').on(table.delegateId, table.startsAt, table.endsAt),
    check('flow_approval_delegations_period_check', sql`${table.endsAt} > ${table.startsAt}`),
    check('flow_approval_delegations_self_check', sql`${table.memberId} <> ${table.delegateId}`),
  ],
);

export type FlowApprovalDelegation = typeof flowApprovalDelegations.$inferSelect;
export type NewFlowApprovalDelegation = typeof flowApprovalDelegations.$inferInsert;

// ── Task dependencies (FLOW-015) ────────────────────────────────────────────

/** finish-to-start, start-to-start, finish-to-finish, start-to-finish. */
export const DEPENDENCY_TYPES = ['fs', 'ss', 'ff', 'sf'] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

/**
 * A typed dependency between two tasks of one project: the successor waits for
 * the predecessor, by `type` and `lag_days` (working days, negative for lead
 * time). Replaces the `tasks.depends_on` / `tasks.blocks` arrays, which stay
 * until a release after the data migration.
 *
 * A dependency is a relation, not an entity with a history (like
 * `project_control_links`): it is deleted for real, which also keeps the unique
 * index on the pair usable when the link is made again, and the
 * `task_dependency` entity events are the trail. Deleting a task deletes its
 * rows in the same batch. Links stay inside one project; links between
 * projects are RAID dependencies.
 */
export const taskDependencies = pgTable(
  'task_dependencies',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 255 })
      .notNull()
      .references(() => projects.id),
    predecessorId: varchar('predecessor_id', { length: 255 })
      .notNull()
      .references(() => tasks.id),
    successorId: varchar('successor_id', { length: 255 })
      .notNull()
      .references(() => tasks.id),
    type: varchar('type', { length: 2 }).$type<DependencyType>().notNull().default('fs'),
    lagDays: integer('lag_days').notNull().default(0),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('task_dependencies_pair_idx').on(table.predecessorId, table.successorId),
    index('task_dependencies_successor_idx').on(table.successorId),
    index('task_dependencies_project_idx').on(table.projectId),
    check('task_dependencies_type_check', sql`${table.type} in ('fs', 'ss', 'ff', 'sf')`),
    check('task_dependencies_self_check', sql`${table.predecessorId} <> ${table.successorId}`),
  ],
);

export type TaskDependency = typeof taskDependencies.$inferSelect;
export type NewTaskDependency = typeof taskDependencies.$inferInsert;

// ── Phases and stage gates (FLOW-017) ───────────────────────────────────────

export const PHASE_STATUSES = ['upcoming', 'active', 'passed'] as const;
export type PhaseStatus = (typeof PHASE_STATUSES)[number];

/**
 * One gate criterion: a key of the catalogue in flow-domain with its
 * parameters, or a manual criterion (free text the project manager ticks).
 */
export type GateCriterion =
  | { key: string; params?: Record<string, unknown> }
  | { manual: string; met?: boolean; metAt?: string | null };

/**
 * What the gate looked like when approval was requested or decided (FLOW-017:
 * "the waiver and the criteria results at that moment are stored with the
 * approval"). Stored on the phase because the approval rows are per approver.
 */
export interface GateResult {
  /** ISO date-time the criteria were evaluated. */
  checkedAt: string;
  criteria: Array<{ criterion: GateCriterion; met: boolean; detail?: string | null }>;
  /** Criteria the sponsor waived, with the note they gave. */
  waived: Array<{ index: number; note: string; by: string; at: string }>;
}

/**
 * A phase of the project lifecycle, ending in a gate. `position` orders the
 * phases (not unique, so a reorder needs no swap). Exactly one phase is
 * `active` while the project runs (`projects.settings.currentPhaseId`).
 * Approval to pass the gate goes through `flow_approvals` (subject_type `gate`,
 * `subject_id` the phase id).
 */
export const projectPhases = pgTable(
  'project_phases',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 255 })
      .notNull()
      .references(() => projects.id),
    position: integer('position').notNull().default(0),
    name: varchar('name', { length: 255 }).notNull(),
    plannedStart: timestamp('planned_start', { withTimezone: true }),
    plannedEnd: timestamp('planned_end', { withTimezone: true }),
    status: varchar('status', { length: 20 }).$type<PhaseStatus>().notNull().default('upcoming'),
    gateCriteria: jsonb('gate_criteria').$type<GateCriterion[]>().notNull().default([]),
    gateResult: jsonb('gate_result').$type<GateResult>(),
    /** Set when the project manager requested approval of the gate. */
    gateRequestedAt: timestamp('gate_requested_at', { withTimezone: true }),
    passedAt: timestamp('passed_at', { withTimezone: true }),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('project_phases_project_position_idx').on(table.projectId, table.position),
    check('project_phases_status_check', sql`${table.status} in ('upcoming', 'active', 'passed')`),
  ],
);

export type ProjectPhase = typeof projectPhases.$inferSelect;
export type NewProjectPhase = typeof projectPhases.$inferInsert;

// ── Status reports (FLOW-018) ───────────────────────────────────────────────

export const STATUS_REPORT_STATUSES = ['draft', 'published'] as const;
export type StatusReportStatus = (typeof STATUS_REPORT_STATUSES)[number];

/** `grey` is "no data yet" (no baseline, no benefits); the rest is the usual traffic light. */
export const STATUS_COLOURS = ['green', 'amber', 'red', 'grey'] as const;
export type StatusColour = (typeof STATUS_COLOURS)[number];

export const STATUS_REPORT_AREAS = ['schedule', 'budget', 'scope', 'risk', 'benefits'] as const;
export type StatusReportAreaKey = (typeof STATUS_REPORT_AREAS)[number];

/** One area of a report. `auto` is true while the colour is the computed one, false once the project manager overrode it (with a reason). */
export interface StatusReportArea {
  key: StatusReportAreaKey;
  colour: StatusColour;
  reason: string | null;
  auto: boolean;
}

/** One line of the `done` and `next` lists: a task, or free text. */
export interface StatusReportItem {
  taskId?: string | null;
  text: string;
  // slice D: `code` (`TASK-12`, `D2`, `DEC-5`) and `date` are set on the lines the
  // report fills in from project data, so a refresh replaces those and keeps the
  // lines the project manager wrote (no code). Both live in the jsonb only.
  code?: string | null;
  date?: string | null;
}

/**
 * The figures and lists frozen at publication. `version` is the layout version
 * of the snapshot, so a report published under an older layout still renders
 * after the layout changes (FLOW-018).
 */
export interface StatusReportSnapshot {
  version: number;
  [key: string]: unknown;
}

/**
 * A periodic report. `period` is an ISO week (`2026-W45`) or a month
 * (`2026-11`). Drafted by the `status_report_due` sweep from live data, frozen
 * on publish: a published row is never edited. A correction is a new report for
 * the same period (`supersedes_id` points at the earlier one), so unlike a
 * unique (project, period) there can be several rows per period.
 * `client_visible` shows the published report in the client portal.
 */
export const projectStatusReports = pgTable(
  'project_status_reports',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 255 })
      .notNull()
      .references(() => projects.id),
    period: varchar('period', { length: 10 }).notNull(),
    status: varchar('status', { length: 20 }).$type<StatusReportStatus>().notNull().default('draft'),
    overall: varchar('overall', { length: 10 }).$type<StatusColour>(),
    areas: jsonb('areas').$type<StatusReportArea[]>().notNull().default([]),
    summary: text('summary'),
    done: jsonb('done').$type<StatusReportItem[]>().notNull().default([]),
    next: jsonb('next').$type<StatusReportItem[]>().notNull().default([]),
    snapshot: jsonb('snapshot').$type<StatusReportSnapshot>(),
    clientVisible: boolean('client_visible').notNull().default(false),
    supersedesId: varchar('supersedes_id', { length: 30 }),
    publishedBy: varchar('published_by', { length: 255 }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    recipients: jsonb('recipients').$type<{ stakeholderIds?: string[]; emails?: string[] }>(),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('project_status_reports_project_period_idx').on(table.projectId, table.period),
    index('project_status_reports_project_published_idx').on(table.projectId, table.status, table.publishedAt),
    check('project_status_reports_status_check', sql`${table.status} in ('draft', 'published')`),
    check(
      'project_status_reports_period_check',
      sql`${table.period} ~ '^[0-9]{4}-(W(0[1-9]|[1-4][0-9]|5[0-3])|(0[1-9]|1[0-2]))$'`,
    ),
  ],
);

export type ProjectStatusReport = typeof projectStatusReports.$inferSelect;
export type NewProjectStatusReport = typeof projectStatusReports.$inferInsert;

// ── Stakeholders and RACI ───────────────────────────────────────────────────

export const STAKEHOLDER_ATTITUDES = ['supportive', 'neutral', 'resistant'] as const;
export type StakeholderAttitude = (typeof STAKEHOLDER_ATTITUDES)[number];

/** How engaged the stakeholder is now (the engagement assessment of the register). */
export const STAKEHOLDER_ENGAGEMENT = ['unaware', 'resistant', 'neutral', 'supportive', 'leading'] as const;
export type StakeholderEngagement = (typeof STAKEHOLDER_ENGAGEMENT)[number];

/**
 * A person with a stake in the project: a workspace member (`member_id`) or a
 * CRM contact (`crm_contact_id`), exactly one of the two. `influence` and
 * `interest` (1 to 5) place them on the power/interest grid. `portal_access`
 * lets the contact into the client portal (FLOW-020); `portal_invited_at` is
 * when the invitation was sent. A person is on a project's register once
 * (partial unique indexes over the live rows).
 */
export const projectStakeholders = pgTable(
  'project_stakeholders',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 255 })
      .notNull()
      .references(() => projects.id),
    memberId: varchar('member_id', { length: 255 }),
    crmContactId: varchar('crm_contact_id', { length: 30 }),
    organisation: varchar('organisation', { length: 255 }),
    role: varchar('role', { length: 100 }),
    influence: smallint('influence').notNull().default(3),
    interest: smallint('interest').notNull().default(3),
    attitude: varchar('attitude', { length: 20 }).$type<StakeholderAttitude>().notNull().default('neutral'),
    engagement: varchar('engagement', { length: 20 }).$type<StakeholderEngagement>().notNull().default('neutral'),
    notes: text('notes'),
    lastContactAt: timestamp('last_contact_at', { withTimezone: true }),
    portalAccess: boolean('portal_access').notNull().default(false),
    portalInvitedAt: timestamp('portal_invited_at', { withTimezone: true }),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('project_stakeholders_project_idx').on(table.projectId),
    index('project_stakeholders_contact_idx').on(table.crmContactId),
    uniqueIndex('project_stakeholders_member_idx')
      .on(table.projectId, table.memberId)
      .where(sql`${table.deletedAt} is null and ${table.memberId} is not null`),
    uniqueIndex('project_stakeholders_contact_unique_idx')
      .on(table.projectId, table.crmContactId)
      .where(sql`${table.deletedAt} is null and ${table.crmContactId} is not null`),
    check(
      'project_stakeholders_identity_check',
      sql`(${table.memberId} is null) <> (${table.crmContactId} is null)`,
    ),
    check(
      'project_stakeholders_scale_check',
      sql`${table.influence} between 1 and 5 and ${table.interest} between 1 and 5`,
    ),
    check('project_stakeholders_attitude_check', sql`${table.attitude} in ('supportive', 'neutral', 'resistant')`),
    check(
      'project_stakeholders_engagement_check',
      sql`${table.engagement} in ('unaware', 'resistant', 'neutral', 'supportive', 'leading')`,
    ),
  ],
);

export type ProjectStakeholder = typeof projectStakeholders.$inferSelect;
export type NewProjectStakeholder = typeof projectStakeholders.$inferInsert;

export const RACI_SUBJECT_TYPES = ['deliverable', 'change_requests', 'go_live'] as const;
export type RaciSubjectType = (typeof RACI_SUBJECT_TYPES)[number];

/** Responsible, Accountable, Consulted, Informed. */
export const RACI_LETTERS = ['R', 'A', 'C', 'I'] as const;
export type RaciLetter = (typeof RACI_LETTERS)[number];

/**
 * One cell of the RACI matrix. `subject_id` is a deliverable id for
 * `deliverable`, and null for the type-wide rows (`change_requests`,
 * `go_live`). A cell is a relation, not an entity with a history, so it is
 * deleted for real (the `project_stakeholder` events are the trail). One `A`
 * per subject (partial unique index); a stakeholder has at most one row per
 * letter per subject.
 */
export const projectRaci = pgTable(
  'project_raci',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 255 })
      .notNull()
      .references(() => projects.id),
    subjectType: varchar('subject_type', { length: 20 }).$type<RaciSubjectType>().notNull(),
    subjectId: varchar('subject_id', { length: 255 }),
    stakeholderId: varchar('stakeholder_id', { length: 30 })
      .notNull()
      .references(() => projectStakeholders.id),
    letter: varchar('letter', { length: 1 }).$type<RaciLetter>().notNull(),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('project_raci_project_subject_idx').on(table.projectId, table.subjectType, table.subjectId),
    index('project_raci_stakeholder_idx').on(table.stakeholderId),
    uniqueIndex('project_raci_cell_idx').on(
      table.projectId,
      table.subjectType,
      sql`coalesce(${table.subjectId}, '')`,
      table.stakeholderId,
      table.letter,
    ),
    uniqueIndex('project_raci_one_accountable_idx')
      .on(table.projectId, table.subjectType, sql`coalesce(${table.subjectId}, '')`)
      .where(sql`${table.letter} = 'A'`),
    check('project_raci_subject_type_check', sql`${table.subjectType} in ('deliverable', 'change_requests', 'go_live')`),
    check('project_raci_letter_check', sql`${table.letter} in ('R', 'A', 'C', 'I')`),
    check(
      'project_raci_subject_check',
      sql`(${table.subjectType} = 'deliverable') = (${table.subjectId} is not null)`,
    ),
  ],
);

export type ProjectRaciRow = typeof projectRaci.$inferSelect;
export type NewProjectRaciRow = typeof projectRaci.$inferInsert;

// ── Finance (FLOW-019) ──────────────────────────────────────────────────────

/**
 * One row per project per week, written by the `finance_snapshot` sweep, so
 * the S-curve survives later corrections in the source modules. `week` is an
 * ISO week (`2026-W45`). `budget` is the budget at completion on the baseline
 * at that time (not in the design's column list; the S-curve needs it when a
 * change request moved the budget). The other figures are in the project's
 * `budget_currency`. No soft delete: a snapshot is a measurement.
 */
export const projectFinanceSnapshots = pgTable(
  'project_finance_snapshots',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 255 })
      .notNull()
      .references(() => projects.id),
    week: varchar('week', { length: 8 }).notNull(),
    budget: numeric('budget', { precision: 18, scale: 2 }),
    plannedValue: numeric('planned_value', { precision: 18, scale: 2 }).notNull().default('0'),
    earnedValue: numeric('earned_value', { precision: 18, scale: 2 }).notNull().default('0'),
    actualCost: numeric('actual_cost', { precision: 18, scale: 2 }).notNull().default('0'),
    committed: numeric('committed', { precision: 18, scale: 2 }).notNull().default('0'),
    forecast: numeric('forecast', { precision: 18, scale: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('project_finance_snapshots_project_week_idx').on(table.projectId, table.week),
    check('project_finance_snapshots_week_check', sql`${table.week} ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$'`),
  ],
);

export type ProjectFinanceSnapshot = typeof projectFinanceSnapshots.$inferSelect;
export type NewProjectFinanceSnapshot = typeof projectFinanceSnapshots.$inferInsert;

// ── Lessons learned ─────────────────────────────────────────────────────────

export const LESSON_CATEGORIES = ['went_well', 'went_badly', 'do_differently'] as const;
export type LessonCategory = (typeof LESSON_CATEGORIES)[number];

/**
 * A lesson learned. `votes` is the list of member ids who voted for it.
 * `know_page_id` is the WeldKnow page it was published to ("Publish to
 * WeldKnow" creates one page per project, so all published lessons share it).
 */
export const projectLessons = pgTable(
  'project_lessons',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 255 })
      .notNull()
      .references(() => projects.id),
    category: varchar('category', { length: 20 }).$type<LessonCategory>().notNull(),
    text: text('text').notNull(),
    authorId: varchar('author_id', { length: 255 }).notNull(),
    votes: jsonb('votes').$type<string[]>().notNull().default([]),
    knowPageId: varchar('know_page_id', { length: 30 }),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('project_lessons_project_category_idx').on(table.projectId, table.category),
    check('project_lessons_category_check', sql`${table.category} in ('went_well', 'went_badly', 'do_differently')`),
  ],
);

export type ProjectLesson = typeof projectLessons.$inferSelect;
export type NewProjectLesson = typeof projectLessons.$inferInsert;

// ── Templates (FLOW-021) ────────────────────────────────────────────────────

/**
 * A project blueprint: tasks, dependencies, phases and gates, milestones,
 * deliverables, RAID defaults, pipeline stages, change control and the status
 * report schedule, with dates as working-day offsets from the start, people as
 * roles and ids as local keys (FLOW-021). The sections are owned by the
 * template code in flow-domain; this type only pins `version`, so a template
 * saved under an older layout can still be read.
 */
export interface ProjectBlueprint {
  version: number;
  [section: string]: unknown;
}

/**
 * A workspace-level project template. `shared` makes it usable by every member
 * with `projects:create`; an unshared one is its creator's. `source_project_id`
 * is the project it was saved from (kept when that project goes away).
 */
export const projectTemplates = pgTable(
  'project_templates',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    blueprint: jsonb('blueprint').$type<ProjectBlueprint>().notNull(),
    sourceProjectId: varchar('source_project_id', { length: 255 }).references(() => projects.id, {
      onDelete: 'set null',
    }),
    shared: boolean('shared').notNull().default(false),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [index('project_templates_shared_idx').on(table.shared)],
);

export type ProjectTemplate = typeof projectTemplates.$inferSelect;
export type NewProjectTemplate = typeof projectTemplates.$inferInsert;

// ── Capacity ────────────────────────────────────────────────────────────────

/**
 * One row per member (workspace-level): the hours they can work in a week and
 * their skills, which a resource request is matched against. No soft delete:
 * it is a profile, edited in place.
 */
export const flowMemberProfiles = pgTable(
  'flow_member_profiles',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    /** The member's user id. */
    memberId: varchar('member_id', { length: 255 }).notNull(),
    weeklyHours: numeric('weekly_hours', { precision: 5, scale: 2 }).notNull().default('40'),
    skills: jsonb('skills').$type<string[]>().notNull().default([]),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('flow_member_profiles_member_idx').on(table.memberId),
    check('flow_member_profiles_hours_check', sql`${table.weeklyHours} between 0 and 168`),
  ],
);

export type FlowMemberProfile = typeof flowMemberProfiles.$inferSelect;
export type NewFlowMemberProfile = typeof flowMemberProfiles.$inferInsert;

export const PROJECT_REQUEST_STATUSES = ['new', 'assessing', 'approved', 'rejected', 'converted'] as const;
export type ProjectRequestStatus = (typeof PROJECT_REQUEST_STATUSES)[number];

/** One criterion of the intake scoring model (`flow_workspace_settings.scoring_model`). `inverse` criteria (risk, effort) count as 6 - value. */
export interface ScoringCriterion {
  key: string;
  label: string;
  weight: number;
  inverse: boolean;
}

/** A skill a project request needs, with the hours per week it takes. */
export interface NeededSkill {
  skill: string;
  hoursPerWeek?: number;
}

/**
 * Workspace-level intake: a request for a new project, scored by the portfolio
 * board against the workspace scoring model, approved through `flow_approvals`
 * (subject_type `project_request`, rule `project_request`, all board members),
 * then converted into a project (`project_id`). Declared before the bookings
 * because a tentative booking can be held for a request.
 *
 * `number` is workspace-wide (scope `req`, prefix `REQ-`). `scores` holds the
 * 1 to 5 value per criterion key, `score` the stored weighted sum the ranking
 * and roadmap read. `desired_start` and `desired_end` (not in the design's
 * column list) place the request on the roadmap.
 */
export const projectRequests = pgTable(
  'project_requests',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    number: integer('number').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    requestedBy: varchar('requested_by', { length: 255 }).notNull(),
    businessCase: text('business_case'),
    estimatedCost: numeric('estimated_cost', { precision: 18, scale: 2 }),
    estimatedValue: numeric('estimated_value', { precision: 18, scale: 2 }),
    scores: jsonb('scores').$type<Record<string, number>>().notNull().default({}),
    score: numeric('score', { precision: 8, scale: 2 }),
    neededSkills: jsonb('needed_skills').$type<NeededSkill[]>().notNull().default([]),
    desiredStart: date('desired_start'),
    desiredEnd: date('desired_end'),
    status: varchar('status', { length: 20 }).$type<ProjectRequestStatus>().notNull().default('new'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    /** Set once the request is converted into a project. */
    projectId: varchar('project_id', { length: 255 }).references(() => projects.id),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('project_requests_number_idx').on(table.number),
    index('project_requests_status_score_idx').on(table.status, table.score),
    check(
      'project_requests_status_check',
      sql`${table.status} in ('new', 'assessing', 'approved', 'rejected', 'converted')`,
    ),
  ],
);

export type ProjectRequest = typeof projectRequests.$inferSelect;
export type NewProjectRequest = typeof projectRequests.$inferInsert;

/**
 * A member booked on a project for a period, at an hours-per-week rate.
 * `project_id` for a booking on a project; `request_id` (a `project_requests`
 * row) for a tentative booking held for a request that is not a project yet.
 * Exactly one of the two is set. A booking made from a resource request is
 * linked from the request (`resource_requests.booking_id`). `tentative`
 * bookings count in the load only when the view asks for them. Dates are
 * calendar dates (`starts_on` and `ends_on` inclusive).
 */
export const resourceBookings = pgTable(
  'resource_bookings',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    memberId: varchar('member_id', { length: 255 }).notNull(),
    projectId: varchar('project_id', { length: 255 }).references(() => projects.id),
    requestId: varchar('request_id', { length: 30 }).references(() => projectRequests.id),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    hoursPerWeek: numeric('hours_per_week', { precision: 5, scale: 2 }).notNull(),
    tentative: boolean('tentative').notNull().default(false),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('resource_bookings_member_period_idx').on(table.memberId, table.startsOn, table.endsOn),
    index('resource_bookings_project_idx').on(table.projectId),
    index('resource_bookings_request_idx').on(table.requestId),
    check('resource_bookings_period_check', sql`${table.endsOn} >= ${table.startsOn}`),
    check('resource_bookings_hours_check', sql`${table.hoursPerWeek} > 0 and ${table.hoursPerWeek} <= 168`),
    check(
      'resource_bookings_target_check',
      sql`(${table.projectId} is null) <> (${table.requestId} is null)`,
    ),
  ],
);

export type ResourceBooking = typeof resourceBookings.$inferSelect;
export type NewResourceBooking = typeof resourceBookings.$inferInsert;

export const RESOURCE_REQUEST_STATUSES = ['open', 'booked', 'cancelled'] as const;
export type ResourceRequestStatus = (typeof RESOURCE_REQUEST_STATUSES)[number];

/**
 * A project asks for someone with a skill, for hours per week over a period.
 * Booking one (firm or tentative) creates a `resource_bookings` row and sets
 * `booking_id` and `status` `booked`.
 */
export const resourceRequests = pgTable(
  'resource_requests',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 255 })
      .notNull()
      .references(() => projects.id),
    skill: varchar('skill', { length: 100 }).notNull(),
    hoursPerWeek: numeric('hours_per_week', { precision: 5, scale: 2 }).notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    status: varchar('status', { length: 20 }).$type<ResourceRequestStatus>().notNull().default('open'),
    bookingId: varchar('booking_id', { length: 30 }).references(() => resourceBookings.id),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('resource_requests_project_idx').on(table.projectId),
    index('resource_requests_status_idx').on(table.status),
    check('resource_requests_status_check', sql`${table.status} in ('open', 'booked', 'cancelled')`),
    check('resource_requests_period_check', sql`${table.endsOn} >= ${table.startsOn}`),
    check('resource_requests_hours_check', sql`${table.hoursPerWeek} > 0 and ${table.hoursPerWeek} <= 168`),
  ],
);

export type ResourceRequest = typeof resourceRequests.$inferSelect;
export type NewResourceRequest = typeof resourceRequests.$inferInsert;

// ── Workspace settings ──────────────────────────────────────────────────────

/**
 * WeldFlow's workspace-level settings: a single row (the `singleton` column,
 * unique and always true, is what keeps it one). Holds the intake scoring
 * model, the portfolio board (member ids; the approvers of a project request)
 * and the expense approval limit (open question in the design: whether a
 * project-tagged declaration above it also needs the sponsor).
 */
export const flowWorkspaceSettings = pgTable(
  'flow_workspace_settings',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    singleton: boolean('singleton').notNull().default(true),
    scoringModel: jsonb('scoring_model').$type<ScoringCriterion[]>().notNull().default([]),
    portfolioBoardIds: jsonb('portfolio_board_ids').$type<string[]>().notNull().default([]),
    expenseApprovalLimit: numeric('expense_approval_limit', { precision: 18, scale: 2 }),
    updatedBy: varchar('updated_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('flow_workspace_settings_singleton_idx').on(table.singleton),
    check('flow_workspace_settings_singleton_check', sql`${table.singleton}`),
  ],
);

export type FlowWorkspaceSettings = typeof flowWorkspaceSettings.$inferSelect;
export type NewFlowWorkspaceSettings = typeof flowWorkspaceSettings.$inferInsert;
