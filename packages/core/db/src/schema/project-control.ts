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
  index,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { projects } from './projects';

/**
 * WeldFlow project control (docs: weldsuite-documentation, design/modules/
 * weldflow-project-control.md; ADRs FLOW-010 to FLOW-014).
 *
 * Phase 1: the RAID log (risks, assumptions, issues, dependencies) and the
 * links between register items and the tasks and milestones they affect.
 * Later phases (further down this file): the decision log, change requests,
 * deliverables and scope, versioned baselines, and benefits with their
 * monthly measurements.
 *
 * Tenant DB only. Item numbers are per project and per register, allocated
 * from `task_number_sequences` under a short scope key followed by the project
 * id (`rsk:<projectId>`):
 *
 *   register        scope key  display
 *   risk            rsk        RSK-4
 *   assumption      asm        A-1
 *   issue           iss        ISS-2
 *   dependency      dep        DEP-3
 *   decision        dec        DEC-7
 *   change request  cr         CR-8
 *   deliverable     del        D3
 *   benefit         ben        B-1
 *
 * Conventions of the tables (the design's "every table has project_id,
 * created_by, timestamps and soft delete unless noted"): ids are varchar(30)
 * made with `generateId(<prefix>)`, every table is tied to its project, and a
 * table that is append-only, immutable or a relation (links, assessments,
 * baselines, measurements) says so and has no soft delete.
 */

// ── Kinds and status sets ───────────────────────────────────────────────────

export const RAID_KINDS = ['risk', 'assumption', 'issue', 'dependency'] as const;
export type RaidKind = (typeof RAID_KINDS)[number];

/**
 * The statuses of each kind, in lifecycle order. The first one is the status
 * a new item starts in. `project_raid_items_status_check` enforces the sets.
 *
 *   risk        identified → assessing → mitigating → monitoring, then
 *               occurred (it happened: converted to an issue) or closed
 *   assumption  open, then validated (held true) or invalid (proved wrong:
 *               converted to a risk)
 *   issue       open → in_progress, then resolved or closed
 *   dependency  open → at_risk, then delivered or closed
 */
export const RAID_STATUSES = {
  risk: ['identified', 'assessing', 'mitigating', 'monitoring', 'occurred', 'closed'],
  assumption: ['open', 'validated', 'invalid'],
  issue: ['open', 'in_progress', 'resolved', 'closed'],
  dependency: ['open', 'at_risk', 'delivered', 'closed'],
} as const satisfies Record<RaidKind, readonly string[]>;

/**
 * The statuses that end an item's life in the register. Entering one stamps
 * `closed_at` and publishes the `closed` entity event; leaving one clears
 * `closed_at`. "Open" therefore means `closed_at IS NULL`.
 */
export const RAID_CLOSED_STATUSES = {
  risk: ['occurred', 'closed'],
  assumption: ['validated', 'invalid'],
  issue: ['resolved', 'closed'],
  dependency: ['delivered', 'closed'],
} as const satisfies Record<RaidKind, readonly string[]>;

export type RaidStatus = (typeof RAID_STATUSES)[RaidKind][number];

export type RiskStrategy = 'avoid' | 'mitigate' | 'transfer' | 'accept';
export type AssumptionConfidence = 'low' | 'medium' | 'high';
export type IssueSeverity = 'low' | 'medium' | 'high' | 'critical';
export type DependencyDirection = 'inbound' | 'outbound';
export type DependencyPartyType = 'project' | 'supplier' | 'team' | 'customer';

const statusList = (kind: RaidKind) => sql.raw(RAID_STATUSES[kind].map((s) => `'${s}'`).join(', '));

// ── Register items ──────────────────────────────────────────────────────────

/**
 * One table for all four RAID kinds (FLOW-010). Shared columns are ordinary
 * columns, each kind's own fields are typed nullable columns, and CHECK
 * constraints keep another kind's columns null.
 *
 * `due_at` is the one date that drives reminders: next review (risk), validate
 * by (assumption), resolve by (issue) or needed by (dependency).
 */
