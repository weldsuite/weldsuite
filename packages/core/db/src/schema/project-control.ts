import {
  pgTable,
  varchar,
  text,
  timestamp,
  smallint,
  integer,
  numeric,
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { projects } from './projects';

/**
 * WeldFlow project control (docs: weldsuite-documentation, design/modules/
 * weldflow-project-control.md; ADRs FLOW-010 and FLOW-011).
 *
 * Phase 1: the RAID log (risks, assumptions, issues, dependencies) and the
 * links between register items and the tasks and milestones they affect.
 * Tenant DB only. Item numbers (RSK-4, A-1, ISS-2, DEP-3) are per project and
 * per kind, allocated from `task_number_sequences` under the scope keys
 * `rsk:<projectId>`, `asm:<projectId>`, `iss:<projectId>` and `dep:<projectId>`.
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
