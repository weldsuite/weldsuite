import { z } from 'zod';

// `/api/helpdesk-agents` — backed by `helpdesk_agents`.

export const createHelpdeskAgentSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255),
  userId: z.string().nullish(),
  departmentId: z.string().nullish(),
  role: z.string().max(50).optional(),
  isActive: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateHelpdeskAgentSchema = createHelpdeskAgentSchema.partial();

export type CreateHelpdeskAgentInput = z.infer<typeof createHelpdeskAgentSchema>;
export type UpdateHelpdeskAgentInput = z.infer<typeof updateHelpdeskAgentSchema>;

/** A `helpdesk_agents` row, as /api/helpdesk-agents lists it and GET /:id returns it. */
export const helpdeskAgentSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    userId: z.string(),
    name: z.string(),
    email: z.string(),
    avatar: z.string().nullable(),
    role: z.string(),
    departmentId: z.string().nullable(),
    teamIds: z.array(z.string()).nullable(),
    status: z.string(),
    availability: z.string().nullable(),
    isOnline: z.boolean().nullable(),
    lastSeenAt: z.string().nullable(),
    maxActiveTickets: z.number().nullable(),
    currentActiveTickets: z.number().nullable(),
    skills: z.array(z.string()).nullable(),
    languages: z.array(z.string()).nullable(),
    expertise: z.array(z.string()).nullable(),
    permissions: z.unknown(),
    canAccessAllTickets: z.boolean().nullable(),
    canManageKnowledge: z.boolean().nullable(),
    averageResponseTime: z.number().nullable(),
    averageResolutionTime: z.number().nullable(),
    /** `numeric(3, 2)`: a string. */
    satisfactionScore: z.string().nullable(),
    ticketsResolved: z.number().nullable(),
    ticketsAssigned: z.number().nullable(),
    workingHours: z.unknown(),
    timezone: z.string().nullable(),
    signature: z.string().nullable(),
    notificationPreferences: z.unknown(),
  })
  .passthrough();