export const projectRaidItems = pgTable(
  'project_raid_items',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 255 })
      .notNull()
      .references(() => projects.id),
    kind: varchar('kind', { length: 20 }).$type<RaidKind>().notNull(),
    /** Per project and kind; shown as RSK-<n>, A-<n>, ISS-<n> or DEP-<n>. Never reused. */
    number: integer('number').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    /** One of `RAID_STATUSES[kind]`; the check constraint enforces it. */
    status: varchar('status', { length: 30 }).notNull(),
    category: varchar('category', { length: 100 }),
    ownerId: varchar('owner_id', { length: 255 }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    customFields: jsonb('custom_fields').$type<Record<string, unknown>>(),

    // Risk
    /** 1 to 5. */
    probability: smallint('probability'),
    /** 1 to 5. */
    impact: smallint('impact'),
    /** probability * impact, kept by the database. */
    score: integer('score').generatedAlwaysAs(sql`probability * impact`),
    /** The assessed probability after mitigation; set together with `residualImpact`. */
    residualProbability: smallint('residual_probability'),
    residualImpact: smallint('residual_impact'),
    strategy: varchar('strategy', { length: 20 }).$type<RiskStrategy>(),
    trigger: text('trigger'),
    costImpact: numeric('cost_impact', { precision: 18, scale: 2 }),
    scheduleImpactDays: integer('schedule_impact_days'),
    /** Overrides the band's default review interval when set. */
    reviewIntervalDays: integer('review_interval_days'),

    // Assumption
    confidence: varchar('confidence', { length: 10 }).$type<AssumptionConfidence>(),
    ifWrong: text('if_wrong'),

    // Issue
    severity: varchar('severity', { length: 20 }).$type<IssueSeverity>(),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),

    // Dependency
    direction: varchar('direction', { length: 10 }).$type<DependencyDirection>(),
    partyType: varchar('party_type', { length: 20 }).$type<DependencyPartyType>(),
    /** Set when the other party is another project in the workspace. */
    partyProjectId: varchar('party_project_id', { length: 255 }).references(() => projects.id),
    partyName: varchar('party_name', { length: 255 }),

    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('project_raid_items_project_kind_idx').on(table.projectId, table.kind),
    index('project_raid_items_project_due_idx').on(table.projectId, table.dueAt),
    uniqueIndex('project_raid_items_project_kind_number_idx').on(table.projectId, table.kind, table.number),
    check('project_raid_items_kind_check', sql`${table.kind} in ('risk', 'assumption', 'issue', 'dependency')`),
    check(
      'project_raid_items_status_check',
      sql`(${table.kind} = 'risk' and ${table.status} in (${statusList('risk')}))
        or (${table.kind} = 'assumption' and ${table.status} in (${statusList('assumption')}))
        or (${table.kind} = 'issue' and ${table.status} in (${statusList('issue')}))
        or (${table.kind} = 'dependency' and ${table.status} in (${statusList('dependency')}))`,
    ),
    // A risk always carries its probability and impact, so its score is never null.
    check(
      'project_raid_items_risk_required_check',
      sql`${table.kind} <> 'risk' or (${table.probability} is not null and ${table.impact} is not null)`,
    ),
    check(
      'project_raid_items_scale_check',
      sql`(${table.probability} is null or ${table.probability} between 1 and 5)
        and (${table.impact} is null or ${table.impact} between 1 and 5)
        and (${table.residualProbability} is null or ${table.residualProbability} between 1 and 5)
        and (${table.residualImpact} is null or ${table.residualImpact} between 1 and 5)`,
    ),
    check(
      'project_raid_items_residual_pair_check',
      sql`(${table.residualProbability} is null) = (${table.residualImpact} is null)`,
    ),
    // The columns of the other kinds stay null.
    check(
      'project_raid_items_risk_columns_check',
      sql`${table.kind} = 'risk' or (${table.probability} is null and ${table.impact} is null
        and ${table.residualProbability} is null and ${table.residualImpact} is null
        and ${table.strategy} is null and ${table.trigger} is null and ${table.costImpact} is null
        and ${table.scheduleImpactDays} is null and ${table.reviewIntervalDays} is null)`,
    ),
    check(
      'project_raid_items_assumption_columns_check',
      sql`${table.kind} = 'assumption' or (${table.confidence} is null and ${table.ifWrong} is null)`,
    ),
    check(
      'project_raid_items_issue_columns_check',
      sql`${table.kind} = 'issue' or (${table.severity} is null and ${table.escalatedAt} is null)`,
    ),
    check(
      'project_raid_items_dependency_columns_check',
      sql`${table.kind} = 'dependency' or (${table.direction} is null and ${table.partyType} is null
        and ${table.partyProjectId} is null and ${table.partyName} is null)`,
    ),
  ],
);

export type ProjectRaidItem = typeof projectRaidItems.$inferSelect;
export type NewProjectRaidItem = typeof projectRaidItems.$inferInsert;

// ── Risk assessments ────────────────────────────────────────────────────────

