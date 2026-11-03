/**
 * Responses of connect-api's internal WeldConnect action routes
 * (`/api/internal/workflow-actions/*`), the machine contract the workflow
 * engine reads (`{ success, ... }`). Used by the conformance harness.
 */

import { z } from 'zod';

const nullableText = z.string().nullable();

export const workflowActionCustomerSchema = z.object({
  success: z.literal(true),
  created: z.boolean(),
  customer: z.object({ id: z.string(), name: z.string(), email: nullableText, status: nullableText }),
});

export const workflowActionContactSchema = z.object({
  success: z.literal(true),
  created: z.boolean().optional(),
  contact: z.object({ id: z.string(), displayName: nullableText, email: nullableText }),
});

export const workflowActionLeadSchema = z.object({
  success: z.literal(true),
  lead: z.object({ id: z.string(), name: nullableText, email: z.string() }),
});

export const workflowActionDealSchema = z.object({
  success: z.literal(true),
  deal: z.object({ id: z.string(), name: z.string(), stage: z.string(), status: z.string() }),
});

export const workflowActionDealStageSchema = z.object({
  success: z.literal(true),
  deal: z.object({ id: z.string(), stageId: z.string(), status: z.string() }),
});

export const workflowActionActivitySchema = z.object({
  success: z.literal(true),
  activity: z.object({ id: z.string(), type: z.string(), subject: z.string() }),
});

export const workflowActionChatMessageSchema = z.object({
  success: z.literal(true),
  message: z.object({ id: z.string(), channelId: z.string() }),
});

export const workflowActionTaskSchema = z.object({
  success: z.literal(true),
  task: z.object({ id: z.string(), number: z.number().nullable(), projectId: z.string(), title: z.string() }),
});
