/**
 * WeldFlow project control, governance and scope: the decision log, the
 * deliverables, the scope statement and the benefits with their measurements
 * (slice B). Request schemas for `/api/project-decisions`,
 * `/api/project-deliverables`, `/api/project-scope` and `/api/project-benefits`,
 * and the shapes they answer. Design: weldsuite-documentation
 * `design/modules/weldflow-project-control.md`, ADRs FLOW-011, FLOW-014 and
 * FLOW-016.
 *
 * Request bodies are `.strict()`, as the RAID schemas are: a field the API does
 * not accept is a 400 and never silently dropped.
 */

import { z } from 'zod';
import { CONTROL_LINK_TYPES, controlLinkSchema, linkedObjectSchema } from './project-control';

// ── Vocabulary ──────────────────────────────────────────────────────────────

export const DECISION_STATUSES = ['proposed', 'decided', 'superseded'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const DELIVERABLE_STATUSES = ['not_started', 'in_progress', 'accepted', 'rejected'] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

export const BENEFIT_STATUSES = ['planned', 'measuring', 'at_risk', 'realised', 'closed'] as const;
export type BenefitStatus = (typeof BENEFIT_STATUSES)[number];

/** The statuses in which a benefit is still measured (`closed_at` is null). */
export const BENEFIT_OPEN_STATUSES = ['planned', 'measuring', 'at_risk'] as const;

/**
 * The metric catalogue keys (`@weldsuite/flow-domain/benefit-metrics`, FLOW-014).
 * `manual` has no query: its values are typed in.
 */
export const BENEFIT_METRICS = [
  'manual',
  'desk_tickets_by_tag',
  'commerce_repeat_online_share',
  'books_days_to_pay',
  'books_supplier_cost',
  'time_hours_per_week_by_tag',
] as const;
export type BenefitMetric = (typeof BENEFIT_METRICS)[number];

/** What an out-of-scope item can point at. */
export const SCOPE_LINK_TYPES = ['decision', 'change_request', 'project'] as const;
export type ScopeLinkType = (typeof SCOPE_LINK_TYPES)[number];

// ── Building blocks ─────────────────────────────────────────────────────────

const isoDateTime = z.string().datetime({ offset: true });
const identifier = z.string().min(1).max(255);
const title = z.string().trim().min(1).max(255);
const longText = z.string().max(10_000);
/** A numeric value as the API takes it: a finite number with at most four decimals is stored. */
const metricValue = z.number().finite().min(-999_999_999_999).max(999_999_999_999);
/** A month, `YYYY-MM`. */
export const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'period must be a month, YYYY-MM');

// ── Decisions ───────────────────────────────────────────────────────────────

export const decisionOptionSchema = z
  .object({
    title: z.string().trim().min(1).max(255),
    note: z.string().trim().max(2_000).nullish(),
    chosen: z.boolean().optional(),
  })
  .strict();

const decisionConsequence = z.string().trim().min(1).max(1_000);

/**
 * `POST /api/project-decisions`. A decision is `proposed` (the default, with
 * an optional named decider who is asked for it) or recorded as `decided`
 * straight away, with the option that was taken marked `chosen`.
 */
export const createDecisionSchema = z
  .object({
    projectId: identifier,
    title,
    context: longText.nullish(),
    options: z.array(decisionOptionSchema).max(20).optional(),
    consequences: z.array(decisionConsequence).max(50).optional(),
    status: z.enum(['proposed', 'decided']).optional(),
    /** Proposed only: the member who has to decide. */
    deciderId: identifier.nullish(),
    /** Proposed only: the reminder date. */
    decisionDueAt: isoDateTime.nullish(),
    /** Decided only: who decided. Defaults to the caller. */
    decidedBy: identifier.nullish(),
    /** Decided only: when. Defaults to now. */
    decidedAt: isoDateTime.nullish(),
  })
  .strict();

/**
 * `PATCH /api/project-decisions/:id`. While a decision is proposed everything
 * here can change; once decided only the title, context and consequences can.
 */
export const updateDecisionSchema = z
  .object({
    title: title.optional(),
    context: longText.nullish(),
    options: z.array(decisionOptionSchema).max(20).optional(),
    consequences: z.array(decisionConsequence).max(50).optional(),
    deciderId: identifier.nullish(),
    decisionDueAt: isoDateTime.nullish(),
  })
  .strict();

