/**
 * WeldFlow approvals, change requests and baselines (slice A of the project
 * management build): the request schemas and response shapes of
 * `/api/approvals`, `/api/project-changes` and `/api/project-baselines`, and
 * of the two risk and project endpoints that belong with them.
 *
 * Design: weldsuite-documentation `design/modules/weldflow-project-control.md`
 * and `weldflow-delivery-and-portfolio.md`; ADRs FLOW-012, FLOW-013, FLOW-016.
 *
 * Request bodies are `.strict()`: a field the API does not accept is a 400 and
 * never silently dropped.
 */

import { z } from 'zod';

// ── Vocabulary ──────────────────────────────────────────────────────────────

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

/** My reviews also lists time entries that wait for a project manager (type `timesheet`). */
export const REVIEW_TYPES = [...APPROVAL_SUBJECT_TYPES, 'timesheet'] as const;
export type ReviewType = (typeof REVIEW_TYPES)[number];

export const APPROVER_KINDS = ['member', 'contact'] as const;
export const APPROVAL_DECISIONS = ['pending', 'approved', 'approved_with_conditions', 'rejected', 'info_requested'] as const;
export type ApprovalDecisionValue = (typeof APPROVAL_DECISIONS)[number];
/** The four answers a reviewer can give (never `pending`). */
export const APPROVAL_ANSWERS = ['approved', 'approved_with_conditions', 'rejected', 'info_requested'] as const;
export type ApprovalAnswer = (typeof APPROVAL_ANSWERS)[number];

/** Groups of My reviews. */
export const REVIEW_BUCKETS = ['overdue', 'this_week', 'later'] as const;
export type ReviewBucketValue = (typeof REVIEW_BUCKETS)[number];

export const CHANGE_REQUEST_STATUSES = [
  'draft',
  'assessing',
  'awaiting_approval',
  'approved',
  'rejected',
  'implemented',
  'withdrawn',
] as const;
export type ChangeRequestStatusValue = (typeof CHANGE_REQUEST_STATUSES)[number];
export const CHANGE_ROUTES = ['manager', 'board'] as const;

// ── Building blocks ─────────────────────────────────────────────────────────

/** An RFC 3339 timestamp, `Z` or an offset (`2026-11-10T09:00:00Z`). */
const isoDateTime = z.string().datetime({ offset: true });
const identifier = z.string().min(1).max(255);
const title = z.string().trim().min(1).max(255);
/** A signed money amount in the project currency (a change that saves money is negative). */
const signedAmount = z.number().finite().min(-9_999_999_999_999).max(9_999_999_999_999);
const limitAmount = z.number().finite().min(0).max(9_999_999_999_999);

// ── Approvals ───────────────────────────────────────────────────────────────

/** `GET /api/approvals/mine`. */
export const listMyReviewsQuerySchema = z.object({
  type: z.enum(REVIEW_TYPES).optional(),
  projectId: z.string().optional(),
});

