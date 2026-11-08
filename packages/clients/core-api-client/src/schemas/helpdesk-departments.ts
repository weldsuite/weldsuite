import { z } from 'zod';

// `/api/helpdesk-departments` — backed by `helpdesk_departments`.

export const DESK_ESCALATION_CONDITIONS = ['sla_breach', 'no_response', 'unassigned', 'custom'] as const;
export const DESK_ESCALATION_TARGETS = ['manager', 'next_tier', 'specific_agent'] as const;

/**
 * One of a team's escalation rules (`EscalationRule`), run by WeldDesk's SLA
 * sweep (`@weldsuite/db/lib/desk-escalation`). `custom` is stored but never
 * fires. `escalateToId` is the teammate (Clerk user id) for `specific_agent`.
 */
export const deskEscalationRuleSchema = z.object({
  condition: z.enum(DESK_ESCALATION_CONDITIONS),
  afterMinutes: z.number().int().min(0).max(525600),
  escalateTo: z.enum(DESK_ESCALATION_TARGETS),
  escalateToId: z.string().min(1).max(255).optional(),
  notifyCustomer: z.boolean().optional(),
});

export const createHelpdeskDepartmentSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  email: z.string().email().max(255).optional(),
  color: z.string().max(50).optional(),
  icon: z.string().max(100).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  metadata: z.unknown().optional(),
  /** The manager's workspace member id (`workspace_members.id`, the column is varchar(30)). */
  managerId: z.string().min(1).max(30).nullable().optional(),
  managerName: z.string().max(255).nullable().optional(),
  /** The team's members: Clerk user ids, as the inbox's assignee and the assignment roster use. */
  agentIds: z.array(z.string().min(1).max(255)).max(500).optional(),
  autoAssignment: z.boolean().optional(),
  roundRobinAssignment: z.boolean().optional(),
  escalationRules: z.array(deskEscalationRuleSchema).max(20).optional(),
}).passthrough();

export const updateHelpdeskDepartmentSchema = createHelpdeskDepartmentSchema.partial();

export type CreateHelpdeskDepartmentInput = z.infer<typeof createHelpdeskDepartmentSchema>;
export type UpdateHelpdeskDepartmentInput = z.infer<typeof updateHelpdeskDepartmentSchema>;

/** A `helpdesk_departments` row, as GET /api/helpdesk-departments/:id returns it. */
export const helpdeskDepartmentSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    email: z.string().nullable(),
    managerId: z.string().nullable(),
    managerName: z.string().nullable(),
    agentIds: z.array(z.string()).nullable(),
    /** The stored column; the list replaces it with a live count. */
    agentCount: z.number().nullable(),
    autoAssignment: z.boolean().nullable(),
    roundRobinAssignment: z.boolean().nullable(),
    escalationRules: z.unknown(),
    businessHours: z.unknown(),
    replyTime: z.string().nullable(),
    categories: z.array(z.string()).nullable(),
    defaultPriority: z.string().nullable(),
    isActive: z.boolean(),
    sortOrder: z.number().nullable(),
  })
  .passthrough();

/** A row of GET /api/helpdesk-departments: the department with its live agent count. */
export const helpdeskDepartmentListItemSchema = helpdeskDepartmentSchema.extend({ agentCount: z.number() });

/** GET /api/helpdesk-departments/inbox-counts: open conversations per department. */
export const helpdeskDepartmentInboxCountSchema = z.object({
  departmentId: z.string(),
  activeCount: z.number(),
});