/**
 * `POST /api/project-decisions/:id/decide`. `chosenIndex` is the position of
 * the option taken (needed when the decision has options and none is marked
 * chosen yet).
 */
export const decideDecisionSchema = z
  .object({
    chosenIndex: z.number().int().min(0).max(19).optional(),
    decidedBy: identifier.optional(),
    decidedAt: isoDateTime.optional(),
  })
  .strict();

/** `POST /api/project-decisions/:id/supersede`. */
export const supersedeDecisionSchema = z.object({ supersededById: identifier }).strict();

const nullableString = z.string().nullable();

export const decisionOptionResultSchema = z.object({
  title: z.string(),
  note: nullableString,
  chosen: z.boolean(),
});

/** A decision as every route answers it. */
export const decisionSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    number: z.number().int(),
    code: z.string(),
    title: z.string(),
    status: z.enum(DECISION_STATUSES),
    context: nullableString,
    options: z.array(decisionOptionResultSchema),
    consequences: z.array(z.string()),
    deciderId: nullableString,
    decidedBy: nullableString,
    decidedAt: nullableString,
    decisionDueAt: nullableString,
    supersededById: nullableString,
    createdBy: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: nullableString,
  })
  .passthrough();

/** The answer of one approver of a proposed decision. */
export const decisionApprovalSchema = z.object({
  id: z.string(),
  approverId: z.string(),
  decision: z.string(),
  note: nullableString,
  dueAt: nullableString,
  decidedAt: nullableString,
  delegatedFrom: nullableString,
});

/** A decision named by another: the one that replaced it, or the ones it replaced. */
export const decisionRefSchema = z.object({
  id: z.string(),
  code: z.string(),
  title: z.string(),
});

/** `GET /api/project-decisions/:id`. */
export const decisionDetailSchema = decisionSchema.and(
  z.object({
    /** Oldest link first. A link whose other end was deleted or is out of reach is left out. */
    links: z.array(linkedObjectSchema),
    approvals: z.array(decisionApprovalSchema),
    supersededBy: decisionRefSchema.nullable(),
    supersedes: z.array(decisionRefSchema),
  }),
);

export type CreateDecisionInput = z.infer<typeof createDecisionSchema>;
export type UpdateDecisionInput = z.infer<typeof updateDecisionSchema>;
export type DecideDecisionInput = z.infer<typeof decideDecisionSchema>;
export type SupersedeDecisionInput = z.infer<typeof supersedeDecisionSchema>;
export type DecisionOptionInput = z.infer<typeof decisionOptionSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type DecisionDetail = z.infer<typeof decisionDetailSchema>;
export type DecisionApproval = z.infer<typeof decisionApprovalSchema>;

// ── Deliverables ────────────────────────────────────────────────────────────

export const acceptanceCriterionInputSchema = z
  .object({
    text: z.string().trim().min(1).max(1_000),
    met: z.boolean().optional(),
  })
  .strict();

const deliverableFields = {
  description: longText.nullish(),
  ownerId: identifier.nullish(),
  plannedStart: isoDateTime.nullish(),
  plannedEnd: isoDateTime.nullish(),
  acceptanceCriteria: z.array(acceptanceCriterionInputSchema).max(50).optional(),
  clientVisible: z.boolean().optional(),
  position: z.number().int().min(0).max(100_000).optional(),
};

/** `POST /api/project-deliverables`. */
export const createDeliverableSchema = z
  .object({
    projectId: identifier,
    title,
    status: z.enum(['not_started', 'in_progress']).optional(),
    ...deliverableFields,
  })
  .strict();

/**
 * `PATCH /api/project-deliverables/:id`. Acceptance and rejection have their
 * own routes. Once accepted only `clientVisible` and `position` can change.
 */
export const updateDeliverableSchema = z
  .object({
    title: title.optional(),
    status: z.enum(['not_started', 'in_progress']).optional(),
    ...deliverableFields,
  })
  .strict();

