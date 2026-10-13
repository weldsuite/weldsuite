/**
 * Shared setup for the WeldReach public-API tests (`reach-*.test.ts`).
 *
 * `reachTestApp()` mounts the real `v1` router (so the real `reachAccess` gate,
 * the real scope checks and the real domain code run) behind the harness's
 * stubbed auth, with what the worker would get from Cloudflare faked at the
 * binding level:
 *
 *   - `WORKSPACE_CACHE`  a KV stub holding the `appaccess:<org>:weldreach` entry, so the
 *                        gate decides from cache and never opens the master DB
 *   - `SCHEDULE_INDEX`   a real SQLite D1 with the due-index migration, to read back what
 *                        launch / resume / enrol marked
 *   - `ENTITY_EVENTS`    a queue stub collecting every entity event, with an execution
 *                        context that is awaited before `request()` resolves
 *   - `FLAGSHIP`         the `weldreach-sending` kill switch
 *   - `STORAGE`          an in-memory bucket for the raw inbound replies
 *
 * No module is mocked: the suite shares one module cache across files.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import { TEST_ENCRYPTION_KEY } from '@weldsuite/reach-domain/testing/reach';
import type { AppAccess } from '@weldsuite/worker-kit/app-access';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { createExternalTestApp } from './harness';
import type { Database } from '../db';
import type { ApiKeySession, Env } from '../types';

/** The Clerk org id of the test workspace: the key of the access cache and of the due index. */
export const ORG_ID = 'org_reach_test';
/** The master workspace id of the test workspace (what entity events carry). */
export const WORKSPACE_ID = 'ws_reach_test';

const DUE_INDEX_MIGRATION = readFileSync(
  resolve(__dirname, '../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'),
  'utf8',
);

/** Every scope the reach routes know, except the named-only reply scope. */
export const REACH_SCOPES = [
  'reach_campaigns:read',
  'reach_campaigns:write',
  'reach_prospects:read',
  'reach_prospects:write',
  'reach_settings:read',
  'reach_settings:write',
  'reach_inbox:read',
  'reach_mailboxes:read',
];

/** The access row staff leave on an approved workspace, with `overrides` on top. */
export function approvedAccess(overrides: Partial<AppAccess> = {}): AppAccess {
  return {
    workspaceId: WORKSPACE_ID,
    status: 'approved',
    limits: {},
    billingStatus: 'active',
    billingStatusAt: null,
    ...overrides,
  };
}

/** A KV namespace that holds the cached access row (null: nothing cached, so the gate would open master). */
function accessCache(access: AppAccess | null): KVNamespace {
  const entries = new Map<string, unknown>();
  if (access) entries.set(`appaccess:${ORG_ID}:weldreach`, access);
  return {
    get: async (key: string, type?: string) => {
      const value = entries.get(key);
      if (value === undefined) return null;
      return type === 'json' ? value : JSON.stringify(value);
    },
    put: async (key: string, value: string) => {
      entries.set(key, JSON.parse(value));
    },
  } as unknown as KVNamespace;
}

/** The slice of R2 the inbox reads: stored raw replies, by key. */
export function memoryBucket(objects: Record<string, string> = {}): R2Bucket {
  return {
    get: async (key: string) => {
      const text = objects[key];
      return text === undefined ? null : { arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer };
    },
  } as unknown as R2Bucket;
}

export function reachSession(fields: Partial<ApiKeySession> = {}): ApiKeySession {
  return {
    keyId: 'key_reach_test',
    keyType: 'personal',
    workspaceId: WORKSPACE_ID,
    userId: 'user_reach_test',
    scopes: ['*'],
    tier: 'enterprise',
    hasApiAccess: true,
    databaseUrl: null,
    clerkOrgId: ORG_ID,
    licensedApps: null,
    ...fields,
  };
}

export interface ReachTestAppOptions {
  /** Scopes of the key. Default `*` plus every named reach scope except reply. */
  scopes?: string[];
  /** The cached access row. Default: approved. `null`: nothing cached. */
  access?: AppAccess | null;
  /** Session fields (a null `clerkOrgId`, a workspace key without a user, ...). */
  session?: Partial<ApiKeySession>;
  db: Database;
  /** Bindings on top of the defaults. */
  env?: Partial<Env>;
  /** Value of the `weldreach-sending` flag. Default on. */
  sendingEnabled?: boolean;
  /** Raw inbound replies in `STORAGE`, by key. */
  storage?: Record<string, string>;
}

export function reachTestApp(options: ReachTestAppOptions) {
  const events: EntityEventMessage[] = [];
  const pending: Promise<unknown>[] = [];
  const d1 = createSqliteD1(DUE_INDEX_MIGRATION);

  const flagship = {
    getBooleanValue: async (key: string, fallback: boolean) => (key === 'weldreach-sending' ? (options.sendingEnabled ?? true) : fallback),
  };
  const env: Partial<Env> = {
    WORKSPACE_CACHE: accessCache(options.access === undefined ? approvedAccess() : options.access),
    SCHEDULE_INDEX: d1,
    ENTITY_EVENTS: { send: async (message: EntityEventMessage) => void events.push(message) } as unknown as Queue<EntityEventMessage>,
    FLAGSHIP: flagship as unknown as Env['FLAGSHIP'],
    STORAGE: memoryBucket(options.storage),
    DATABASE_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    ...options.env,
  };

  const harness = createExternalTestApp({
    session: reachSession({ scopes: options.scopes ?? ['*', ...REACH_SCOPES], ...options.session }),
    tenantDb: options.db,
    env,
  });
  const executionCtx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise), passThroughOnException: () => undefined } as unknown as ExecutionContext;

  /** `app.request()` with the bindings and an awaited execution context, so queued events have landed when it resolves. */
  async function request(path: string, init?: RequestInit): Promise<Response> {
    const res = await harness.app.request(path, init, harness.env as unknown as Record<string, unknown>, executionCtx);
    await Promise.all(pending.splice(0));
    return res;
  }

  /** A JSON request: `send('POST', '/v1/reach/campaigns', { name: 'x' })`. */
  async function send<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; res: Response }> {
    const res = await request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T, res };
  }

  return {
    request,
    send,
    get: <T = unknown>(path: string) => send<T>('GET', path),
    events,
    /** Entity events of one type (and action), in publish order. */
    eventsOf: (entityType: string, action?: string) =>
      events.filter((e) => e.entityType === entityType && (action === undefined || e.action === action)),
    d1,
    /** The due-index row of this workspace's sweep, or null. */
    dueRow: () =>
      d1
        .prepare("SELECT workspace_id AS workspaceId, next_due_at AS nextDueAt FROM workspace_due_index WHERE kind = 'reach_send'")
        .first<{ workspaceId: string; nextDueAt: number }>(),
  };
}

/** The key the mailbox logins are sealed with in tests (the worker's `DATABASE_ENCRYPTION_KEY`). */
export { TEST_ENCRYPTION_KEY };