/**
 * Append-only: one row per assessment of a risk (the first at creation, then
 * every reassessment or edit of probability or impact). Feeds the
 * score-over-time chart and the trend. No soft delete: the rows are hidden
 * together with their item.
 */
export const projectRaidAssessments = pgTable(
  'project_raid_assessments',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    itemId: varchar('item_id', { length: 30 })
      .notNull()
      .references(() => projectRaidItems.id),
    projectId: varchar('project_id', { length: 255 })
      .notNull()
      .references(() => projects.id),
    probability: smallint('probability').notNull(),
    impact: smallint('impact').notNull(),
    /** probability * impact, kept by the database. */
    score: integer('score').generatedAlwaysAs(sql`probability * impact`),
    residualProbability: smallint('residual_probability'),
    residualImpact: smallint('residual_impact'),
    note: text('note'),
    assessedBy: varchar('assessed_by', { length: 255 }).notNull(),
    assessedAt: timestamp('assessed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('project_raid_assessments_item_idx').on(table.itemId, table.assessedAt),
    index('project_raid_assessments_project_idx').on(table.projectId),
    check(
      'project_raid_assessments_scale_check',
      sql`${table.probability} between 1 and 5 and ${table.impact} between 1 and 5
        and (${table.residualProbability} is null or ${table.residualProbability} between 1 and 5)
        and (${table.residualImpact} is null or ${table.residualImpact} between 1 and 5)`,
    ),
  ],
);

export type ProjectRaidAssessment = typeof projectRaidAssessments.$inferSelect;
export type NewProjectRaidAssessment = typeof projectRaidAssessments.$inferInsert;

// ── Links ───────────────────────────────────────────────────────────────────

/** The kinds of object a control link can join. Later phases add decision, change_request, deliverable and benefit. */
export const CONTROL_LINK_TYPES = ['raid_item', 'task', 'milestone'] as const;
export type ControlLinkType = (typeof CONTROL_LINK_TYPES)[number];

/** Later phases add implements and decided_by. */
export const CONTROL_LINK_RELATIONS = ['mitigates', 'resolves', 'raised_from', 'affects', 'threatens'] as const;
export type ControlLinkRelation = (typeof CONTROL_LINK_RELATIONS)[number];

/**
 * One generic link between two objects of a project (FLOW-011). The ids are
 * polymorphic, so there is no foreign key: integrity rests on the service code
 * and on the cascade that removes a task's or item's links when it is
 * deleted. A link is a relation, not an entity with a history, so it is
 * deleted for real (the `project_control_link` entity events are the trail);
 * that also keeps the unique index usable for linking the same pair again.
 *
 * `project_id` is the project of the `from` end.
 */
export const projectControlLinks = pgTable(
  'project_control_links',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 255 })
      .notNull()
      .references(() => projects.id),
    fromType: varchar('from_type', { length: 30 }).$type<ControlLinkType>().notNull(),
    fromId: varchar('from_id', { length: 255 }).notNull(),
    toType: varchar('to_type', { length: 30 }).$type<ControlLinkType>().notNull(),
    toId: varchar('to_id', { length: 255 }).notNull(),
    relation: varchar('relation', { length: 30 }).$type<ControlLinkRelation>().notNull(),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('project_control_links_pair_idx').on(table.fromType, table.fromId, table.toType, table.toId),
    index('project_control_links_to_idx').on(table.toType, table.toId),
    index('project_control_links_project_idx').on(table.projectId),
  ],
);

export type ProjectControlLink = typeof projectControlLinks.$inferSelect;
export type NewProjectControlLink = typeof projectControlLinks.$inferInsert;

// ── Decision log ────────────────────────────────────────────────────────────

