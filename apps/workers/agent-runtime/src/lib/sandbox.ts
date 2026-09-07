import { getSandbox } from '@cloudflare/sandbox';
import type { Env } from '../env';

/** Stable sandbox id for a workspace (shared by all agents in that workspace). */
export function workspaceSandboxId(workspaceId: string): string {
  const safe = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return `ws-${safe || 'unknown'}`;
}

export function getWorkspaceSandbox(env: Env, workspaceId: string) {
  return getSandbox(env.Sandbox, workspaceSandboxId(workspaceId));
}

/** Reject path traversal and keep work under /workspace. */
export function resolveWorkspacePath(input: string): string | { error: string } {
  const raw = (input || '').trim() || '/workspace';
  const normalized = raw.replace(/\\/g, '/');
  if (normalized.includes('\0') || normalized.includes('..')) {
    return { error: 'Invalid path' };
  }
  const absolute = normalized.startsWith('/') ? normalized : `/workspace/${normalized}`;
  if (!absolute.startsWith('/workspace')) {
    return { error: 'Paths must be under /workspace' };
  }
  return absolute;
}
