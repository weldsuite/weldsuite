/**
 * The `MergeInternal` entrypoint (what integration-webhook-worker calls over the
 * MERGE_INTERNAL binding): it resolves the workspace from the id the envelope
 * carries (`workspaces.id` or the Clerk org id), opens that tenant DB, applies
 * the event, and publishes its entity events as the system. The public app never
 * serves the internal route.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const state = vi.hoisted(() => ({ db: null as unknown, suspended: false, unknown: false, refs: [] as string[] }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getWorkspaceContextForOrg: async (_env: unknown, ref: string) => {
      state.refs.push(ref);
      if (state.unknown) throw new Error('workspace not found');
      return { id: 'ws_alpha', clerkOrgId: 'org_alpha', db: state.db, suspended: state.suspended };
    },
  };
});

import worker, { MergeInternal } from './index';
import { githubPull, openDb, resetTables } from './test/helpers';
import { seedConnection, seedIssue, seedRepository, seedTeam } from './test/seed';

let db: Database;
const sent: EntityEventMessage[] = [];

beforeAll(async () => {
  db = await openDb();
  state.db = db;
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
  state.suspended = false;
  state.unknown = false;
  state.refs = [];
  sent.length = 0;
});

function entrypoint() {
  const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), passThroughOnException: () => {} } as unknown as ExecutionContext;
  const env = {
    ENVIRONMENT: 'test',
    ENTITY_EVENTS: { send: async (m: EntityEventMessage) => void sent.push(m) },
  };
  return new MergeInternal(ctx, env as never);
}

const openedEvent = (workspaceId: string) => ({
  workspaceId,
  event: 'pull_request' as const,
  deliveryId: 'd-1',
  payload: {
    action: 'opened',
    installation: { id: 4242 },
    repository: { id: 900, full_name: 'acme/web' },
    pull_request: githubPull({ id: 5001, number: 1, title: 'PLAT-1 fix', draft: true }),
  },
});

async function setup() {
  const team = await seedTeam(db, 'PLAT');
  const issue = await seedIssue(db, team.id, 1, { status: 'todo' });
  const connection = await seedConnection(db, { externalAccountId: '4242' });
  await seedRepository(db, connection.id);
  return issue;
}

describe('MergeInternal.githubEvent', () => {
  it('applies the event for the workspace, by either of its ids, and publishes system events', async () => {
    const issue = await setup();
    for (const ref of ['org_alpha', 'ws_alpha']) {
      await db.delete(schema.mergeIssuePullRequests);
      await db.delete(schema.mergePullRequests);
      await db.update(schema.mergeIssues).set({ status: 'todo' }).where(eq(schema.mergeIssues.id, issue.id));
      sent.length = 0;

      expect(await entrypoint().githubEvent(openedEvent(ref))).toEqual({ outcome: 'applied' });
      expect(state.refs.at(-1)).toBe(ref);
      expect((await db.select().from(schema.mergeIssues).where(eq(schema.mergeIssues.id, issue.id)))[0]!.status).toBe('in_progress');
      expect(sent.map((m) => m.eventType)).toEqual(['merge_pull_request:created', 'merge_issue:updated']);
      expect(sent.every((m) => m.metadata.userId === 'system' && m.metadata.source === 'system' && m.metadata.workspaceId === 'org_alpha')).toBe(true);
    }
  });

  it('drops an event for a suspended workspace, and rejects an unknown workspace and an invalid envelope', async () => {
    await setup();
    state.suspended = true;
    expect(await entrypoint().githubEvent(openedEvent('org_alpha'))).toEqual({ outcome: 'ignored', reason: 'workspace_suspended' });
    expect(await db.select().from(schema.mergePullRequests)).toEqual([]);

    state.suspended = false;
    state.unknown = true;
    await expect(entrypoint().githubEvent(openedEvent('org_nobody'))).rejects.toThrow(/404/);
    await expect(entrypoint().githubEvent({ ...openedEvent('org_alpha'), event: 'issues' as never })).rejects.toThrow(/400/);
    expect(sent).toEqual([]);
  });

  it('is not served by the public app', async () => {
    const res = await worker.fetch(
      new Request('http://local/internal/github-event', { method: 'POST', body: JSON.stringify(openedEvent('org_alpha')) }),
      { ENVIRONMENT: 'test' } as never,
    );
    expect(res.status).toBe(404);
  });
});
