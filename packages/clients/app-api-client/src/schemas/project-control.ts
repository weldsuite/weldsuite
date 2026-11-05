/**
 * WeldFlow project control, phase 1: the RAID log (risks, assumptions, issues,
 * dependencies) and the links between register items, tasks and milestones.
 *
 * Request schemas for `/api/project-raid` and `/api/project-control-links`,
 * and the shapes they answer. Design: weldsuite-documentation
 * `design/modules/weldflow-project-control.md`, ADRs FLOW-010 and FLOW-011.
 *
 * Request bodies are `.strict()`: a field of another kind (a `strategy` on an
 * assumption), or one the API does not accept (`id`, `status` on a convert),
 * is a 400 and never silently dropped.
 */

import { z } from 'zod';

// ── Vocabulary ──────────────────────────────────────────────────────────────

export const RAID_KINDS = ['risk', 'assumption', 'issue', 'dependency'] as const;
export type RaidKind = (typeof RAID_KINDS)[number];

/** Statuses per kind in lifecycle order; the first is where a new item starts. */
export const RAID_STATUSES = {
  risk: ['identified', 'assessing', 'mitigating', 'monitoring', 'occurred', 'closed'],
  assumption: ['open', 'validated', 'invalid'],
  issue: ['open', 'in_progress', 'resolved', 'closed'],
  dependency: ['open', 'at_risk', 'delivered', 'closed'],
} as const satisfies Record<RaidKind, readonly string[]>;

/** The statuses that end an item's life in the register (it then has a `closedAt`). */
export const RAID_CLOSED_STATUSES = {
  risk: ['occurred', 'closed'],
  assumption: ['validated', 'invalid'],
  issue: ['resolved', 'closed'],
  dependency: ['delivered', 'closed'],
} as const satisfies Record<RaidKind, readonly string[]>;

export const RISK_BANDS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskBand = (typeof RISK_BANDS)[number];

export const RISK_STRATEGIES = ['avoid', 'mitigate', 'transfer', 'accept'] as const;
export const ASSUMPTION_CONFIDENCES = ['low', 'medium', 'high'] as const;
export const ISSUE_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export const DEPENDENCY_DIRECTIONS = ['inbound', 'outbound'] as const;
export const DEPENDENCY_PARTY_TYPES = ['project', 'supplier', 'team', 'customer'] as const;

// ── Risk categories ─────────────────────────────────────────────────────────

/**
 * The built-in risk categories. A risk stores one by key and every locale
 * labels it; a workspace may hide some and add its own (stored by name).
 * `/api/project-raid/categories` reads and changes that list.
 */
export const RISK_CATEGORIES = ['technical', 'schedule', 'budget', 'scope', 'resource', 'compliance', 'external'] as const;
export type BuiltInRiskCategory = (typeof RISK_CATEGORIES)[number];

/** At most this many custom categories per workspace. */
export const MAX_CUSTOM_RISK_CATEGORIES = 50;

/**
 * The whole list, replaced in one go. A custom category keeps its `id` across
 * saves (a new one has none); giving a kept id a new name renames it on every
 * risk that carries the old name. Leaving one out deletes it from the list,
 * and the risks that carry it keep the name.
 */
export const updateRiskCategoriesSchema = z
  .object({
    hidden: z.array(z.enum(RISK_CATEGORIES)).max(RISK_CATEGORIES.length),
    custom: z
      .array(
        z
          .object({
            id: z.string().min(1).max(30).optional(),
            name: z.string().trim().min(1).max(100),
          })
          .strict(),
      )
      .max(MAX_CUSTOM_RISK_CATEGORIES),
  })
  .strict();
export type UpdateRiskCategoriesInput = z.infer<typeof updateRiskCategoriesSchema>;