export const DECISION_STATUSES = ['proposed', 'decided', 'superseded'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** One option weighed in a decision; `chosen` marks the option that was taken. */
export interface DecisionOption {
  title: string;
  note?: string | null;
  chosen?: boolean;
}

/**
 * The decision log. A decision starts `proposed` (optionally with a named
 * decider, who is asked through `flow_approvals`, rule `decision_decider`),
 * becomes `decided` and may later be `superseded` by a newer decision
 * (`superseded_by_id`). A decided or rejected change request records one
 * (linked with the `decided_by` control link, FLOW-012).
 *
 * `decider_id` is not in the design's column list: FLOW-016 routes a proposed
 * decision "by the named decider", so the table has to say who that is.
 * Numbers: scope `dec:<projectId>`, prefix `DEC-`.
 */
export const projectDecisions = pgTable(
  'project_decisions',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 255 })
      .notNull()
      .references(() => projects.id),
    number: integer('number').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    status: varchar('status', { length: 20 }).$type<DecisionStatus>().notNull().default('proposed'),
    context: text('context'),
    options: jsonb('options').$type<DecisionOption[]>().notNull().default([]),
    consequences: jsonb('consequences').$type<string[]>().notNull().default([]),
    /** The member who has to decide, while the decision is proposed. */
    deciderId: varchar('decider_id', { length: 255 }),
    /** The member who made the decision (not necessarily the named decider). */
    decidedBy: varchar('decided_by', { length: 255 }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** Reminder date while the decision is open (the digest lists it). */
    decisionDueAt: timestamp('decision_due_at', { withTimezone: true }),
    supersededById: varchar('superseded_by_id', { length: 30 }).references((): AnyPgColumn => projectDecisions.id),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('project_decisions_project_number_idx').on(table.projectId, table.number),
    index('project_decisions_project_status_idx').on(table.projectId, table.status),
    index('project_decisions_project_due_idx').on(table.projectId, table.decisionDueAt),
    check('project_decisions_status_check', sql`${table.status} in ('proposed', 'decided', 'superseded')`),
  ],
);

export type ProjectDecision = typeof projectDecisions.$inferSelect;
export type NewProjectDecision = typeof projectDecisions.$inferInsert;

// ── Change requests ─────────────────────────────────────────────────────────

/**
 * draft → assessing → awaiting_approval → approved | rejected, then
 * implemented once the work is done; `withdrawn` from any open status.
 * Editing the impact after submission sends the change back to `assessing`
 * and clears its approvals (FLOW-013).
 */
export const CHANGE_REQUEST_STATUSES = [
  'draft',
  'assessing',
  'awaiting_approval',
  'approved',
  'rejected',
  'implemented',
  'withdrawn',
] as const;
export type ChangeRequestStatus = (typeof CHANGE_REQUEST_STATUSES)[number];

/** Who approves: the project manager (under both limits) or the change board (FLOW-013). */
export const CHANGE_ROUTES = ['manager', 'board'] as const;
export type ChangeRoute = (typeof CHANGE_ROUTES)[number];

/** The date moves an approved change writes to the live plan. Dates are ISO strings. */
export interface ChangePlanChanges {
  milestones?: Array<{ milestoneId: string; to: string }>;
  deliverables?: Array<{ deliverableId: string; plannedStart?: string | null; plannedEnd?: string | null }>;
  /** The new go-live (the project end date), when the change moves it. */
  goLive?: string | null;
}

/** The deliverables an approved change adds to or removes from the scope. */
export interface ChangeScopeChanges {
  add?: Array<{
    title: string;
    description?: string | null;
    ownerId?: string | null;
    plannedStart?: string | null;
    plannedEnd?: string | null;
    // slice A: the id of the deliverable row, written when the approved change is applied, so the change's events can name it.
    deliverableId?: string;
  }>;
  /** Ids of deliverables to remove. */
  remove?: string[];
}

/**
 * A change request. The approvers' answers are `flow_approvals` rows
 * (subject_type `change_request`), not a table of their own (FLOW-016).
 * Approval runs `applyApprovedChange` in one batch: it writes `plan_changes`
 * and `scope_changes` and the budget (`cost_delta`) to the live plan, inserts
 * the next `project_baselines` version (`baseline_id` points at it, with no
 * foreign key: the baseline row points back at the change) and records a
 * decision.
 *
 * `requested_by` is the member who asked; a request raised by a client in the
 * portal has `requested_by_name` instead. `client_visible` shows it in the
 * client portal. Numbers: scope `cr:<projectId>`, prefix `CR-`.
 */
