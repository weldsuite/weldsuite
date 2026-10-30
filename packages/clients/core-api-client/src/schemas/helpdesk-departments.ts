import { z } from 'zod';

// `/api/helpdesk-departments` — backed by `helpdesk_departments`.

export const createHelpdeskDepartmentSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  email: z.string().email().max(255).optional(),
  color: z.string().max(50).optional(),
  icon: z.string().max(100).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  metadata: z.unknown().optional(),
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