export const riskCategoriesSchema = z.object({
  /** Every built-in, in `RISK_CATEGORIES` order. */
  builtIn: z.array(z.object({ key: z.enum(RISK_CATEGORIES), hidden: z.boolean() })),
  /** The workspace's own, in the order it saved them. */
  custom: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type RiskCategories = z.infer<typeof riskCategoriesSchema>;

/** What a control link can join. */
export const CONTROL_LINK_TYPES = [
  'raid_item',
  'task',
  'milestone',
  'decision',
  'change_request',
  'deliverable',
  'benefit',
] as const;
export type ControlLinkType = (typeof CONTROL_LINK_TYPES)[number];

export const CONTROL_LINK_RELATIONS = [
  'mitigates',
  'resolves',
  'raised_from',
  'affects',
  'threatens',
  'implements',
  'decided_by',
] as const;
export type ControlLinkRelation = (typeof CONTROL_LINK_RELATIONS)[number];

/** Task priorities a mitigation task can be created with. */
export const RAID_TASK_PRIORITIES = ['critical', 'high', 'medium', 'low', 'none'] as const;

// ── Building blocks ─────────────────────────────────────────────────────────

/** A probability or an impact: a whole number from 1 to 5. */
const rating = z.number().int().min(1).max(5);
/** An RFC 3339 timestamp, `Z` or an offset (`2026-11-10T09:00:00Z`). */
const isoDateTime = z.string().datetime({ offset: true });
const identifier = z.string().min(1).max(255);
const title = z.string().trim().min(1).max(255);
/** A money amount in the project currency: a non-negative number with at most 2 decimals is stored. */
const amount = z.number().finite().min(0).max(9_999_999_999_999);

const commonCreateFields = {
  projectId: identifier,
  title,
  description: z.string().max(10_000).nullish(),
  category: z.string().trim().max(100).nullish(),
  ownerId: identifier.nullish(),
  /** Next review (risk), validate by (assumption), resolve by (issue) or needed by (dependency). */
  dueAt: isoDateTime.nullish(),
  customFields: z.record(z.unknown()).nullish(),
};

const commonUpdateFields = {
  title: title.optional(),
  description: z.string().max(10_000).nullish(),
  category: z.string().trim().max(100).nullish(),
  ownerId: identifier.nullish(),
  dueAt: isoDateTime.nullish(),
  customFields: z.record(z.unknown()).nullish(),
};

const riskFields = {
  residualProbability: rating.nullish(),
  residualImpact: rating.nullish(),
  strategy: z.enum(RISK_STRATEGIES).nullish(),
  trigger: z.string().max(2_000).nullish(),
  costImpact: amount.nullish(),
  scheduleImpactDays: z.number().int().min(0).max(3_650).nullish(),
  /** Overrides the band's default review interval. */
  reviewIntervalDays: z.number().int().min(1).max(365).nullish(),
};

const assumptionFields = {
  confidence: z.enum(ASSUMPTION_CONFIDENCES).nullish(),
  ifWrong: z.string().max(10_000).nullish(),
};

const dependencyFields = {
  partyType: z.enum(DEPENDENCY_PARTY_TYPES).nullish(),
  /** Another project in the workspace; only with `partyType: 'project'`. */
  partyProjectId: identifier.nullish(),
  partyName: z.string().trim().max(255).nullish(),
};

// ── Create ──────────────────────────────────────────────────────────────────

export const createRiskSchema = z
  .object({
    kind: z.literal('risk'),
    ...commonCreateFields,
    status: z.enum(RAID_STATUSES.risk).optional(),
    probability: rating,
    impact: rating,
    ...riskFields,
  })
  .strict();

export const createAssumptionSchema = z
  .object({
    kind: z.literal('assumption'),
    ...commonCreateFields,
    status: z.enum(RAID_STATUSES.assumption).optional(),
    ...assumptionFields,
  })
  .strict();

export const createIssueSchema = z
  .object({
    kind: z.literal('issue'),
    ...commonCreateFields,
    status: z.enum(RAID_STATUSES.issue).optional(),
    /** Defaults to `medium`. */
    severity: z.enum(ISSUE_SEVERITIES).optional(),
    escalatedAt: isoDateTime.nullish(),
  })
  .strict();

export const createDependencySchema = z
  .object({
    kind: z.literal('dependency'),
    ...commonCreateFields,
    status: z.enum(RAID_STATUSES.dependency).optional(),
    direction: z.enum(DEPENDENCY_DIRECTIONS),
    ...dependencyFields,
  })
  .strict();

/** `POST /api/project-raid`. The `kind` picks the fields that apply. */
export const createRaidItemSchema = z.discriminatedUnion('kind', [
  createRiskSchema,
  createAssumptionSchema,
  createIssueSchema,
  createDependencySchema,
]);

// ── Update ──────────────────────────────────────────────────────────────────

export const updateRiskSchema = z
  .object({
    ...commonUpdateFields,
    status: z.enum(RAID_STATUSES.risk).optional(),
    probability: rating.optional(),
    impact: rating.optional(),
    ...riskFields,
  })
  .strict();

export const updateAssumptionSchema = z
  .object({
    ...commonUpdateFields,
    status: z.enum(RAID_STATUSES.assumption).optional(),
    ...assumptionFields,
  })
  .strict();

export const updateIssueSchema = z
  .object({
    ...commonUpdateFields,
    status: z.enum(RAID_STATUSES.issue).optional(),
    severity: z.enum(ISSUE_SEVERITIES).optional(),
    escalatedAt: isoDateTime.nullish(),
  })
  .strict();

export const updateDependencySchema = z
  .object({
    ...commonUpdateFields,
    status: z.enum(RAID_STATUSES.dependency).optional(),
    direction: z.enum(DEPENDENCY_DIRECTIONS).optional(),
    ...dependencyFields,
  })
  .strict();

/**
 * `PATCH /api/project-raid/:id`. The kind of an item never changes, so the
 * route validates the body against the schema of the stored kind.
 */
export const updateRaidItemSchemas = {
  risk: updateRiskSchema,
  assumption: updateAssumptionSchema,
  issue: updateIssueSchema,
  dependency: updateDependencySchema,
} as const satisfies Record<RaidKind, z.ZodTypeAny>;

// ── Assess, convert, tasks, links ───────────────────────────────────────────

/**
 * `POST /api/project-raid/:id/assess`. Residual values left out stay as they
 * are; `null` clears them. `nextReviewAt` replaces the default next review
 * (now plus the review interval of the new band).
 */
export const assessRiskSchema = z
  .object({
    probability: rating,
    impact: rating,
    residualProbability: rating.nullish(),
    residualImpact: rating.nullish(),
    note: z.string().trim().max(2_000).nullish(),
    nextReviewAt: isoDateTime.optional(),
  })
  .strict();

/**
 * `POST /api/project-raid/:id/convert`. The new item starts from the source's
 * title, description, category and owner unless the body overrides them.
 * `probability` and `impact` are required (and only allowed) for `to: 'risk'`;
 * `severity` is only allowed for `to: 'issue'` and defaults to the risk's band.
 */
export const convertRaidItemSchema = z
  .object({
    to: z.enum(['risk', 'issue']),
    title: title.optional(),
    description: z.string().max(10_000).nullish(),
    category: z.string().trim().max(100).nullish(),
    ownerId: identifier.nullish(),
    dueAt: isoDateTime.nullish(),
    probability: rating.optional(),
    impact: rating.optional(),
    severity: z.enum(ISSUE_SEVERITIES).optional(),
  })
  .strict();

/** `POST /api/project-raid/:id/tasks`: a mitigation task (risk) or resolution task (issue). */
export const createRaidTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(10_000).nullish(),
    assigneeId: identifier.nullish(),
    dueDate: isoDateTime.nullish(),
    priority: z.enum(RAID_TASK_PRIORITIES).optional(),
  })
  .strict();

