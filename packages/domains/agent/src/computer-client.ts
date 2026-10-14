/**
 * HTTP client for weldsuite-agent-runtime: Browser Run sessions behind the
 * browser_* agent tools. (The sandbox and web search run at Anthropic, as
 * Claude Managed Agents tools, and do not come through here.)
 *
 * Preferred transport: the `AGENT_RUNTIME` service binding to agent-runtime's
 * `AgentRuntimeInternal` entrypoint (no Authorization header: reachable only
 * over a binding, so trusted by topology). Fallback, when the binding is absent
 * or the entrypoint is not deployed yet: the public `AGENT_RUNTIME_URL` with the
 * `INTERNAL_API_SECRET` bearer. It goes once every env has the binding
 * (docs/plans/app-api-module-split.md, rollout item 7).
 */

import type { WeldAgentEnv as Env } from './env';

export class AgentComputerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentComputerUnavailableError';
  }
}

function computerEnabled(env: Env): boolean {
  return (env.AGENT_COMPUTER_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/** Public URL of agent-runtime (fallback transport), or null when unset/disabled. */
function runtimeBase(env: Env): string | null {
  if (!computerEnabled(env)) return null;
  const url = env.AGENT_RUNTIME_URL?.trim();
  return url ? url.replace(/\/$/, '') : null;
}

/** True when a transport (binding or URL) is configured and the computer is enabled. */
function runtimeReachable(env: Env): boolean {
  return computerEnabled(env) && (Boolean(env.AGENT_RUNTIME) || runtimeBase(env) != null);
}

/** A named entrypoint that is not exported (yet) fails the call before any handler runs. */
function isMissingEntrypoint(err: unknown): boolean {
  return err instanceof Error && /entrypoint/i.test(err.message);
}

async function runtimeFetch(
  env: Env,
  path: string,
  init: RequestInit & { workspaceId?: string } = {},
): Promise<Response> {
  if (!runtimeReachable(env)) {
    throw new AgentComputerUnavailableError(
      'Agent computer is not configured (bind AGENT_RUNTIME or set AGENT_RUNTIME_URL, and AGENT_COMPUTER_ENABLED).',
    );
  }

  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  // Preferred: the AgentRuntimeInternal entrypoint over the service binding.
  // No secret; only a missing entrypoint falls back, so a call never runs twice.
  if (computerEnabled(env) && env.AGENT_RUNTIME) {
    try {
      return await env.AGENT_RUNTIME.fetch(`https://agent-runtime${path}`, { ...init, headers });
    } catch (err) {
      if (!isMissingEntrypoint(err)) throw err;
      console.warn('[agent-computer] AGENT_RUNTIME entrypoint unavailable, falling back to URL:', err);
    }
  }

  const base = runtimeBase(env);
  if (!base) {
    throw new AgentComputerUnavailableError(
      'Agent computer is not configured (bind AGENT_RUNTIME or set AGENT_RUNTIME_URL, and AGENT_COMPUTER_ENABLED).',
    );
  }
  const secret = env.INTERNAL_API_SECRET?.trim();
  if (!secret) {
    throw new AgentComputerUnavailableError('INTERNAL_API_SECRET is not configured');
  }

  headers.set('Authorization', `Bearer ${secret}`);
  return fetch(`${base}${path}`, { ...init, headers });
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = typeof data.error === 'string' ? data.error : `agent-runtime HTTP ${res.status}`;
    throw new AgentComputerUnavailableError(msg);
  }
  return data;
}

export async function browserOpen(
  env: Env,
  input: { workspaceId: string; agentId: string; url: string },
) {
  const res = await runtimeFetch(env, '/v1/browser/open', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return jsonOrThrow(res);
}

export async function browserAct(
  env: Env,
  input: {
    workspaceId: string;
    agentId: string;
    action: 'goto' | 'click' | 'type' | 'press' | 'wait' | 'screenshot' | 'extract' | 'live_view';
    url?: string;
    selector?: string;
    text?: string;
    key?: string;
    waitMs?: number;
  },
) {
  const res = await runtimeFetch(env, '/v1/browser/act', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return jsonOrThrow(res);
}

export async function browserClose(
  env: Env,
  input: { workspaceId: string; agentId: string },
) {
  const res = await runtimeFetch(env, '/v1/browser/close', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return jsonOrThrow(res);
}
