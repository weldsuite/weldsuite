/**
 * Workspace AI agent schemas — CRUD, runs, tool catalog.
 * Shared between app-api routes and the platform client.
 */

import { z } from 'zod';

/**
 * Claude models a workspace agent can run on. Agents run as Claude Managed
 * Agents, so only Claude model ids are valid here.
 */
export const WORKSPACE_AGENT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export type WorkspaceAgentModel = (typeof WORKSPACE_AGENT_MODELS)[number];
export const DEFAULT_WORKSPACE_AGENT_MODEL: WorkspaceAgentModel = 'claude-opus-5-5';

export function isWorkspaceAgentModel(value: string | null | undefined): value is WorkspaceAgentModel {
  return (WORKSPACE_AGENT_MODELS as readonly string[]).includes(value ?? '');
}

export const createWorkspaceAgentSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().max(50).nullable().optional(),
  systemPrompt: z.string().max(20000).optional(),
  modelId: z.enum(WORKSPACE_AGENT_MODELS).optional(),
  temperature: z.string().max(10).optional(),
  maxTokens: z.number().int().min(1).max(8192).optional(),
  permissions: z.array(z.string()).optional(),
  enabledTools: z.array(z.string()).optional(),
  eventSubscriptions: z.array(z.string()).optional(),
  maxIterations: z.number().int().min(1).max(50).optional(),
  maxTotalTokens: z.number().int().min(1000).max(200000).optional(),
});

/**
 * Who can see and chat with an agent: only its owner, the owner plus chosen
 * members, or everyone in the workspace.
 */
export const WORKSPACE_AGENT_VISIBILITIES = ['private', 'members', 'workspace'] as const;
export type WorkspaceAgentVisibility = (typeof WORKSPACE_AGENT_VISIBILITIES)[number];

export const updateWorkspaceAgentSchema = createWorkspaceAgentSchema.partial().extend({
  status: z.enum(['draft', 'active', 'paused']).optional(),
});

/** PUT /agents/:id/access — owner, visibility and member list (owner or manager only). */
export const updateWorkspaceAgentAccessSchema = z.object({
  ownerId: z.string().min(1).max(255).optional(),
  visibility: z.enum(WORKSPACE_AGENT_VISIBILITIES).optional(),
  /** Members who may use the agent when visibility is `members` (replaces the list). */
  memberIds: z.array(z.string().min(1).max(255)).max(500).optional(),
});

/** PUT /agents/:id/subagents — the agents this agent may hand work to. */
export const updateWorkspaceAgentSubagentsSchema = z.object({
  subagentIds: z.array(z.string().min(1).max(30)).max(19),
  delegateToSelf: z.boolean(),
});

export const runWorkspaceAgentSchema = z.object({
  message: z.string().min(1).max(20000).optional(),
  triggerData: z.record(z.unknown()).optional(),
});

export type CreateWorkspaceAgentInput = z.infer<typeof createWorkspaceAgentSchema>;
export type UpdateWorkspaceAgentInput = z.infer<typeof updateWorkspaceAgentSchema>;
export type RunWorkspaceAgentInput = z.infer<typeof runWorkspaceAgentSchema>;
export type UpdateWorkspaceAgentAccessInput = z.infer<typeof updateWorkspaceAgentAccessSchema>;
export type UpdateWorkspaceAgentSubagentsInput = z.infer<typeof updateWorkspaceAgentSubagentsSchema>;

/** What the caller may do with an agent (computed per request). */
export interface WorkspaceAgentCapabilities {
  /** Change its setup, routines and access (owner or weldagent:manage). */
  canEdit: boolean;
}

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
  /** The member responsible for the agent; null for agents from before ownership. */
  ownerId: string | null;
  visibility: WorkspaceAgentVisibility;
  /** Agents this agent may hand work to. */
  subagentIds: string[];
  /** Whether it may also hand work to copies of itself. */
  delegateToSelf: boolean;
  /** Members with access when visibility is `members` (detail responses only). */
  memberIds?: string[];
  /** What the caller may do (list and detail responses). */
  capabilities?: WorkspaceAgentCapabilities;
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

/** `GET /weldagent/agents/:id`: the agent plus what the Access tab needs. */
export interface WorkspaceAgentDetail extends WorkspaceAgent {
  /** The tools this agent can run right now (its grants and enabled tools applied). */
  availableTools?: WorkspaceAgentToolCatalogItem[];
  /**
   * Every permission key some platform tool needs (e.g. `"projects:read"`).
   * A grant that is not in this list gives the agent no platform tool.
   */
  toolPermissions?: string[];
}

/**
 * An action an agent parked for approval, as carried on the agent's reply in a
 * WeldChat room (`metadata.approvals` of the channel message). Decide it with
 * `POST /weldagent/approvals/:id/decide`; the status follows the decision.
 */
export interface AgentChannelApproval {
  id: string;
  /** What it would do, in words ("Create task "QA agent chat task""). */
  label: string;
  status: 'pending' | 'approved' | 'rejected';
}
