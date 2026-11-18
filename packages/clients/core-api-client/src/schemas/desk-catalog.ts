import { z } from 'zod';
import { deskConversationSchema, deskMessageSchema, DESK_PRIORITIES } from './desk-conversations';

/**
 * The WeldDesk service catalogue (desk-api): items at `/api/desk/catalog`, and
 * the request side on a conversation at
 * `/api/desk/conversations/:id/{request,catalog-item,approval,fulfilment}`. Rows are
 * written by `@weldsuite/db/lib/desk-catalog`. Limits mirror
 * `DESK_CATALOG_MAX_APPROVAL_STEPS` / `DESK_CATALOG_MAX_FULFILMENT_TASKS`.
 */

export const DESK_CATALOG_APPROVER_TYPES = ['member', 'team_manager'] as const;
export const DESK_APPROVAL_STEP_STATUSES = ['waiting', 'pending', 'approved', 'rejected', 'skipped'] as const;
export const DESK_REQUEST_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const DESK_CATALOG_MAX_APPROVAL_STEPS = 5;
export const DESK_CATALOG_MAX_FULFILMENT_TASKS = 20;

const shortId = z.string().min(1).max(30);

export const deskCatalogApprovalStepInputSchema = z.object({
  /** Kept when steps are reordered; generated when missing. */
  id: z.string().min(1).max(64).optional(),
  name: z.string().trim().max(255).nullish(),
  approverType: z.enum(DESK_CATALOG_APPROVER_TYPES),
  /** `member`: the approver's user id. */
  approverId: z.string().min(1).max(255).nullish(),
  /** `team_manager`: the team whose manager approves; none uses the request's team. */
  departmentId: shortId.nullish(),
});

export const deskCatalogFulfilmentTaskInputSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  title: z.string().trim().min(1).max(255),
  description: z.string().trim().max(5000).nullish(),
  /** A user id; none gives the task to the request's owner. */
  assigneeId: z.string().min(1).max(255).nullish(),
  /** Due this many days after approval. */
  dueInDays: z.number().int().min(0).max(365).nullish(),
});

const itemFields = {
  name: z.string().trim().min(1).max(255),
  summary: z.string().trim().max(500).nullish(),
  description: z.string().trim().max(10_000).nullish(),
  category: z.string().trim().max(100).nullish(),
  icon: z.string().trim().max(50).nullish(),
  ticketTypeId: shortId,
  departmentId: shortId.nullish(),
  priority: z.enum(DESK_PRIORITIES).nullish(),
  deliveryEstimate: z.string().trim().max(100).nullish(),
  approvalSteps: z.array(deskCatalogApprovalStepInputSchema).max(DESK_CATALOG_MAX_APPROVAL_STEPS),
  fulfilmentTasks: z.array(deskCatalogFulfilmentTaskInputSchema).max(DESK_CATALOG_MAX_FULFILMENT_TASKS),
  audienceCompanyIds: z.array(z.string().min(1).max(30)).max(200),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(0).max(100_000),
};

/** POST /api/desk/catalog. */
export const createDeskCatalogItemSchema = z.object({
  ...itemFields,
  approvalSteps: itemFields.approvalSteps.optional(),
  fulfilmentTasks: itemFields.fulfilmentTasks.optional(),
  audienceCompanyIds: itemFields.audienceCompanyIds.optional(),
  isActive: itemFields.isActive.optional(),
  sortOrder: itemFields.sortOrder.optional(),
});

/** PATCH /api/desk/catalog/:id: only the keys present change. */
export const updateDeskCatalogItemSchema = z.object(itemFields).partial();

/** PUT /api/desk/conversations/:id/catalog-item. */
export const attachDeskCatalogItemSchema = z.object({
  catalogItemId: shortId,
});

/** POST /api/desk/conversations/:id/approval. */
export const decideDeskApprovalSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  comment: z.string().trim().max(2000).nullish(),
});

/** GET /api/desk/catalog/approvals. */
export const deskCatalogApprovalsQuerySchema = z.object({
  scope: z.enum(['mine', 'all']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** GET /api/desk/catalog: `all=1` includes switched-off items. */
export const deskCatalogListQuerySchema = z.object({
  all: z.enum(['1', 'true']).optional(),
});

// ── responses ────────────────────────────────────────────────────────────────

export const deskCatalogApprovalStepSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    approverType: z.enum(DESK_CATALOG_APPROVER_TYPES),
    approverId: z.string().optional(),
    departmentId: z.string().nullable().optional(),
  })
  .strict();

export const deskCatalogFulfilmentTaskSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    assigneeId: z.string().nullable().optional(),
    dueInDays: z.number().int().nullable().optional(),
  })
  .strict();