export const projectChangeRequests = pgTable(
  'project_change_requests',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 255 })
      .notNull()
      .references(() => projects.id),
    number: integer('number').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    requestedBy: varchar('requested_by', { length: 255 }),
    requestedByName: varchar('requested_by_name', { length: 255 }),
    status: varchar('status', { length: 30 }).$type<ChangeRequestStatus>().notNull().default('draft'),
    // Impact assessment
    /** In the project's `budget_currency`; negative when the change saves money. */
    costDelta: numeric('cost_delta', { precision: 18, scale: 2 }),
    /** In working days; negative when the change saves time. */
    scheduleDeltaDays: integer('schedule_delta_days'),
    planChanges: jsonb('plan_changes').$type<ChangePlanChanges>(),
    scopeChanges: jsonb('scope_changes').$type<ChangeScopeChanges>(),
    // Routing, fixed when the change is submitted
    route: varchar('route', { length: 20 }).$type<ChangeRoute>(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** The baseline version this change produced (set on approval). */
    baselineId: varchar('baseline_id', { length: 30 }),
    clientVisible: boolean('client_visible').notNull().default(false),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('project_change_requests_project_number_idx').on(table.projectId, table.number),
    index('project_change_requests_project_status_idx').on(table.projectId, table.status),
    check(
      'project_change_requests_status_check',
      sql`${table.status} in ('draft', 'assessing', 'awaiting_approval', 'approved', 'rejected', 'implemented', 'withdrawn')`,
    ),
    check('project_change_requests_route_check', sql`${table.route} is null or ${table.route} in ('manager', 'board')`),
  ],
);

export type ProjectChangeRequest = typeof projectChangeRequests.$inferSelect;
export type NewProjectChangeRequest = typeof projectChangeRequests.$inferInsert;

// ── Deliverables ────────────────────────────────────────────────────────────

export const DELIVERABLE_STATUSES = ['not_started', 'in_progress', 'accepted', 'rejected'] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

/** One acceptance criterion; the deliverable can be accepted once every one is met. */
export interface AcceptanceCriterion {
  text: string;
  met: boolean;
  /** ISO date-time the criterion was marked met. */
  metAt: string | null;
}

/**
 * A deliverable of the project scope. Tasks count toward at most one
 * deliverable through `tasks.deliverable_id` (FLOW-011): its task progress and
 * Gantt bar are built from them. Accepting one is the project manager's right
 * (`canManageProject`) or, with client sign-off, goes through `flow_approvals`
 * (subject_type `deliverable`, the sponsor and then the client).
 * `position` orders the list. Numbers: scope `del:<projectId>`, prefix `D`.
 */
export const projectDeliverables = pgTable(
  'project_deliverables',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 255 })
      .notNull()
      .references(() => projects.id),
    number: integer('number').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    ownerId: varchar('owner_id', { length: 255 }),
    status: varchar('status', { length: 20 }).$type<DeliverableStatus>().notNull().default('not_started'),
    plannedStart: timestamp('planned_start', { withTimezone: true }),
    plannedEnd: timestamp('planned_end', { withTimezone: true }),
    acceptanceCriteria: jsonb('acceptance_criteria').$type<AcceptanceCriterion[]>().notNull().default([]),
    acceptedBy: varchar('accepted_by', { length: 255 }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    position: integer('position').notNull().default(0),
    clientVisible: boolean('client_visible').notNull().default(false),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('project_deliverables_project_number_idx').on(table.projectId, table.number),
    index('project_deliverables_project_status_idx').on(table.projectId, table.status),
    check(
      'project_deliverables_status_check',
      sql`${table.status} in ('not_started', 'in_progress', 'accepted', 'rejected')`,
    ),
  ],
);

export type ProjectDeliverable = typeof projectDeliverables.$inferSelect;
export type NewProjectDeliverable = typeof projectDeliverables.$inferInsert;

// ── Scope statement ─────────────────────────────────────────────────────────

/** An item that is deliberately out of scope, with the reason, and optionally the object it relates to. */
export interface OutOfScopeItem {
  text: string;
  reason?: string | null;
  linkType?: string | null;
  linkId?: string | null;
}

/**
 * One row per project: the scope statement and the in and out of scope lists.
 * Not soft deleted: the row is the project's scope, edited in place (the
 * versions live in `project_baselines`), and the unique index on `project_id`
 * is what makes it one per project.
 */
export const projectScope = pgTable(
  'project_scope',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 255 })
      .notNull()
      .references(() => projects.id),
    statement: text('statement'),
    inScope: jsonb('in_scope').$type<string[]>().notNull().default([]),
    outOfScope: jsonb('out_of_scope').$type<OutOfScopeItem[]>().notNull().default([]),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    updatedBy: varchar('updated_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('project_scope_project_idx').on(table.projectId)],
);

export type ProjectScope = typeof projectScope.$inferSelect;
export type NewProjectScope = typeof projectScope.$inferInsert;

// ── Baselines ───────────────────────────────────────────────────────────────