/** `GET /api/approvals/sent` and `/done`. */
export const listReviewsQuerySchema = z.object({
  type: z.enum(REVIEW_TYPES).optional(),
  projectId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

/** `POST /api/approvals/:id/decide`. Declining and setting conditions need a note. */
export const decideApprovalSchema = z
  .object({
    decision: z.enum(APPROVAL_ANSWERS),
    note: z.string().max(5_000).nullish(),
  })
  .strict();

/** `POST /api/approvals/delegations`: the caller hands their reviews to `delegateId` between two moments. */
export const createDelegationSchema = z
  .object({
    delegateId: identifier,
    startsAt: isoDateTime,
    endsAt: isoDateTime,
  })
  .strict();

/** `PUT /api/approvals/projects/:projectId/sponsor`. `null` clears the sponsor (the project manager then sponsors). */
export const setSponsorSchema = z.object({ sponsorId: identifier.nullable() }).strict();

export type DecideApprovalInput = z.infer<typeof decideApprovalSchema>;
export type CreateDelegationInput = z.infer<typeof createDelegationSchema>;
export type SetSponsorInput = z.infer<typeof setSponsorSchema>;

/** Why this person was asked: a rule code plus the parameters it used. */
export const reviewRuleSchema = z.object({
  code: z.string(),
  params: z.record(z.unknown()).optional(),
});

/** One approver of a subject and where they stand. */
export const reviewApproverSchema = z.object({
  approvalId: z.string(),
  approverKind: z.enum(APPROVER_KINDS),
  approverId: z.string(),
  roleLabel: z.string().nullable(),
  step: z.number().int(),
  decision: z.enum(APPROVAL_DECISIONS),
  note: z.string().nullable(),
  decidedAt: z.string().nullable(),
  delegatedFrom: z.string().nullable(),
});

/** What the subject changes for the project, as figures the reviewer weighs. */
export const reviewImpactSchema = z.object({
  kind: z.enum(['cost', 'schedule_days', 'risk_score', 'hours']),
  /** A decimal string for `cost`, a number otherwise. */
  value: z.union([z.string(), z.number()]).nullable(),
  currency: z.string().nullable().optional(),
});

/** A record the subject points at (a milestone it moves, a deliverable it adds or removes). */
export const reviewLinkSchema = z.object({
  type: z.enum(['milestone', 'deliverable']),
  id: z.string(),
  title: z.string(),
  code: z.string().nullable(),
  /** What the subject does to it. */
  relation: z.enum(['moves', 'adds', 'removes']),
});

/**
 * One line of My reviews, "Sent by me" or "Done". `id` is the approval row
 * (`source: 'approval'`) or the time entry (`source: 'timesheet'`); both are
 * answered with `POST /api/approvals/:id/decide`.
 */
export const reviewItemSchema = z.object({
  id: z.string(),
  source: z.enum(['approval', 'timesheet']),
  type: z.enum(REVIEW_TYPES),
  subjectId: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  /** `CR-8`, `RSK-4`, `DEC-7`, `D3`, `REQ-2`; null for a gate, a close or a time entry. */
  code: z.string().nullable(),
  title: z.string(),
  summary: z.string().nullable(),
  /** The member who asked (the time entry's author for a timesheet). */
  requestedBy: z.string().nullable(),
  requestedAt: z.string(),
  dueAt: z.string().nullable(),
  bucket: z.enum(REVIEW_BUCKETS),
  decision: z.enum(APPROVAL_DECISIONS),
  note: z.string().nullable(),
  decidedAt: z.string().nullable(),
  step: z.number().int(),
  roleLabel: z.string().nullable(),
  /** Why this person was asked ("why you"). Null for a timesheet. */
  rule: reviewRuleSchema.nullable(),
  /** The row is a delegator's, shown because the caller is their active delegate. */
  viaDelegation: z.boolean(),
  delegatedFrom: z.string().nullable(),
  /** The earlier steps are answered, so the row can be answered now. */
  actionable: z.boolean(),
  approvers: z.array(reviewApproverSchema),
  impacts: z.array(reviewImpactSchema),
  links: z.array(reviewLinkSchema),
});

/** `GET /api/approvals/mine`: the caller's open reviews in three groups, each earliest due first. */
export const myReviewsSchema = z.object({
  total: z.number().int(),
  /** Per type, ignoring the `type` filter (the filter chips show these). */
  counts: z.record(z.number().int()),
  groups: z.object({
    overdue: z.array(reviewItemSchema),
    this_week: z.array(reviewItemSchema),
    later: z.array(reviewItemSchema),
  }),
});

/** `GET /api/approvals/mine/count`: the number the sidebar badge shows. */
export const myReviewsCountSchema = z.object({
  count: z.number().int(),
  overdue: z.number().int(),
});

/** One subject the caller asked approval for, with its approvers (`GET /api/approvals/sent`). */
export const sentReviewSchema = z.object({
  type: z.enum(APPROVAL_SUBJECT_TYPES),
  subjectId: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  code: z.string().nullable(),
  title: z.string(),
  requestedAt: z.string(),
  dueAt: z.string().nullable(),
  outcome: z.enum(['pending', 'approved', 'rejected']),
  approvers: z.array(reviewApproverSchema),
});

/** `POST /api/approvals/:id/decide`. */
export const decideResultSchema = z.object({
  approval: reviewApproverSchema.extend({ subjectType: z.string(), subjectId: z.string(), projectId: z.string().nullable() }),
  /** What the subject's approvers add up to now. */
  outcome: z.enum(['pending', 'approved', 'rejected']),
  /** True when this answer settled the subject. */
  resolved: z.boolean(),
  viaDelegation: z.boolean(),
});

export const delegationSchema = z.object({
  id: z.string(),
  memberId: z.string(),
  delegateId: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** `GET /api/approvals/delegations`: delegations that have not ended, by direction. */
export const delegationsSchema = z.object({
  given: z.array(delegationSchema),
  received: z.array(delegationSchema),
});

// ── Change control settings and the sponsor ─────────────────────────────────

/** `PUT /api/project-changes/settings/:projectId`: who approves a change request (FLOW-013). */
export const changeControlSettingsSchema = z
  .object({
    /** In the project's budget currency; a cost delta at or above this goes to the board. */
    costLimit: limitAmount,
    /** In working days; a delay at or above this goes to the board. */
    scheduleLimitDays: z.number().int().min(0).max(3_650),
    /** Project members (a viewer is enough). */
    boardMemberIds: z.array(identifier).max(50),
  })
  .strict();

export type ChangeControlSettingsInput = z.infer<typeof changeControlSettingsSchema>;

/** `GET` and `PUT /api/project-changes/settings/:projectId`. */
export const changeControlResponseSchema = z.object({
  projectId: z.string(),
  changeControl: z.object({
    costLimit: z.number(),
    scheduleLimitDays: z.number().int(),
    boardMemberIds: z.array(z.string()),
  }),
  /** False until the project sets its own limits (the defaults apply). */
  configured: z.boolean(),
  sponsorId: z.string().nullable(),
  projectManagerId: z.string().nullable(),
  /** The budget currency the cost limit is in. */
  currency: z.string().nullable(),
  /** No board members: changes over a limit go to the project manager, and the screen warns about it. */
  warnings: z.array(z.enum(['no_board'])),
});

// ── Change requests ─────────────────────────────────────────────────────────

/** The date moves an approved change writes to the live plan (FLOW-012). */
export const planChangesSchema = z
  .object({
    milestones: z
      .array(z.object({ milestoneId: identifier, to: isoDateTime }).strict())
      .max(100)
      .optional(),
    deliverables: z
      .array(
        z
          .object({
            deliverableId: identifier,
            plannedStart: isoDateTime.nullish(),
            plannedEnd: isoDateTime.nullish(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    /** The new go-live (the project end date). */
    goLive: isoDateTime.nullish(),
  })
  .strict();

/** The deliverables an approved change adds to or removes from the scope. */
export const scopeChangesSchema = z
  .object({
    add: z
      .array(
        z
          .object({
            title,
            description: z.string().max(10_000).nullish(),
            ownerId: identifier.nullish(),
            plannedStart: isoDateTime.nullish(),
            plannedEnd: isoDateTime.nullish(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    /** Ids of deliverables to remove. */
    remove: z.array(identifier).max(100).optional(),
  })
  .strict();

const changeImpactFields = {
  /** In the project's budget currency; negative when the change saves money. */
  costDelta: signedAmount.nullish(),
  /** In working days; negative when the change saves time. */
  scheduleDeltaDays: z.number().int().min(-3_650).max(3_650).nullish(),
  planChanges: planChangesSchema.nullish(),
  scopeChanges: scopeChangesSchema.nullish(),
};

/** `POST /api/project-changes`. */
export const createChangeRequestSchema = z
  .object({
    projectId: identifier,
    title,
    description: z.string().max(10_000).nullish(),
    ...changeImpactFields,
    clientVisible: z.boolean().optional(),
  })
  .strict();

/** `PATCH /api/project-changes/:id`. Editing the impact after submission sends the change back to `assessing`. */
export const updateChangeRequestSchema = z
  .object({
    title: title.optional(),
    description: z.string().max(10_000).nullish(),
    ...changeImpactFields,
    clientVisible: z.boolean().optional(),
  })
  .strict();

export const listChangeRequestsQuerySchema = z.object({
  projectId: z.string().optional(),
  status: z.enum(CHANGE_REQUEST_STATUSES).optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

export type CreateChangeRequestInput = z.infer<typeof createChangeRequestSchema>;
export type UpdateChangeRequestInput = z.infer<typeof updateChangeRequestSchema>;
export type PlanChangesInput = z.infer<typeof planChangesSchema>;
export type ScopeChangesInput = z.infer<typeof scopeChangesSchema>;

const nullableString = z.string().nullable();

/** A change request as every route answers it: the row plus its display `code` (`CR-8`). */
export const changeRequestSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    number: z.number().int(),
    code: z.string(),
    title: z.string(),
    description: nullableString,
    requestedBy: nullableString,
    requestedByName: nullableString,
    status: z.enum(CHANGE_REQUEST_STATUSES),
    costDelta: nullableString,
    scheduleDeltaDays: z.number().int().nullable(),
    planChanges: z.record(z.unknown()).nullable(),
    scopeChanges: z.record(z.unknown()).nullable(),
    route: z.enum(CHANGE_ROUTES).nullable(),
    submittedAt: nullableString,
    decidedAt: nullableString,
    baselineId: nullableString,
    clientVisible: z.boolean(),
    createdBy: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: nullableString,
  })
  .passthrough();

/** "What changes once approved", computed from the change and the live plan. */
export const changeEffectsSchema = z.object({
  goLive: z.object({ from: nullableString, to: nullableString, deltaDays: z.number().int().nullable() }).nullable(),
  milestones: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      from: nullableString,
      to: z.string(),
      deltaDays: z.number().int().nullable(),
    }),
  ),
  deliverables: z.object({
    moved: z.array(
      z.object({
        id: z.string(),
        code: nullableString,
        title: z.string(),
        plannedStart: nullableString,
        plannedEnd: nullableString,
      }),
    ),
    added: z.array(z.object({ title: z.string(), plannedStart: nullableString, plannedEnd: nullableString })),
    removed: z.array(z.object({ id: z.string(), code: nullableString, title: z.string() })),
  }),
  budget: z
    .object({
      currency: nullableString,
      from: nullableString,
      to: nullableString,
      delta: z.string(),
    })
    .nullable(),
});

/** Why the change went to its approvers (FLOW-013). */
export const changeRoutingSchema = z.object({
  route: z.enum(CHANGE_ROUTES),
  /** Over the cost limit or the schedule limit. */
  overLimit: z.boolean(),
  costLimit: z.number(),
  scheduleLimitDays: z.number().int(),
  /** Over a limit with no change board set: the project manager approves. */
  noBoard: z.boolean(),
});

/** `GET /api/project-changes/:id`. */
export const changeRequestDetailSchema = changeRequestSchema.and(
  z.object({
    approvers: z.array(reviewApproverSchema),
    effects: changeEffectsSchema,
    /** What the impact would route to, from the current rules (before submission), or what it was routed to. */
    routing: changeRoutingSchema,
    /** The version of the baseline this change produced, once approved. */
    baselineVersion: z.number().int().nullable(),
    /** The caller can answer this change in My reviews right now. */
    canDecide: z.boolean(),
  }),
);

/** `POST /api/project-changes/:id/submit`. */
export const submitChangeResultSchema = z.object({
  change: changeRequestSchema,
  approvers: z.array(reviewApproverSchema),
  routing: changeRoutingSchema,
});

export type ChangeRequest = z.infer<typeof changeRequestSchema>;
export type ChangeRequestDetail = z.infer<typeof changeRequestDetailSchema>;
export type ChangeEffects = z.infer<typeof changeEffectsSchema>;
export type ChangeRouting = z.infer<typeof changeRoutingSchema>;
export type SubmitChangeResult = z.infer<typeof submitChangeResultSchema>;
export type ChangeControlResponse = z.infer<typeof changeControlResponseSchema>;
export type MyReviews = z.infer<typeof myReviewsSchema>;
export type ReviewItem = z.infer<typeof reviewItemSchema>;
export type ReviewApprover = z.infer<typeof reviewApproverSchema>;
export type ReviewImpact = z.infer<typeof reviewImpactSchema>;
export type ReviewLink = z.infer<typeof reviewLinkSchema>;
export type SentReview = z.infer<typeof sentReviewSchema>;
export type DecideResult = z.infer<typeof decideResultSchema>;
export type Delegation = z.infer<typeof delegationSchema>;
export type Delegations = z.infer<typeof delegationsSchema>;

// ── Baselines ───────────────────────────────────────────────────────────────

/** `GET /api/project-baselines`. */
export const listBaselinesQuerySchema = z.object({
  projectId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

/** `GET /api/project-baselines/compare`. `from` and `to` are baseline ids; `to` defaults to the live plan. */
export const compareBaselinesQuerySchema = z.object({
  projectId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

/** What a baseline version froze: the same shape as the `project_baselines.snapshot` column. */
export const baselineSnapshotSchema = z.object({
  goLive: nullableString,
  milestones: z.array(z.object({ id: z.string(), name: z.string(), dueDate: z.string() })),
  deliverables: z.array(
    z.object({
      id: z.string(),
      number: z.number().int(),
      title: z.string(),
      plannedStart: nullableString,
      plannedEnd: nullableString,
    }),
  ),
  budgetedAmount: nullableString,
  budgetedHours: nullableString,
  budgetCurrency: nullableString,
  scopeStatement: nullableString,
});

export const baselineSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  version: z.number().int(),
  changeRequestId: nullableString,
  /** `CR-8` of the change that produced this version; null for v1. */
  changeRequestCode: nullableString,
  changeRequestTitle: nullableString,
  snapshot: baselineSnapshotSchema,
  createdBy: z.string(),
  createdAt: z.string(),
});

const variance = z.object({
  from: nullableString,
  to: nullableString,
  /** Days `to` is after `from` (negative: earlier); null when either end is missing. */
  deltaDays: z.number().int().nullable(),
});

/** The difference between two plans (`from` is the agreed one, `to` the one compared). */
export const baselineDiffSchema = z.object({
  goLive: variance,
  milestones: z.array(
    variance.extend({
      id: z.string(),
      name: z.string(),
      change: z.enum(['unchanged', 'moved', 'added', 'removed']),
    }),
  ),
  deliverables: z.array(
    z.object({
      id: z.string(),
      number: z.number().int(),
      title: z.string(),
      change: z.enum(['unchanged', 'moved', 'added', 'removed']),
      start: variance,
      end: variance,
    }),
  ),
  budget: z.object({ from: nullableString, to: nullableString, delta: nullableString }),
  hours: z.object({ from: nullableString, to: nullableString, delta: nullableString }),
});

/** A change request that would move the plan, drawn dashed on the Gantt. */
export const pendingChangePreviewSchema = z.object({
  changeRequestId: z.string(),
  code: z.string(),
  title: z.string(),
  status: z.enum(['assessing', 'awaiting_approval']),
  milestones: z.array(z.object({ milestoneId: z.string(), name: z.string(), from: nullableString, to: z.string() })),
  deliverables: z.array(
    z.object({ deliverableId: z.string(), plannedStart: nullableString, plannedEnd: nullableString }),
  ),
  goLive: nullableString,
});

/** `GET /api/project-baselines/compare`. */
export const baselineComparisonSchema = z.object({
  from: baselineSchema,
  /** The baseline compared to, or null for the live plan. */
  to: baselineSchema.nullable(),
  /** The snapshot of the plan on the right (the baseline's, or the live plan's). */
  toSnapshot: baselineSnapshotSchema,
  diff: baselineDiffSchema,
  /** Pending change requests of the project, when comparing with the live plan. */
  pending: z.array(pendingChangePreviewSchema),
});

export type Baseline = z.infer<typeof baselineSchema>;
export type BaselineSnapshotShape = z.infer<typeof baselineSnapshotSchema>;
export type BaselineDiff = z.infer<typeof baselineDiffSchema>;
export type BaselineComparison = z.infer<typeof baselineComparisonSchema>;
export type PendingChangePreview = z.infer<typeof pendingChangePreviewSchema>;

// ── Risk acceptance ─────────────────────────────────────────────────────────

/** `POST /api/project-raid/:id/request-acceptance`: ask the sponsor to accept a risk scoring 9 or more. */
export const requestRiskAcceptanceSchema = z
  .object({
    /** Why the risk is accepted without mitigation; shown to the sponsor. */
    note: z.string().trim().max(2_000).nullish(),
  })
  .strict();

export type RequestRiskAcceptanceInput = z.infer<typeof requestRiskAcceptanceSchema>;
