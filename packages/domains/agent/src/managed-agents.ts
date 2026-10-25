/**
 * Claude Managed Agents plumbing for WeldAgent.
 *
 * Every WeldAgent agent runs as a Claude Managed Agent: a persisted, versioned
 * agent object on the Anthropic side, synced lazily from the tenant row (see
 * {@link ensureManagedAgent}), and one session per conversation or per run.
 * The agent loop and the sandbox (bash, files, web) run at Anthropic; the
 * WeldSuite platform tools are declared as custom tools and executed here, in
 * the Worker, so grants, approvals and entity events keep working.
 *
 * One environment per deploy environment is shared by every tenant (it is only
 * a container template); it is found or created by name on first use.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  AgentCreateParams,
  BetaManagedAgentsCustomToolParams,
  BetaManagedAgentsAgentToolset20260401Params,
} from '@anthropic-ai/sdk/resources/beta/agents/agents';
import { zodSchema } from '@weldsuite/ai';
import {
  DEFAULT_WORKSPACE_AGENT_MODEL,
  isWorkspaceAgentModel,
  type WorkspaceAgentModel,
} from '@weldsuite/app-api-client/schemas/workspace-agents';
import { eq } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { WeldAgentEnv as Env } from './env';
import type { AgentDb, PlatformToolDefinition } from './tools';
import { agentHasGrants } from './tools';

export class ManagedAgentsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedAgentsConfigError';
  }
}

export function isManagedAgentsConfigured(env: Env): boolean {
  return typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.length > 0;
}

export function managedAgentsClient(env: Env): Anthropic {
  if (!isManagedAgentsConfigured(env)) {
    throw new ManagedAgentsConfigError('ANTHROPIC_API_KEY is not configured');
  }
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
}

/** The model an agent runs on; anything outside the Claude list runs on the default. */
export function resolveManagedModel(requested: string | null | undefined): WorkspaceAgentModel {
  return isWorkspaceAgentModel(requested) ? requested : DEFAULT_WORKSPACE_AGENT_MODEL;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Per-isolate cache; the environment id never changes for a deploy. */
let cachedEnvironmentId: string | null = null;

function environmentName(env: Env): string {
  return `weldsuite-weldagent-${env.ENVIRONMENT || 'development'}`;
}

/**
 * The shared sandbox environment. `ANTHROPIC_ENVIRONMENT_ID` pins it; without
 * it the environment is looked up by name and created when missing (names are
 * unique, so a concurrent create loses with a 409 and the lookup is retried).
 */
export async function ensureEnvironment(client: Anthropic, env: Env): Promise<string> {
  if (env.ANTHROPIC_ENVIRONMENT_ID) return env.ANTHROPIC_ENVIRONMENT_ID;
  if (cachedEnvironmentId) return cachedEnvironmentId;

  const name = environmentName(env);
  const find = async () => {
    for await (const candidate of client.beta.environments.list()) {
      if (candidate.name === name && !candidate.archived_at) return candidate.id;
    }
    return null;
  };

  let id = await find();
  if (!id) {
    try {
      const created = await client.beta.environments.create({
        name,
        config: {
          type: 'cloud',
          // Package installs for scripts; MCP is unused. web_search/web_fetch
          // run on Anthropic's side and are governed per agent, not here.
          networking: { type: 'limited', allow_package_managers: true, allow_mcp_servers: false },
        },
      });
      id = created.id;
    } catch (err) {
      if (!(err instanceof Anthropic.ConflictError)) throw err;
      id = await find();
    }
  }
  if (!id) throw new ManagedAgentsConfigError(`Could not resolve environment "${name}"`);
  cachedEnvironmentId = id;
  return id;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Sandbox tools, unlocked by the `computer:use` grant. */
const SANDBOX_TOOLS = ['bash', 'read', 'write', 'edit', 'glob', 'grep'] as const;
/** Web tools, unlocked by the `browser:use` grant. */
const WEB_TOOLS = ['web_search', 'web_fetch'] as const;

export interface BuiltinToolAccess {
  sandbox: boolean;
  web: boolean;
}

export function builtinToolAccess(permissions: string[]): BuiltinToolAccess {
  return {
    sandbox: agentHasGrants(permissions, ['computer:use']),
    web: agentHasGrants(permissions, ['browser:use']),
  };
}

/** Is `toolName` a sandbox (`computer:use`) or web (`browser:use`) tool? */
export function builtinToolGrant(toolName: string): 'computer:use' | 'browser:use' | null {
  if ((SANDBOX_TOOLS as readonly string[]).includes(toolName)) return 'computer:use';
  if ((WEB_TOOLS as readonly string[]).includes(toolName)) return 'browser:use';
  return null;
}

/**
 * The Anthropic agent toolset for the given access, or null when nothing is
 * granted. `auto` lets the server run safe calls and deny high-risk ones; a
 * call it can't decide pauses and is denied by the driver (no reviewer).
 * `ask` (worker objects, see {@link ensureManagedAgent}) pauses every call so
 * the driver can check it against the person the work is done for.
 */
function agentToolset(
  access: BuiltinToolAccess,
  policy: 'auto' | 'ask' = 'auto',
): BetaManagedAgentsAgentToolset20260401Params | null {
  if (!access.sandbox && !access.web) return null;
  return {
    type: 'agent_toolset_20260401',
    default_config: {
      enabled: false,
      permission_policy: { type: policy === 'ask' ? 'always_ask' : 'auto' },
    },
    configs: [
      ...SANDBOX_TOOLS.map((name) => ({ name, enabled: access.sandbox })),
      ...WEB_TOOLS.map((name) => ({ name, enabled: access.web })),
    ] as BetaManagedAgentsAgentToolset20260401Params['configs'],
  };
}

const customToolCache = new WeakMap<PlatformToolDefinition, BetaManagedAgentsCustomToolParams>();

async function customTool(def: PlatformToolDefinition): Promise<BetaManagedAgentsCustomToolParams> {
  const cached = customToolCache.get(def);
  if (cached) return cached;
  const jsonSchema = { ...((await zodSchema(def.parameters as never).jsonSchema) as Record<string, unknown>) };
  delete jsonSchema.$schema;
  const tool: BetaManagedAgentsCustomToolParams = {
    type: 'custom',
    name: def.name,
    description: def.description,
    input_schema: { ...jsonSchema, type: 'object' },
  };
  customToolCache.set(def, tool);
  return tool;
}

export type ManagedToolList = NonNullable<AgentCreateParams['tools']>;

/** Full tool list for a session or agent object: platform custom tools + toolset. */
export async function buildManagedTools(
  defs: PlatformToolDefinition[],
  access: BuiltinToolAccess,
  policy: 'auto' | 'ask' = 'auto',
): Promise<ManagedToolList> {
  const tools: ManagedToolList = await Promise.all(defs.map(customTool));
  const toolset = agentToolset(access, policy);
  if (toolset) tools.push(toolset);
  return tools;
}

// ---------------------------------------------------------------------------
// Agent object sync
// ---------------------------------------------------------------------------

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ManagedAgentRef {
  id: string;
  version: number;
}

export interface ManagedAgentSyncInput {
  agentId: string;
  workspaceId: string;
  name: string;
  description?: string | null;
  modelId: string;
  /** Base system prompt (skills/memory/run context are added per session). */
  system: string;
  tools: ManagedToolList;
  /**
   * Which object to sync: `main` (the agent itself, chats and runs) or
   * `worker` (the agent as someone's sub-agent). Defaults to `main`.
   */
  variant?: 'main' | 'worker';
  /** Sub-agents the main object may delegate to (worker refs, or itself). */
  roster?: Array<ManagedAgentRef | 'self'>;
}

function agentObjectConfig(env: Env, input: ManagedAgentSyncInput) {
  const roster = input.roster ?? [];
  return {
    name: input.name.slice(0, 256) || 'WeldAgent',
    description: input.description?.slice(0, 2048) || null,
    model: resolveManagedModel(input.modelId),
    system: input.system,
    tools: input.tools,
    metadata: {
      weldsuite_workspace_id: input.workspaceId,
      weldsuite_agent_id: input.agentId,
      weldsuite_env: env.ENVIRONMENT || 'development',
      ...(input.variant === 'worker' ? { weldsuite_variant: 'worker' } : {}),
    },
    // Only set when there is a roster, so agents without sub-agents keep the
    // config hash (and so the sessions) they had before delegation existed.
    ...(roster.length > 0
      ? {
          multiagent: {
            type: 'coordinator' as const,
            agents: roster.map((entry) =>
              entry === 'self' ? { type: 'self' as const } : { type: 'agent' as const, id: entry.id, version: entry.version },
            ),
          },
        }
      : {}),
  } satisfies AgentCreateParams;
}

/** The columns that hold a variant's Anthropic object id, version and config hash. */
function variantColumns(variant: 'main' | 'worker') {
  const a = schema.weldagentAgents;
  return variant === 'worker'
    ? { id: a.anthropicWorkerAgentId, version: a.anthropicWorkerAgentVersion, hash: a.anthropicWorkerConfigHash }
    : { id: a.anthropicAgentId, version: a.anthropicAgentVersion, hash: a.anthropicConfigHash };
}

/**
 * Make sure the agent's Anthropic agent object exists and matches its current
 * config, publishing a new version when it changed. Sessions pin the returned
 * version. Cheap when nothing changed: one hash comparison, no API call.
 *
 * An agent has up to two objects: its `main` one, and a `worker` one it runs
 * as when another agent delegates to it. The worker never has sub-agents (a
 * Managed Agents roster is one level deep) and its sandbox / web tools ask
 * the driver first: a roster member runs on its own configuration, which a
 * session can't narrow to the person chatting, so the driver does.
 */
export async function ensureManagedAgent(
  client: Anthropic,
  db: AgentDb,
  env: Env,
  input: ManagedAgentSyncInput,
): Promise<ManagedAgentRef> {
  const variant = input.variant ?? 'main';
  const cols = variantColumns(variant);
  const { weldagentAgents } = schema;
  const [row] = await db
    .select({ id: cols.id, version: cols.version, hash: cols.hash })
    .from(weldagentAgents)
    .where(eq(weldagentAgents.id, input.agentId))
    .limit(1);

  const config = agentObjectConfig(env, input);
  const hash = await sha256Hex(JSON.stringify(config));

  if (row?.id && row.version && row.hash === hash) {
    return { id: row.id, version: row.version };
  }

  let agent: { id: string; version: number } | null = null;
  if (row?.id) {
    try {
      // Unconditional update: the tenant row is the source of truth. An
      // update without `multiagent` keeps the stored roster, so clear it.
      agent = await client.beta.agents.update(row.id, { multiagent: null, ...config });
    } catch (err) {
      // Archived or gone (e.g. the WeldAgent agent was deleted and restored):
      // start over with a fresh agent object.
      if (!(err instanceof Anthropic.NotFoundError) && !(err instanceof Anthropic.BadRequestError)) throw err;
    }
  }
  agent ??= await client.beta.agents.create(config);

  await db
    .update(weldagentAgents)
    .set(
      variant === 'worker'
        ? { anthropicWorkerAgentId: agent.id, anthropicWorkerAgentVersion: agent.version, anthropicWorkerConfigHash: hash }
        : { anthropicAgentId: agent.id, anthropicAgentVersion: agent.version, anthropicConfigHash: hash },
    )
    .where(eq(weldagentAgents.id, input.agentId));

  return { id: agent.id, version: agent.version };
}

/**
 * Archive an agent's Anthropic agent object (agent deleted in WeldSuite).
 * Archiving is permanent on Anthropic's side; a restored WeldAgent agent gets
 * a new object on its next run. Best effort.
 */
export async function archiveManagedAgent(env: Env, anthropicAgentId: string | null | undefined): Promise<void> {
  if (!anthropicAgentId || !isManagedAgentsConfigured(env)) return;
  try {
    await managedAgentsClient(env).beta.agents.archive(anthropicAgentId);
  } catch (err) {
    console.warn('[weldagent/managed] archive agent failed:', err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** Session list cost in USD (the API reports minor units as an integer string). */
export function listCostUsd(amount: { amount: string; currency: string } | null | undefined): number {
  if (!amount || amount.currency !== 'USD') return 0;
  const cents = Number.parseInt(amount.amount, 10);
  return Number.isFinite(cents) ? cents / 100 : 0;
}

/** A USD amount as a session budget (`max_list_cost`, whole cents, > 0). */
export function budgetForUsd(usd: number) {
  const cents = Math.max(1, Math.ceil(usd * 100));
  return { type: 'limit' as const, max_list_cost: { amount: String(cents), currency: 'USD' as const } };
}
