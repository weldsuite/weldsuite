/**
 * Workspace AI agent schemas — CRUD, runs, tool catalog.
 * Shared between app-api routes and the platform client.
 */

import { z } from 'zod';

export const createWorkspaceAgentSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().max(50).nullable().optional(),
  systemPrompt: z.string().max(20000).optional(),
  modelId: z.string().min(1).max(100).optional(),
  temperature: z.string().max(10).optional(),
  maxTokens: z.number().int().min(1).max(8192).optional(),
  permissions: z.array(z.string()).optional(),
  enabledTools: z.array(z.string()).optional(),
  eventSubscriptions: z.array(z.string()).optional(),
  maxIterations: z.number().int().min(1).max(50).optional(),
  maxTotalTokens: z.number().int().min(1000).max(200000).optional(),
});

export const updateWorkspaceAgentSchema = createWorkspaceAgentSchema.partial().extend({
  status: z.enum(['draft', 'active', 'paused']).optional(),
});

export const runWorkspaceAgentSchema = z.object({
  message: z.string().min(1).max(20000).optional(),
  triggerData: z.record(z.unknown()).optional(),
});

export type CreateWorkspaceAgentInput = z.infer<typeof createWorkspaceAgentSchema>;
export type UpdateWorkspaceAgentInput = z.infer<typeof updateWorkspaceAgentSchema>;
export type RunWorkspaceAgentInput = z.infer<typeof runWorkspaceAgentSchema>;

export interface WorkspaceAgent {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  status: 'draft' | 'active' | 'paused';
  systemPrompt: string;
  modelId: string;
  temperature: string;
  maxTokens: number;
  permissions: string[];
  enabledTools: string[];
  eventSubscriptions: string[];
  maxIterations: number;
  maxTotalTokens: number;
  createdBy: string | null;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceAgentRun {
  id: string;
  agentId: string;
  status: string;
  triggerType: string | null;
  triggerData: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  totalIterations: number | null;
  totalTokensUsed: number | null;
  toolCallCount: number | null;
  result: {
    summary: string;
    actionsPerformed: Array<{ tool: string; description: string; success: boolean }>;
    toolInvocations?: unknown[];
  } | null;
  error: string | null;
  createdAt: string;
}

export interface WorkspaceAgentToolCatalogItem {
  id: string;
  name: string;
  description: string;
  requiredPermissions: string[];
}