/** What a baseline version froze (FLOW-012). Dates are ISO strings, amounts decimal strings. */
export interface BaselineSnapshot {
  /** The project's go-live (its end date). */
  goLive: string | null;
  milestones: Array<{ id: string; name: string; dueDate: string }>;
  deliverables: Array<{
    id: string;
    number: number;
    title: string;
    plannedStart: string | null;
    plannedEnd: string | null;
  }>;
  budgetedAmount: string | null;
  budgetedHours: string | null;
  budgetCurrency: string | null;
  scopeStatement: string | null;
}

/**
 * One row per baseline version: scope, plan and budget agreed at one moment
 * (FLOW-012). Immutable and never deleted. v1 is set when the project manager
 * signs off the plan; later versions come only from an approved change request
 * (`change_request_id`, null for v1).
 */
export const projectBaselines = pgTable(
  'project_baselines',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 255 })
      .notNull()
      .references(() => projects.id),
    version: integer('version').notNull(),
    changeRequestId: varchar('change_request_id', { length: 30 }).references(() => projectChangeRequests.id),
    snapshot: jsonb('snapshot').$type<BaselineSnapshot>().notNull(),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('project_baselines_project_version_idx').on(table.projectId, table.version)],
);

export type ProjectBaseline = typeof projectBaselines.$inferSelect;
export type NewProjectBaseline = typeof projectBaselines.$inferInsert;

// ── Benefits ────────────────────────────────────────────────────────────────

export const BENEFIT_STATUSES = ['planned', 'measuring', 'at_risk', 'realised', 'closed'] as const;
export type BenefitStatus = (typeof BENEFIT_STATUSES)[number];

/**
 * A benefit of the project (business value). `metric` is a key of the metric
 * catalogue in flow-domain (`benefit-metrics`, FLOW-014) or `manual`;
 * `metric_params` are that metric's parameters. `goal_ref` is the id of a goal
 * card in `project_goals.goals` (jsonb, so no foreign key). Realised and
 * closed benefits stop being measured (`closed_at`). Numbers: scope
 * `ben:<projectId>`, prefix `B-`.
 */
export const projectBenefits = pgTable(
  'project_benefits',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    projectId: varchar('project_id', { length: 255 })
      .notNull()
      .references(() => projects.id),
    number: integer('number').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    ownerId: varchar('owner_id', { length: 255 }),
    goalRef: varchar('goal_ref', { length: 255 }),
    metric: varchar('metric', { length: 60 }).notNull().default('manual'),
    metricParams: jsonb('metric_params').$type<Record<string, unknown>>().notNull().default({}),
    unit: varchar('unit', { length: 30 }),
    baselineValue: numeric('baseline_value', { precision: 18, scale: 4 }),
    targetValue: numeric('target_value', { precision: 18, scale: 4 }),
    realiseBy: timestamp('realise_by', { withTimezone: true }),
    status: varchar('status', { length: 20 }).$type<BenefitStatus>().notNull().default('planned'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdBy: varchar('created_by', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('project_benefits_project_number_idx').on(table.projectId, table.number),
    index('project_benefits_project_status_idx').on(table.projectId, table.status),
    index('project_benefits_status_idx').on(table.status),
    check('project_benefits_status_check', sql`${table.status} in ('planned', 'measuring', 'at_risk', 'realised', 'closed')`),
  ],
);

export type ProjectBenefit = typeof projectBenefits.$inferSelect;
export type NewProjectBenefit = typeof projectBenefits.$inferInsert;

/**
 * Append-only, one row per benefit and month (the monthly sweep, or a manual
 * entry). `period` is `YYYY-MM`. A re-run for the same month replaces the row
 * (upsert on the unique index). `measured_by` is set for a manual entry and
 * null for the sweep. No soft delete.
 */
export const projectBenefitMeasurements = pgTable(
  'project_benefit_measurements',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    benefitId: varchar('benefit_id', { length: 30 })
      .notNull()
      .references(() => projectBenefits.id),
    projectId: varchar('project_id', { length: 255 })
      .notNull()
      .references(() => projects.id),
    period: varchar('period', { length: 7 }).notNull(),
    value: numeric('value', { precision: 18, scale: 4 }).notNull(),
    measuredAt: timestamp('measured_at', { withTimezone: true }).notNull().defaultNow(),
    measuredBy: varchar('measured_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('project_benefit_measurements_benefit_period_idx').on(table.benefitId, table.period),
    index('project_benefit_measurements_project_idx').on(table.projectId),
    check('project_benefit_measurements_period_check', sql`${table.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  ],
);

export type ProjectBenefitMeasurement = typeof projectBenefitMeasurements.$inferSelect;
export type NewProjectBenefitMeasurement = typeof projectBenefitMeasurements.$inferInsert;
