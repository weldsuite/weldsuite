import { useQuery } from '@tanstack/react-query';

// =============================================================================
// Query Keys
// =============================================================================

const agentKeys = {
  all: ['agents'] as const,
  list: (filters?: { status?: string }) =>
    [...agentKeys.all, 'list', filters] as const,
  detail: (id: string) => [...agentKeys.all, 'detail', id] as const,
  runs: (agentId: string) => [...agentKeys.all, 'runs', agentId] as const,
};

// =============================================================================
// Types
// =============================================================================

interface AgentTokensByModel {
  [modelId: string]: { session: number; weekly: number };
}

export interface Agent {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  status: 'draft' | 'active' | 'paused';
  systemPrompt: string;
  modelId: string;
  temperature: string;
  maxTokens: number;
  enabledTools: string[];
  eventSubscriptions: string[];
  scheduleConfig: { cron: string; timezone: string } | null;
  integrationIds: string[];
  integrationToolPermissions: Record<string, string[]>;
  maxIterations: number;
  maxTotalTokens: number;
  isSupervisor: boolean;
  subAgentIds: string[];
  isSystem: boolean;
  systemKey: string | null;
  packageSlug: string;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastRunStatus: string | null;
  createdAt: string;
  updatedAt: string;
  sessionUsage: number;
  sessionLimit: number;
  sessionResetsAt: string;
  weeklyUsage: number;
  weeklyLimit: number;
  weeklyResetsAt: string;
  tokensByModel: AgentTokensByModel;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'budget_deferred';
  triggerType: string | null;
  triggerData: unknown;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  totalIterations: number | null;
  totalTokensUsed: number | null;
  toolCallCount: number | null;
  result: {
    summary: string;
    actionsPerformed: Array<{ tool: string; description: string; success: boolean }>;
  } | null;
  error: string | null;
  createdAt: string;
}

export interface AgentWithRuns extends Agent {
  recentRuns: AgentRun[];
}

// =============================================================================
// Queries
// =============================================================================

// AI (and every AI DB table — agents, agent_runs, agent_packages, etc.) has
// been removed platform-wide. The `/ai/*` endpoints are gone, so these
// queries no longer hit the network — they resolve to an empty/neutral
// result immediately. This keeps every remaining consumer (the Agents
// module, WeldChat's bot-invite/mention pickers, the agents sidebar)
// working without errors: they just see zero agents.
export function useAgents(_filters?: { status?: string }) {
  return useQuery({
    queryKey: agentKeys.list(_filters),
    queryFn: async (): Promise<Agent[]> => [],
    staleTime: Infinity,
  });
}

export function useAgent(id: string) {
  return useQuery({
    queryKey: agentKeys.detail(id),
    queryFn: async (): Promise<AgentWithRuns | undefined> => undefined,
    enabled: !!id,
    staleTime: Infinity,
  });
}

export function useAgentRuns(agentId: string) {
  return useQuery({
    queryKey: agentKeys.runs(agentId),
    queryFn: async () => ({ runs: [] as AgentRun[], total: 0 }),
    enabled: !!agentId,
    staleTime: Infinity,
  });
}
