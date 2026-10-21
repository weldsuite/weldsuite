import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { AdminIdentity } from './auth';
import {
  cancelDatabaseMove,
  listWorkspaceDatabaseMoves,
  loadLiveDatabases,
  measureShardSizes,
  recoverDatabaseMove,
  startDatabaseMove,
} from './workspace-worker';

const identity: AdminIdentity = {
  userId: 'user_1',
  email: 'ops@weldsuite.org',
  name: 'Ops',
  role: 'superadmin',
  isSuperAdmin: true,
};

const SECRET = 'x'.repeat(43);
const fetchMock = vi.fn<typeof fetch>();

function answer(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return {
    url: String(url),
    init: init!,
    headers: init!.headers as Record<string, string>,
  };
}

beforeEach(() => {
  vi.stubEnv('WORKSPACE_WORKER_URL', 'https://workspace-worker-test.weldsuite.org//');
  vi.stubEnv('WORKSPACE_ADMIN_SECRET', SECRET);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('workspace worker client', () => {
  it('sends the secret and the acting admin with their role, and posts the move as JSON', async () => {
    answer(202, { data: { moveId: 'dbm_1', kind: 'shard_to_dedicated' } });
    const result = await startDatabaseMove(identity, 'ws_1', {
      target: 'dedicated',
      reason: 'noisy neighbour',
    });

    expect(result).toEqual({
      ok: true,
      data: { moveId: 'dbm_1', kind: 'shard_to_dedicated' },
    });
    const { url, init, headers } = lastCall();
    expect(url).toBe('https://workspace-worker-test.weldsuite.org/api/internal/admin/workspaces/ws_1/database-moves');
    expect(init.method).toBe('POST');
    expect(headers).toMatchObject({
      'x-admin-secret': SECRET,
      'x-admin-email': 'ops@weldsuite.org',
      'x-admin-user-id': 'user_1',
      'x-admin-role': 'superadmin',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      target: 'dedicated',
      reason: 'noisy neighbour',
    });
  });

  it("passes the worker's refusal on, code and words", async () => {
    answer(409, {
      error: {
        code: 'MOVE_IN_PROGRESS',
        message: 'The workspace is already being moved',
      },
    });
    const result = await startDatabaseMove(identity, 'ws_1', {
      target: 'shard:auto',
      reason: 'rebalance',
    });
    expect(result).toEqual({
      ok: false,
      code: 'MOVE_IN_PROGRESS',
      error: 'The workspace is already being moved',
    });
  });

  it('escapes ids in the path', async () => {
    answer(202, { data: { moveId: 'a/b', status: 'cancelling' } });
    await cancelDatabaseMove(identity, 'a/b');
    expect(lastCall().url).toBe(
      'https://workspace-worker-test.weldsuite.org/api/internal/admin/database-moves/a%2Fb/cancel',
    );
  });

  it('sends force on a recovery', async () => {
    answer(200, {
      data: {
        moveId: 'dbm_1',
        status: 'failed',
        sourceUnlocked: true,
        targetReleased: true,
      },
    });
    await recoverDatabaseMove(identity, 'dbm_1', true);
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ force: true });
  });

  it('is not configured without a URL or secret, and calls nothing', async () => {
    vi.stubEnv('WORKSPACE_ADMIN_SECRET', '');
    expect(await listWorkspaceDatabaseMoves(identity, 'ws_1')).toEqual({
      kind: 'not_configured',
    });
    expect(
      await startDatabaseMove(identity, 'ws_1', {
        target: 'dedicated',
        reason: 'x',
      }),
    ).toMatchObject({
      ok: false,
      code: 'NOT_CONFIGURED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an unreachable worker without throwing', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await listWorkspaceDatabaseMoves(identity, 'ws_1')).toEqual({
      kind: 'error',
      message: 'The workspace worker could not be reached.',
    });
  });

  it('refuses an answer it does not understand', async () => {
    answer(200, { data: [{ id: 'dbm_1' }] });
    const state = await listWorkspaceDatabaseMoves(identity, 'ws_1');
    expect(state.kind).toBe('error');
  });

  it('names at most 50 dedicated projects for the live state', async () => {
    answer(200, {
      data: { shards: [], dedicated: [], fetchedAt: '2026-10-19T12:00:00Z' },
    });
    const ids = Array.from({ length: 60 }, (_, i) => `proj-${i}`);
    const state = await loadLiveDatabases(identity, ids);
    expect(state.kind).toBe('ok');
    const query = new URL(lastCall().url).searchParams.get('projectIds');
    expect(query?.split(',')).toHaveLength(50);
  });

  it('asks for the live state without a query when no project is named', async () => {
    answer(200, {
      data: { shards: [], dedicated: [], fetchedAt: '2026-10-19T12:00:00Z' },
    });
    await loadLiveDatabases(identity);
    expect(lastCall().url).toBe('https://workspace-worker-test.weldsuite.org/api/internal/admin/databases/live');
  });

  it('checks the shard sizes it gets back', async () => {
    answer(200, {
      data: {
        shardId: 'nsp_a',
        neonProjectId: 'p',
        databases: [],
        totalBytes: 0,
      },
    });
    expect(await measureShardSizes(identity, 'nsp_a')).toMatchObject({
      ok: true,
    });
    answer(200, { data: { shardId: 'nsp_a' } });
    expect(await measureShardSizes(identity, 'nsp_a')).toMatchObject({
      ok: false,
      code: 'BAD_RESPONSE',
    });
  });
});
