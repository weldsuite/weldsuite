/**
 * HTTP client for weldsuite-agent-runtime (Cloudflare Sandbox + Browser Run).
 */

import type { Env } from '../../types';

export class AgentComputerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentComputerUnavailableError';
  }
}

function runtimeBase(env: Env): string | null {
  const enabled = (env.AGENT_COMPUTER_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (!enabled) return null;
  const url = env.AGENT_RUNTIME_URL?.trim();
  return url ? url.replace(/\/$/, '') : null;
}

async function runtimeFetch(
  env: Env,
  path: string,
  init: RequestInit & { workspaceId?: string } = {},
): Promise<Response> {
  const base = runtimeBase(env);
  if (!base) {
    throw new AgentComputerUnavailableError(
      'Agent computer is not configured (set AGENT_RUNTIME_URL and AGENT_COMPUTER_ENABLED).',
    );
  }
  const secret = env.INTERNAL_API_SECRET?.trim();
  if (!secret) {
    throw new AgentComputerUnavailableError('INTERNAL_API_SECRET is not configured');
  }

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${secret}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${base}${path}`, { ...init, headers });
  return res;
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = typeof data.error === 'string' ? data.error : `agent-runtime HTTP ${res.status}`;
    throw new AgentComputerUnavailableError(msg);
  }
  return data;
}

export async function computerStatus(env: Env, workspaceId: string) {
  const base = runtimeBase(env);
  if (!base) return { enabled: false as const, reason: 'not_configured' };
  const res = await runtimeFetch(
    env,
    `/v1/computer/status?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  return jsonOrThrow(res);
}

export async function computerExec(
  env: Env,
  input: { workspaceId: string; command: string; cwd?: string },
) {
  const res = await runtimeFetch(env, '/v1/computer/exec', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return jsonOrThrow(res);
}

export async function computerReadFile(
  env: Env,
  input: { workspaceId: string; path: string },
) {
  const res = await runtimeFetch(env, '/v1/computer/files/read', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return jsonOrThrow(res);
}

export async function computerWriteFile(
  env: Env,
  input: { workspaceId: string; path: string; content: string },
) {
  const res = await runtimeFetch(env, '/v1/computer/files/write', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return jsonOrThrow(res);
}

export async function computerListFiles(
  env: Env,
  input: { workspaceId: string; path: string },
) {
  const res = await runtimeFetch(env, '/v1/computer/files/list', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return jsonOrThrow(res);
}

export async function computerRunCode(
  env: Env,
  input: {
    workspaceId: string;
    code: string;
    language?: 'python' | 'javascript';
  },
) {
  const res = await runtimeFetch(env, '/v1/computer/code', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return jsonOrThrow(res);
}

export async function computerDestroy(env: Env, workspaceId: string) {
  const res = await runtimeFetch(env, '/v1/computer/destroy', {
    method: 'POST',
    body: JSON.stringify({ workspaceId }),
  });
  return jsonOrThrow(res);
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

export function isAgentComputerConfigured(env: Env): boolean {
  return runtimeBase(env) != null && Boolean(env.INTERNAL_API_SECRET?.trim());
}