/**
 * `POST /api/project-deliverables/:id/request-signoff`: the sponsor signs off
 * first (step 1), then, when `contactId` is given, that client contact
 * (step 2). `dueAt` is the answer date shown in My reviews.
 */
export const requestSignoffSchema = z
  .object({
    contactId: identifier.optional(),
    dueAt: isoDateTime.optional(),
  })
  .strict();

/** `POST /api/project-deliverables/:id/reject`. The note goes in the entity event. */
export const rejectDeliverableSchema = z.object({ note: z.string().trim().max(2_000).optional() }).strict();

export const acceptanceCriterionSchema = z.object({
  text: z.string(),
  met: z.boolean(),
  metAt: nullableString,
});

export const deliverableTaskProgressSchema = z.object({ done: z.number().int(), total: z.number().int() });

/** A register item that affects a deliverable, as the Scope table shows it. */
export const deliverableRaidSchema = z.object({
  id: z.string(),
  kind: z.string(),
  code: z.string(),
  title: z.string(),
});

/** A deliverable as every route answers it. */
export const deliverableSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    number: z.number().int(),
    code: z.string(),
    title: z.string(),
    description: nullableString,
    ownerId: nullableString,
    status: z.enum(DELIVERABLE_STATUSES),
    plannedStart: nullableString,
    plannedEnd: nullableString,
    acceptanceCriteria: z.array(acceptanceCriterionSchema),
    acceptedBy: nullableString,
    acceptedAt: nullableString,
    position: z.number().int(),
    clientVisible: z.boolean(),
    createdBy: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: nullableString,
    /** Live, non-cancelled tasks with this deliverable, and how many are done. */
    taskProgress: deliverableTaskProgressSchema,
    criteriaMet: z.number().int(),
    criteriaTotal: z.number().int(),
    /** Register items linked with `affects` or `threatens`. */
    raid: z.array(deliverableRaidSchema),
  })
  .passthrough();

/** One answer of a deliverable's sign-off. */
export const signoffApprovalSchema = z.object({
  id: z.string(),
  approverKind: z.string(),
  approverId: z.string(),
  roleLabel: nullableString,
  step: z.number().int(),
  decision: z.string(),
  note: nullableString,
  dueAt: nullableString,
  decidedAt: nullableString,
});

/** `GET /api/project-deliverables/:id`. */
export const deliverableDetailSchema = deliverableSchema.and(
  z.object({
    links: z.array(linkedObjectSchema),
    signoff: z.array(signoffApprovalSchema),
  }),
);

/** `POST /api/project-deliverables/:id/request-signoff`. */
export const requestSignoffResultSchema = z.object({
  deliverable: deliverableSchema,
  signoff: z.array(signoffApprovalSchema),
});

export type CreateDeliverableInput = z.infer<typeof createDeliverableSchema>;
export type UpdateDeliverableInput = z.infer<typeof updateDeliverableSchema>;
export type RequestSignoffInput = z.infer<typeof requestSignoffSchema>;
export type RejectDeliverableInput = z.infer<typeof rejectDeliverableSchema>;
export type AcceptanceCriterionInput = z.infer<typeof acceptanceCriterionInputSchema>;
export type Deliverable = z.infer<typeof deliverableSchema>;
export type DeliverableDetail = z.infer<typeof deliverableDetailSchema>;
export type SignoffApproval = z.infer<typeof signoffApprovalSchema>;

// ── Scope ───────────────────────────────────────────────────────────────────

export const outOfScopeItemInputSchema = z
  .object({
    text: z.string().trim().min(1).max(1_000),
    reason: z.string().trim().max(1_000).nullish(),
    linkType: z.enum(SCOPE_LINK_TYPES).nullish(),
    linkId: identifier.nullish(),
  })
  .strict();

const scopeListItem = z.string().trim().min(1).max(1_000);

/**
 * `PUT /api/project-scope/:projectId`: the scope of the project, created on
 * first save. A list left out stays as it is; `statement: null` clears it.
 */
export const putScopeSchema = z
  .object({
    statement: longText.nullish(),
    inScope: z.array(scopeListItem).max(200).optional(),
    outOfScope: z.array(outOfScopeItemInputSchema).max(200).optional(),
  })
  .strict();

