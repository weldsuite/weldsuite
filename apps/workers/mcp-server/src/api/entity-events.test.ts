/**
 * Entity events from an MCP tool call carry the workspace's Clerk org id.
 *
 * The audit-log, workflow and realtime subscribers resolve the tenant DB by
 * org id. Stamping the master `workspaces.id` instead made every event from a
 * tool call (create_task, update_customer, ...) fail that lookup, so nothing
 * reached the audit log.
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { publishEntityEvent, type EntityEventMessage } from '@weldsuite/entity-events';
import type { HonoEnv } from './types';

// Stand-in for the v1 routes: one write that publishes the way they all do.
vi.mock('./routes/v1', () => {
  const v1 = new Hono<HonoEnv>();
  v1.post('/tasks', (c) => {
    publishEntityEvent({
      c,
      entityType: 'project_task',
      entityId: 'task_1',
      action: 'created',
      data: { id: 'task_1', projectId: null, title: 'From MCP' },
    });
    return c.json({ data: { id: 'task_1' } }, 201);
  });
  return { v1 };
});

import { INTERNAL_ORIGIN, apiApp, internalEnv } from './app';
import type { McpSession } from '../lib/api-types';
import type { Env } from '../types/env';

const session: McpSession = {
  tokenId: 'oat_test',
  userId: 'user_test',
  clerkOrgId: 'org_test',
  workspaceId: 'ws_test',
  workspaceName: 'Test',
  tier: 'enterprise',
  databaseUrl: 'postgres://test:test@localhost:5432/test',
  permissions: ['*'],
  permissionDenies: [],
  role: 'OWNER',
  clientId: null,
  licensedApps: null,
};

describe('mcp-server internal API · entity events', () => {
  it('stamps the Clerk org id and the user on the published event', async () => {
    const sent: EntityEventMessage[] = [];
    const pending: Promise<unknown>[] = [];
    const env = {
      ENTITY_EVENTS: { send: async (message: EntityEventMessage) => void sent.push(message) },
    } as unknown as Env;

    const res = await apiApp.fetch(
      new Request(`${INTERNAL_ORIGIN}/v1/tasks`, { method: 'POST' }),
      internalEnv(env, session),
      { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} },
    );
    await Promise.all(pending);

    expect(res.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.metadata).toMatchObject({ workspaceId: 'org_test', userId: 'user_test' });
  });
});
