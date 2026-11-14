/**
 * Shared by the flow tests: an environment with in-memory KV, buckets and
 * counters, a recording ENTITY_EVENTS queue, the workspace rows in the master
 * pglite, and a few definitions.
 *
 * The routes open the master DB and the tenant DB of the link's workspace
 * themselves (`getMasterDb`, `getWorkspaceContextForOrg`); each test file mocks
 * them to return the pglite handles (see the `vi.mock` at the top of the tests),
 * as WeldSign's flow tests do.
 */

import type { Hono } from 'hono';
import { vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { formDefinitionSchema, type FormDefinition } from '@weldsuite/forms-engine/definition';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { memoryFormCounters } from '../lib/counters.memory';
import type { Env, Variables } from '../types';

export const ORG = 'org_forms';
export const WS = 'ws_forms';
export const PORTAL_KEY = 'portal-key';
export const SESSION_SECRET = 'session-secret';

export interface World {
  kv: ReturnType<typeof createMemoryKv>;
  privateBucket: R2Bucket;
  publicBucket: R2Bucket;
  sent: EntityEventMessage[];
  /** What `PROCESS_RESPONSE.create` was called with, in order. */
  processed: Array<{ id: string; params: unknown }>;
  env: Env;
}

export function newWorld(overrides: Partial<Env> = {}): World {
  const kv = createMemoryKv();
  const privateBucket = createMemoryR2();
  const publicBucket = createMemoryR2();
  const sent: EntityEventMessage[] = [];
  // A mock, read through `mock.calls`: in conformance mode the TypeScript run
  // calls it silently and only the Rust run's starts are recorded.
  const create = vi.fn(async (_options: { id: string; params: unknown }) => undefined);
  const env = {
    ENVIRONMENT: 'test',
    DATABASE_URL_MASTER: 'postgres://test',
    NEON_API_KEY: 'test',
    CLERK_SECRET_KEY: 'test',
    WORKSPACE_CACHE: kv,
    PRIVATE_STORAGE: privateBucket,
    STORAGE: publicBucket,
    R2_PUBLIC_URL: 'https://cdn.test',
    FORM_COUNTERS: memoryFormCounters(),
    FORMS_PORTAL_SECRET: PORTAL_KEY,
    FORMS_SESSION_SECRET: SESSION_SECRET,
    FORMS_PORTAL_URL: 'https://forms.test',
    PLATFORM_URL: 'https://app.test',
    BOT_CHECK_PROVIDER: 'none',
    FORMS_MIN_FILL_MS: '0',
    ENTITY_EVENTS: { send: async (m: EntityEventMessage) => void sent.push(m) },
    PROCESS_RESPONSE: {
      create,
      get: async () => {
        throw new Error('no such instance');
      },
    },
    ...overrides,
  } as unknown as Env;
  return {
    kv,
    privateBucket,
    publicBucket,
    sent,
    get processed() {
      return create.mock.calls.map(([options]) => options);
    },
    env,
  };
}

/**
 * The master pglite the routes open (`getMasterDb`), handed to the member
 * apps' context so conformance mode serves it to the Rust server too.
 */
let sharedMaster: MasterDatabase | undefined;
export function shareMasterDb(master: MasterDatabase): void {
  sharedMaster = master;
}

/** The events of one type, as `entity:action` strings, in order. */
export const eventNames = (sent: EntityEventMessage[]) => sent.map((m) => m.eventType);

/** A member of the workspace calling a router. */
export function memberApp(
  mount: string,
  router: Hono<{ Bindings: Env; Variables: Variables }>,
  world: World,
  db: Database,
  who: { userId?: string; permissions?: string[] } = {},
) {
  return createTestApp(mount, router, {
    context: {
      userId: who.userId ?? 'user_owner',
      orgId: ORG,
      workspaceId: WS,
      clerkOrgId: ORG,
      permissions: permissions(...(who.permissions ?? ['*'])),
      tenantDb: db,
      ...(sharedMaster ? { masterDb: sharedMaster as unknown as Database } : {}),
    },
    env: world.env,
  });
}

export const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Wipes the forms tables of both databases between tests. */
export async function resetForms(db: Database, master: MasterDatabase): Promise<void> {
  const t = schema;
  await db.delete(t.formAiSummaries);
  await db.delete(t.formResponseActions);
  await db.delete(t.formResponseFiles);
  await db.delete(t.formResponses);
  await db.delete(t.formInvitations);
  await db.delete(t.formIntegrations);
  await db.delete(t.formSubscriptions);
  await db.delete(t.formAccess);
  await db.delete(t.formVersions);
  await db.delete(t.forms);
  await db.delete(t.formFolders);
  await db.delete(t.formThemes);
  await db.delete(t.formSettings);
  await db.delete(t.workspaceMembers);
  await master.delete(masterSchema.formLinkRegistry);
  await master.delete(masterSchema.formInvitationRegistry);
  await master.delete(masterSchema.formAbuseReports);
}

/** The workspace and its plans in the master DB: Free (100 responses a month) and Pro (10,000, badge removable). */
export async function seedWorkspace(master: MasterDatabase, planSlug: 'free' | 'pro' = 'free'): Promise<void> {
  await master.delete(masterSchema.workspaces);
  await master.delete(masterSchema.plans);
  await master.insert(masterSchema.plans).values([
    { id: 'plan_free', name: 'Free', slug: 'free', isDefault: true, features: {} },
    { id: 'plan_pro', name: 'Pro', slug: 'pro', priceMonthly: '29.00', removeBranding: true, features: {} },
  ]);
  await master.insert(masterSchema.workspaces).values({ id: WS, name: 'Acme Staffing', slug: 'acme', planId: planSlug === 'pro' ? 'plan_pro' : 'plan_free' });
}

// ── Definitions ──────────────────────────────────────────────────────────────

/** One required question: the smallest form that publishes. */
export function simpleDefinition(): FormDefinition {
  return formDefinitionSchema.parse({
    blocks: [{ id: 'b_name', ref: 'name', type: 'short_text', title: 'Your name', required: true, properties: {} }],
    endings: [{ id: 'e_done', ref: 'thanks', title: 'Thanks {{field:name}}!' }],
  });
}

/**
 * A small survey: a required name, a note marked sensitive, the plan (scored),
 * and an extra question that is skipped when the respondent picks Free (a jump
 * straight to the ending), plus a hidden `utm_source` field.
 */
export function surveyDefinition(): FormDefinition {
  return formDefinitionSchema.parse({
    blocks: [
      { id: 'b_name', ref: 'name', type: 'short_text', title: 'Your name', required: true, properties: {} },
      { id: 'b_note', ref: 'private_note', type: 'short_text', title: 'Anything private?', sensitive: true, properties: {} },
      {
        id: 'b_plan',
        ref: 'plan',
        type: 'multiple_choice',
        title: 'Which plan?',
        required: true,
        properties: {
          choices: [
            { id: 'c_free', label: 'Free', score: 1 },
            { id: 'c_pro', label: 'Pro', score: 5 },
          ],
        },
      },
      { id: 'b_extra', ref: 'extra', type: 'short_text', title: 'Why Pro?', properties: {} },
    ],
    hidden: [{ name: 'utm_source' }],
    logic: [
      {
        blockId: 'b_plan',
        jumps: [
          {
            id: 'j_free',
            when: { op: 'and', conditions: [{ left: { type: 'field', id: 'b_plan' }, operator: 'any_of', right: { type: 'constant', value: ['c_free'] } }] },
            to: { type: 'ending', id: 'e_done' },
          },
        ],
      },
    ],
    endings: [{ id: 'e_done', ref: 'thanks', title: 'Thanks {{field:name}}! Score {{var:score}}', showScore: true }],
  });
}

/** A form with a document upload (up to two files, 1 MB each) and a signature. */
export function uploadDefinition(): FormDefinition {
  return formDefinitionSchema.parse({
    blocks: [
      { id: 'b_name', ref: 'name', type: 'short_text', title: 'Your name', required: true, properties: {} },
      { id: 'b_cv', ref: 'cv', type: 'file_upload', title: 'Your CV', required: true, properties: { maxFiles: 2, maxSizeMb: 1, accept: 'documents' } },
      { id: 'b_sign', ref: 'signature', type: 'signature', title: 'Sign here', properties: {} },
    ],
    endings: [{ id: 'e_done', ref: 'thanks', title: 'Received' }],
  });
}