/** `POST /api/project-control-links`. */
export const createControlLinkSchema = z
  .object({
    fromType: z.enum(CONTROL_LINK_TYPES),
    fromId: identifier,
    toType: z.enum(CONTROL_LINK_TYPES),
    toId: identifier,
    relation: z.enum(CONTROL_LINK_RELATIONS),
  })
  .strict();

export type CreateRaidItemInput = z.infer<typeof createRaidItemSchema>;
export type CreateRiskInput = z.infer<typeof createRiskSchema>;
export type CreateAssumptionInput = z.infer<typeof createAssumptionSchema>;
export type CreateIssueInput = z.infer<typeof createIssueSchema>;
export type CreateDependencyInput = z.infer<typeof createDependencySchema>;
export type UpdateRiskInput = z.infer<typeof updateRiskSchema>;
export type UpdateAssumptionInput = z.infer<typeof updateAssumptionSchema>;
export type UpdateIssueInput = z.infer<typeof updateIssueSchema>;
export type UpdateDependencyInput = z.infer<typeof updateDependencySchema>;
export type UpdateRaidItemInput = UpdateRiskInput | UpdateAssumptionInput | UpdateIssueInput | UpdateDependencyInput;
export type AssessRiskInput = z.infer<typeof assessRiskSchema>;
export type ConvertRaidItemInput = z.infer<typeof convertRaidItemSchema>;
export type CreateRaidTaskInput = z.infer<typeof createRaidTaskSchema>;
export type CreateControlLinkInput = z.infer<typeof createControlLinkSchema>;

// ── Responses ───────────────────────────────────────────────────────────────

const nullableString = z.string().nullable();
const nullableInt = z.number().int().nullable();

/** Linked tasks that are done out of all live, non-cancelled tasks linked with `mitigates` or `resolves`. */
export const raidTaskProgressSchema = z.object({
  done: z.number().int(),
  total: z.number().int(),
});

/**
 * A register item as every route answers it: the table row (timestamps as ISO
 * strings, `costImpact` as the numeric column's string) plus `code` (RSK-4),
 * `band` and `residualScore` (risks only) and the task progress.
 */
