/**
 * WeldAgent Grok-parity schemas — skills, routines, approvals, memory, templates.
 */

import { z } from 'zod';

export const createSkillSchema = z.object({
  name: z.string().min(2).max(255),
  description: z.string().max(2000).optional(),
  instructions: z.string().min(20).max(20000),
  steps: z.array(z.record(z.unknown())).optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
});

export const updateSkillSchema = createSkillSchema.partial();

export const createRoutineSchema = z.object({
  agentId: z.string().min(1).max(30),
  name: z.string().min(2).max(255),
  instructions: z.string().min(10).max(20000),
  skillId: z.string().min(1).max(30).optional().nullable(),
  scheduleKind: z.enum(['cron', 'event', 'connector']).default('cron'),
  cronExpr: z.string().max(100).optional().nullable(),
  timezone: z.string().max(64).optional(),
  eventKey: z.string().max(100).optional().nullable(),
  connectorConfig: z
    .object({
      provider: z.enum(['slack', 'github']).optional(),
      channel: z.string().max(200).optional(),
      match: z.string().max(500).optional(),
      repo: z.string().max(200).optional(),
      event: z.string().max(100).optional(),
    })
    .optional()
    .nullable(),
  enabled: z.boolean().optional(),
  requireApproval: z.boolean().optional(),
});

export const updateRoutineSchema = createRoutineSchema.partial().omit({ agentId: true });

export const decideApprovalSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().max(1000).optional(),
});

export const createMemorySchema = z.object({
  agentId: z.string().min(1).max(30),
  kind: z.enum(['preference', 'fact', 'summary', 'correction']).default('fact'),
  content: z.string().min(1).max(5000),
  source: z.string().max(100).optional(),
});

export const updateMemorySchema = z.object({
  content: z.string().min(1).max(5000).optional(),
  kind: z.enum(['preference', 'fact', 'summary', 'correction']).optional(),
});

export const exportTemplateSchema = z.object({
  agentId: z.string().min(1).max(30),
  name: z.string().min(2).max(255).optional(),
  description: z.string().max(2000).optional(),
  isPublic: z.boolean().optional(),
});

export const installTemplateSchema = z.object({
  templateId: z.string().min(1).max(30).optional(),
  shareToken: z.string().min(8).max(64).optional(),
  name: z.string().min(1).max(255).optional(),
});

export const startTeachSchema = z.object({
  title: z.string().min(2).max(255),
});

export const appendTeachStepSchema = z.object({
  step: z.record(z.unknown()),
});

export const stopTeachSchema = z.object({
  createSkill: z.boolean().optional(),
  skillName: z.string().min(2).max(255).optional(),
});

export const connectorEventSchema = z.object({
  provider: z.enum(['slack', 'github']),
  workspaceExternalId: z.string().max(200).optional(),
  channel: z.string().max(200).optional(),
  repo: z.string().max(200).optional(),
  event: z.string().max(100).optional(),
  text: z.string().max(10000).optional(),
  payload: z.record(z.unknown()).optional(),
});

export type CreateSkillInput = z.infer<typeof createSkillSchema>;
export type UpdateSkillInput = z.infer<typeof updateSkillSchema>;
export type CreateRoutineInput = z.infer<typeof createRoutineSchema>;
export type UpdateRoutineInput = z.infer<typeof updateRoutineSchema>;
export type DecideApprovalInput = z.infer<typeof decideApprovalSchema>;
export type CreateMemoryInput = z.infer<typeof createMemorySchema>;
export type ExportTemplateInput = z.infer<typeof exportTemplateSchema>;
export type InstallTemplateInput = z.infer<typeof installTemplateSchema>;
export type ConnectorEventInput = z.infer<typeof connectorEventSchema>;