/** What an out-of-scope item points at, as far as the UI shows it. */
export const outOfScopeLinkSchema = z.object({
  type: z.enum(SCOPE_LINK_TYPES),
  id: z.string(),
  /** `DEC-3` or `CR-3`; null for a project. */
  code: nullableString,
  title: z.string(),
  status: nullableString,
});

export const outOfScopeItemSchema = z.object({
  text: z.string(),
  reason: nullableString,
  linkType: nullableString,
  linkId: nullableString,
  /** Null when the item has no link, or the linked object is gone or out of reach. */
  link: outOfScopeLinkSchema.nullable(),
});

/** The scope of a project; before the first save `id` and the audit fields are null. */
export const scopeSchema = z
  .object({
    id: nullableString,
    projectId: z.string(),
    statement: nullableString,
    inScope: z.array(z.string()),
    outOfScope: z.array(outOfScopeItemSchema),
    createdBy: nullableString,
    updatedBy: nullableString,
    createdAt: nullableString,
    updatedAt: nullableString,
  })
  .passthrough();

export type PutScopeInput = z.infer<typeof putScopeSchema>;
export type OutOfScopeItemInput = z.infer<typeof outOfScopeItemInputSchema>;
export type Scope = z.infer<typeof scopeSchema>;

// ── Benefits ────────────────────────────────────────────────────────────────

/**
 * The parameters of each catalogue metric (`metric_params`). The catalogue
 * (`@weldsuite/flow-domain/benefit-metrics`) says how each is measured.
 */
export const BENEFIT_METRIC_PARAMS = {
  manual: z.object({}).strict(),
  desk_tickets_by_tag: z.object({ tag: z.string().trim().min(1).max(100) }).strict(),
  commerce_repeat_online_share: z
    .object({ sources: z.array(z.string().trim().min(1).max(50)).min(1).max(20).optional() })
    .strict(),
  books_days_to_pay: z.object({}).strict(),
  books_supplier_cost: z.object({ supplierId: identifier }).strict(),
  time_hours_per_week_by_tag: z.object({ tag: z.string().trim().min(1).max(100) }).strict(),
} as const satisfies Record<BenefitMetric, z.ZodTypeAny>;

const benefitFields = {
  description: longText.nullish(),
  ownerId: identifier.nullish(),
  /** The id of a goal card on the Goals page. */
  goalRef: identifier.nullish(),
  metric: z.enum(BENEFIT_METRICS).optional(),
  metricParams: z.record(z.unknown()).optional(),
  unit: z.string().trim().max(30).nullish(),
  baselineValue: metricValue.nullish(),
  targetValue: metricValue.nullish(),
  realiseBy: isoDateTime.nullish(),
};

/** `POST /api/project-benefits`. A benefit starts `planned`, or `measuring` when it is already being tracked. */
export const createBenefitSchema = z
  .object({
    projectId: identifier,
    title,
    status: z.enum(['planned', 'measuring']).optional(),
    ...benefitFields,
  })
  .strict();

/**
 * `PATCH /api/project-benefits/:id`. `realised` and `closed` end the
 * measuring; setting a status that is open again resumes it. Changing the
 * metric needs its parameters in the same request.
 */
export const updateBenefitSchema = z
  .object({
    title: title.optional(),
    status: z.enum(BENEFIT_STATUSES).optional(),
    ...benefitFields,
  })
  .strict();

/** `POST /api/project-benefits/:id/measurements`: a manual value for a month, replacing the month's value. */
export const createMeasurementSchema = z.object({ period: periodSchema, value: metricValue }).strict();

/** `GET /api/project-benefits/goal-targets`. */
export const goalTargetsQuerySchema = z.object({ projectId: z.string().min(1) });

const measurementValue = z.string().nullable();

/** One month of a benefit. `value` is the numeric column's string (four decimals). */
export const benefitMeasurementSchema = z
  .object({
    id: z.string(),
    benefitId: z.string(),
    projectId: z.string(),
    period: z.string(),
    value: z.string(),
    measuredAt: z.string(),
    measuredBy: nullableString,
  })
  .passthrough();

/** The newest measurement of a benefit. */
export const benefitLatestSchema = z.object({ period: z.string(), value: z.string(), measuredAt: z.string() });