export const raidItemSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    kind: z.enum(RAID_KINDS),
    number: z.number().int(),
    code: z.string(),
    title: z.string(),
    description: nullableString,
    status: z.string(),
    category: nullableString,
    ownerId: nullableString,
    dueAt: nullableString,
    closedAt: nullableString,
    customFields: z.record(z.unknown()).nullable(),
    probability: nullableInt,
    impact: nullableInt,
    score: nullableInt,
    band: z.enum(RISK_BANDS).nullable(),
    residualProbability: nullableInt,
    residualImpact: nullableInt,
    residualScore: nullableInt,
    strategy: nullableString,
    trigger: nullableString,
    costImpact: nullableString,
    scheduleImpactDays: nullableInt,
    reviewIntervalDays: nullableInt,
    confidence: nullableString,
    ifWrong: nullableString,
    severity: nullableString,
    escalatedAt: nullableString,
    direction: nullableString,
    partyType: nullableString,
    partyProjectId: nullableString,
    partyName: nullableString,
    createdBy: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: nullableString,
    taskProgress: raidTaskProgressSchema,
  })
  .passthrough();

export const raidAssessmentSchema = z
  .object({
    id: z.string(),
    itemId: z.string(),
    projectId: z.string(),
    probability: z.number().int(),
    impact: z.number().int(),
    score: z.number().int(),
    band: z.enum(RISK_BANDS),
    residualProbability: nullableInt,
    residualImpact: nullableInt,
    note: nullableString,
    assessedBy: z.string(),
    assessedAt: z.string(),
  })
  .passthrough();

/** A link row. */
export const controlLinkSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    fromType: z.enum(CONTROL_LINK_TYPES),
    fromId: z.string(),
    toType: z.enum(CONTROL_LINK_TYPES),
    toId: z.string(),
    relation: z.enum(CONTROL_LINK_RELATIONS),
    createdBy: z.string(),
    createdAt: z.string(),
  })
  .passthrough();

/** The other end of a link, as far as the UI needs to show it. */
export const controlLinkTargetSchema = z.object({
  type: z.enum(CONTROL_LINK_TYPES),
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.string(),
  /** `RSK-4`, `DEC-7`, `CR-8`, `D3` or `B-1` for a register item, decision, change request, deliverable or benefit; null for a task or milestone. */
  code: nullableString,
  /** Task: its assignee. Register item: its owner. Milestone: its owner. */
  ownerId: nullableString,
  /** Task: due date. Register item: `dueAt`. Milestone: due date. */
  dueDate: nullableString,
});

/** A link seen from one object: `outgoing` when that object is the `from` end. */
export const linkedObjectSchema = controlLinkSchema.extend({
  direction: z.enum(['outgoing', 'incoming']),
  target: controlLinkTargetSchema,
});

/** `GET /api/project-raid/:id`. */
export const raidItemDetailSchema = raidItemSchema.and(
  z.object({
    /** Newest first. */
    assessments: z.array(raidAssessmentSchema),
    /** Oldest first. A link whose other end was deleted is left out. */
    links: z.array(linkedObjectSchema),
  }),
);

export const raidMatrixCellSchema = z.object({
  probability: z.number().int(),
  impact: z.number().int(),
  count: z.number().int(),
});

/** `GET /api/project-raid/matrix`: always 25 cells, probability then impact ascending. */
export const raidMatrixSchema = z.object({
  residual: z.boolean(),
  /** Open risks counted. */
  total: z.number().int(),
  cells: z.array(raidMatrixCellSchema),
});

/** `POST /api/project-raid/:id/assess`. */
export const raidAssessResultSchema = z.object({
  item: raidItemSchema,
  assessment: raidAssessmentSchema,
});

/** `POST /api/project-raid/:id/convert`. */
export const raidConvertResultSchema = z.object({
  /** The new item. */
  item: raidItemSchema,
  /** The source, now `invalid` (assumption) or `occurred` (risk). */
  source: raidItemSchema,
  /** The `raised_from` link from the new item to the source. */
  link: controlLinkSchema,
});

export const raidTaskSchema = z
  .object({
    id: z.string(),
    number: nullableInt,
    projectId: nullableString,
    title: z.string(),
    status: z.string(),
    priority: z.string(),
    assigneeId: nullableString,
    dueDate: nullableString,
  })
  .passthrough();

/** `POST /api/project-raid/:id/tasks`. */
export const raidTaskResultSchema = z.object({
  task: raidTaskSchema,
  /** `task` → item, relation `mitigates` (risk) or `resolves` (issue). */
  link: controlLinkSchema,
  taskProgress: raidTaskProgressSchema,
});

export type RaidItem = z.infer<typeof raidItemSchema>;
export type RaidItemDetail = z.infer<typeof raidItemDetailSchema>;
export type RaidAssessment = z.infer<typeof raidAssessmentSchema>;
export type RaidMatrix = z.infer<typeof raidMatrixSchema>;
export type RaidAssessResult = z.infer<typeof raidAssessResultSchema>;
export type RaidConvertResult = z.infer<typeof raidConvertResultSchema>;
export type RaidTaskResult = z.infer<typeof raidTaskResultSchema>;
export type ControlLink = z.infer<typeof controlLinkSchema>;
export type LinkedObject = z.infer<typeof linkedObjectSchema>;