/** A `desk_catalog_items` row. */
export const deskCatalogItemSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    name: z.string(),
    summary: z.string().nullable(),
    description: z.string().nullable(),
    category: z.string().nullable(),
    icon: z.string().nullable(),
    ticketTypeId: z.string(),
    departmentId: z.string().nullable(),
    priority: z.enum(DESK_PRIORITIES).nullable(),
    deliveryEstimate: z.string().nullable(),
    approvalSteps: z.array(deskCatalogApprovalStepSchema),
    fulfilmentTasks: z.array(deskCatalogFulfilmentTaskSchema),
    audienceCompanyIds: z.array(z.string()),
    isActive: z.boolean(),
    sortOrder: z.number().int(),
    createdById: z.string().nullable(),
  })
  .strict();

/** One step of one request (`desk_request_approvals`, as the details panel lists it). */
export const deskRequestApprovalSchema = z
  .object({
    id: z.string(),
    stepIndex: z.number().int(),
    stepName: z.string().nullable(),
    approverId: z.string().nullable(),
    status: z.enum(DESK_APPROVAL_STEP_STATUSES),
    decidedAt: z.string().nullable(),
    decidedById: z.string().nullable(),
    comment: z.string().nullable(),
  })
  .strict();

/** The service request a conversation is. */
export const deskConversationRequestSchema = z
  .object({
    /** Null when the item was deleted since. */
    item: z
      .object({
        id: z.string(),
        name: z.string(),
        category: z.string().nullable(),
        icon: z.string().nullable(),
        deliveryEstimate: z.string().nullable(),
      })
      .strict()
      .nullable(),
    approvalStatus: z.enum(DESK_REQUEST_APPROVAL_STATUSES).nullable(),
    approvals: z.array(deskRequestApprovalSchema),
    /**
     * The item's tasks were created. False on an approved (or approval-free)
     * request whose item has tasks: the run is under way, or it failed and
     * POST …/fulfilment runs it again.
     */
    fulfilmentStarted: z.boolean(),
  })
  .strict();

/** GET /api/desk/conversations/:id/request: null when the conversation is not a service request. */
export const deskConversationRequestOrNullSchema = deskConversationRequestSchema.nullable();

/** PUT …/catalog-item and POST …/approval: the conversation, its new timeline entries and the request as it stands. */
export const deskConversationRequestChangeSchema = z
  .object({
    conversation: deskConversationSchema,
    messages: z.array(deskMessageSchema),
    request: deskConversationRequestSchema,
  })
  .strict();

/** POST /api/desk/conversations/:id/fulfilment: how many tasks the run created (the ones a failed run left are not counted). */
export const deskRequestFulfilmentSchema = z.object({ created: z.number().int().min(0) }).strict();

/** Why POST …/fulfilment answers 409 (`details.reason`). */
export const DESK_FULFILMENT_REFUSALS = ['not_request', 'not_approved', 'already_started', 'item_missing'] as const;

/** One row of GET /api/desk/catalog/approvals. */
export const deskPendingApprovalSchema = z
  .object({
    approvalId: z.string(),
    conversationId: z.string(),
    conversationNumber: z.number().int(),
    title: z.string().nullable(),
    requesterName: z.string().nullable(),
    conversationCreatedAt: z.string(),
    catalogItemId: z.string(),
    catalogItemName: z.string().nullable(),
    stepIndex: z.number().int(),
    stepName: z.string().nullable(),
    approverId: z.string().nullable(),
    requestedAt: z.string(),
  })
  .strict();

export type DeskCatalogItem = z.infer<typeof deskCatalogItemSchema>;
export type CreateDeskCatalogItemInput = z.infer<typeof createDeskCatalogItemSchema>;
export type UpdateDeskCatalogItemInput = z.infer<typeof updateDeskCatalogItemSchema>;
export type DeskCatalogApprovalStepInput = z.infer<typeof deskCatalogApprovalStepInputSchema>;
export type DeskCatalogFulfilmentTaskInput = z.infer<typeof deskCatalogFulfilmentTaskInputSchema>;
export type DeskRequestApproval = z.infer<typeof deskRequestApprovalSchema>;
export type DeskConversationRequest = z.infer<typeof deskConversationRequestSchema>;
export type DeskConversationRequestChange = z.infer<typeof deskConversationRequestChangeSchema>;
export type DeskRequestFulfilment = z.infer<typeof deskRequestFulfilmentSchema>;
export type DeskPendingApproval = z.infer<typeof deskPendingApprovalSchema>;
export type DeskApprovalDecision = z.infer<typeof decideDeskApprovalSchema>['decision'];