/** A benefit as every route answers it. */
export const benefitSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    number: z.number().int(),
    code: z.string(),
    title: z.string(),
    description: nullableString,
    ownerId: nullableString,
    goalRef: nullableString,
    metric: z.string(),
    metricParams: z.record(z.unknown()),
    unit: nullableString,
    baselineValue: measurementValue,
    targetValue: measurementValue,
    realiseBy: nullableString,
    status: z.enum(BENEFIT_STATUSES),
    closedAt: nullableString,
    createdBy: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: nullableString,
    /** The newest measurement, null before the first. */
    latest: benefitLatestSchema.nullable(),
    /** How far the latest value is from the baseline toward the target, 0 to 100; null when it cannot be told. */
    progressPct: z.number().int().nullable(),
  })
  .passthrough();

/** `GET /api/project-benefits/:id`. */
export const benefitDetailSchema = benefitSchema.and(
  z.object({
    /** Oldest month first. */
    measurements: z.array(benefitMeasurementSchema),
    links: z.array(linkedObjectSchema),
  }),
);

/** `POST /api/project-benefits/:id/measurements`. */
export const createMeasurementResultSchema = z.object({
  measurement: benefitMeasurementSchema,
  benefit: benefitSchema,
});

// ── Goal targets ────────────────────────────────────────────────────────────

/**
 * A task filter of a goal target: the tasks of the project that match every
 * field given. At least one field is needed.
 */
export const goalTaskFilterSchema = z
  .object({
    deliverableId: identifier.optional(),
    milestoneId: identifier.optional(),
    sprintId: identifier.optional(),
    assigneeId: identifier.optional(),
    tag: z.string().trim().min(1).max(100).optional(),
    type: z.string().trim().min(1).max(50).optional(),
  })
  .strict()
  .refine((filter) => Object.keys(filter).length > 0, { message: 'A task filter needs at least one field' });

/**
 * A target on a goal card (`project_goals.goals[].targets[]`): a benefit, or a
 * task filter with a label. Progress is computed on read, never typed in.
 */
export const goalTargetSchema = z.union([
  z.object({ benefitId: identifier }).strict(),
  z.object({ label: z.string().trim().min(1).max(255), taskFilter: goalTaskFilterSchema }).strict(),
]);

export type GoalTarget = z.infer<typeof goalTargetSchema>;
export type GoalTaskFilter = z.infer<typeof goalTaskFilterSchema>;

/** The computed state of one target. */
export const goalTargetProgressSchema = z.object({
  index: z.number().int(),
  kind: z.enum(['benefit', 'task']),
  label: z.string(),
  /** Benefit targets. */
  benefitId: nullableString,
  code: nullableString,
  metric: nullableString,
  unit: nullableString,
  baselineValue: measurementValue,
  currentValue: measurementValue,
  targetValue: measurementValue,
  status: nullableString,
  /** Task targets. */
  done: z.number().int().nullable(),
  total: z.number().int().nullable(),
  /** 0 to 100; null when it cannot be told (no measurement yet, no target, a benefit that is gone). */
  progressPct: z.number().int().nullable(),
});

export const goalCardTargetsSchema = z.object({
  goalId: z.string(),
  targets: z.array(goalTargetProgressSchema),
});

/** `GET /api/project-benefits/goal-targets`: one entry per goal card that has targets. */
export const goalTargetsResultSchema = z.array(goalCardTargetsSchema);

export type CreateBenefitInput = z.infer<typeof createBenefitSchema>;
export type UpdateBenefitInput = z.infer<typeof updateBenefitSchema>;
export type CreateMeasurementInput = z.infer<typeof createMeasurementSchema>;
export type Benefit = z.infer<typeof benefitSchema>;
export type BenefitDetail = z.infer<typeof benefitDetailSchema>;
export type BenefitMeasurement = z.infer<typeof benefitMeasurementSchema>;
export type GoalTargetProgress = z.infer<typeof goalTargetProgressSchema>;
export type GoalCardTargets = z.infer<typeof goalCardTargetsSchema>;

// Re-exported so the governance pages need one import for the link vocabulary.
export { CONTROL_LINK_TYPES, controlLinkSchema, linkedObjectSchema };
