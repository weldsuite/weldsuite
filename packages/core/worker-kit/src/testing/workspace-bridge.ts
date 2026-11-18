/**
 * Conformance mode's workspace lookups: `getWorkspaceContextForOrg` (from
 * `@weldsuite/worker-kit/db`) as the test has it, mock included, served over
 * HTTP so a Rust route that opens a workspace by reference outside a
 * member's request (a WeldPanel share link's) finds the same workspace, or
 * none, in the same state. The Rust side is
 * `rust/bins/weldsuite/src/conformance_panel.rs`.
 *
 *   POST /workspace { reference }
 *     → 200 { id, clerkOrgId, suspended }   the lookup answered
 *     → 404                                  it threw (no such workspace)
 *
 * Only the answer crosses: the database such a test's lookup hands out is
 * its own tenant database, which Rust already has as the context's.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveOnLoopback } from './bucket-bridge';

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
}

interface WorkspaceLike {
  id?: unknown;
  clerkOrgId?: unknown;
  suspended?: unknown;
}

async function handle(env: Record<string, unknown>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/workspace' || req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  const { reference } = (await readJson(req)) as { reference?: unknown };
  // The module as the test sees it: its `vi.mock` of `@weldsuite/worker-kit/db` applies here too.
  const { getWorkspaceContextForOrg } = await import('../db');
  let workspace: WorkspaceLike;
  try {
    workspace = (await getWorkspaceContextForOrg(env as never, String(reference ?? ''))) as WorkspaceLike;
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(
    JSON.stringify({
      id: typeof workspace.id === 'string' ? workspace.id : null,
      clerkOrgId: typeof workspace.clerkOrgId === 'string' ? workspace.clerkOrgId : null,
      suspended: workspace.suspended === true,
    }),
  );
}

/** The env of the request in flight (requests run one at a time). */
let current: Record<string, unknown> = {};
let server: Promise<string> | undefined;

/**
 * The bridge's URL: one server per test process, answering with the env of
 * the request in flight, as the conformance requests run one at a time.
 */
export function workspaceBridgeUrl(env: Record<string, unknown>): Promise<string> {
  current = env;
  server ??= serveOnLoopback((req, res) => handle(current, req, res));
  return server;
}
