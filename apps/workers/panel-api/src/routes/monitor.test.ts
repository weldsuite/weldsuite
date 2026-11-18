/**
 * The monitoring and data-out routes on a real tenant and master schema
 * (pglite): alerts, scheduled reports (subscriptions), raw exports and custom
 * collector domains.
 *
 * What must not regress:
 *   1. Secrets go in and never come out: the Slack webhook URL and the S3
 *      secret key are sealed, the DTOs say `slack: true`, and neither reaches
 *      an entity event.
 *   2. Every create, update and delete keeps the master schedule registry in
 *      step (disabled, paused or deleted = no row), so the cron runs exactly
 *      what is live.
 *   3. Permissions and ownership: `panel_reports:*` with the owner (or
 *      `panel_projects:manage`) for alerts and subscriptions,
 *      `panel_projects:manage` for exports and domains; a target the caller
 *      cannot see is a 404.
 *   4. Custom domains answer 503 until Cloudflare for SaaS is configured, and
 *      hand out the install snippet for their host once active.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, schema, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import { specCacheKey } from '@weldsuite/panel-domain/query';
import { memoryTransport } from '@weldsuite/emails/transports/memory';
import { __setZonesFetchForTests } from '@weldsuite/cloudflare-zones';
import type { PanelAlertDto, PanelDomainDto, PanelExportDto, PanelSubscriptionDto } from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import type { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { RUNS, entityQueue, memoryKv, minted } from '../test-support/fakes';
import { digestSpec } from '../services/subscriptions';

// The master database goes through `conformanceMasterDb`, so in conformance
// mode the TypeScript run of a write works in a transaction that is rolled
// back before the Rust server writes (both write the schedule registry and
// custom domains). System mail lands in a memory transport, which the
// conformance harness compares with the Rust server's mail; `sent` is its list.
const state = vi.hoisted(() => ({ master: null as unknown, transport: null as unknown, sent: [] as unknown[] }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => conformanceMasterDb(state.master) as never };
});
vi.mock('@weldsuite/emails/transports/binding', () => ({ workerTransport: () => state.transport }));

import alertsRoutes from './alerts';
import subscriptionsRoutes from './subscriptions';
import exportsRoutes from './exports';
import domainsRoutes from './domains';

const { panelAlerts, panelExports, panelProjects, panelReports, panelSubscriptions, workspaceMembers } = schema;
const { panelCustomDomains, panelScheduleRegistry } = masterSchema;

const KEY = '0'.repeat(63) + '3';
const SLACK = 'https://hooks.slack.com/services/T1/B1/topsecretvalue';
const READ_WRITE = ['panel_reports:read', 'panel_reports:create', 'panel_reports:update', 'panel_reports:delete'];
const MANAGE = ['panel_projects:read', 'panel_projects:manage'];

let db: Database;
let master: AnyMasterDatabase;
let events: EntityEventMessage[] = [];

const SPEC = { kind: 'trends', projectId: 'pnp_a', series: [{ event: 'Signed up', label: 'Signups' }] };

function env(extra: Record<string, unknown> = {}) {
  return { WORKSPACE_CACHE: memoryKv(), ENTITY_EVENTS: entityQueue(events), DATABASE_ENCRYPTION_KEY: KEY, PLATFORM_URL: 'https://app.weldsuite.org', ...extra };
}

function mount(path: string, routes: Hono<{ Bindings: Env; Variables: Variables }>, grants: string[], userId = 'user_alice', envExtra: Record<string, unknown> = {}, workspaceId = 'ws_alpha') {
  return createTestApp(path, routes, {
    context: { permissions: permissions(...grants), tenantDb: db, masterDb: master as unknown as Database, userId, orgId: 'org_x', workspaceId, clerkOrgId: 'org_x' },
    env: env(envExtra) as never,
    moduleApiErrors: true,
  });
}

const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}
const registry = () => master.select().from(panelScheduleRegistry);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  state.master = master;
}, 120_000);

beforeEach(async () => {
  for (const t of [panelAlerts, panelSubscriptions, panelExports, panelReports, panelProjects, workspaceMembers]) await db.delete(t);
  await master.delete(panelScheduleRegistry);
  await master.delete(panelCustomDomains);
  await db.insert(panelProjects).values({ id: 'pnp_a', name: 'Shop', token: 'wpk_a', settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' });
  await db.insert(workspaceMembers).values([
    { id: 'wm_1', userId: 'user_alice', email: 'alice@example.com', name: 'Alice', role: 'OWNER', status: 'ACTIVE' },
    { id: 'wm_2', userId: 'user_bram', email: 'bram@example.com', name: 'Bram', role: 'MEMBER', status: 'ACTIVE' },
  ]);
  await db.insert(panelReports).values([
    { id: 'pnr_trends', projectId: 'pnp_a', kind: 'trends', name: 'Signups', spec: SPEC, ownerUserId: 'user_alice', visibility: 'workspace' },
    { id: 'pnr_private', projectId: 'pnp_a', kind: 'trends', name: 'Bram only', spec: SPEC, ownerUserId: 'user_bram', visibility: 'private' },
    { id: 'pnr_funnel', projectId: 'pnp_a', kind: 'funnel', name: 'Funnel', spec: { kind: 'funnel', projectId: 'pnp_a', steps: [{ event: 'a' }, { event: 'b' }] }, ownerUserId: 'user_alice', visibility: 'workspace' },
  ]);
  events = [];
  const transport = memoryTransport();
  state.transport = transport;
  state.sent = transport.sent;
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setZonesFetchForTests(undefined);
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

describe('alerts', () => {
  const PATH = '/api/panel/alerts';
  const alerts = (grants = READ_WRITE, userId = 'user_alice', envExtra: Record<string, unknown> = {}) => mount(PATH, alertsRoutes, grants, userId, envExtra);
  const body = (extra: Record<string, unknown> = {}) => ({
    projectId: 'pnp_a',
    name: 'Signups dropped',
    reportId: 'pnr_trends',
    condition: { type: 'threshold', operator: 'below', value: 10 },
    channels: { emailUserIds: ['user_alice'], inApp: true, slackWebhookUrl: SLACK },
    ...extra,
  });

  it('creates an alert with a sealed Slack webhook, schedules it, and publishes without channels', async () => {
    const res = await alerts().request(PATH, json(body()));
    expect(res.status).toBe(201);
    const text = await res.clone().text();
    expect(text).not.toContain('hooks.slack.com');
    const alert = await data<PanelAlertDto>(res);
    expect(alert).toMatchObject({ projectId: 'pnp_a', reportId: 'pnr_trends', seriesIndex: 0, checkInterval: 'daily', state: 'pending', enabled: true, ownerUserId: 'user_alice' });
    expect(alert.channels).toEqual({ emailUserIds: ['user_alice'], inApp: true, slack: true, weldchatChannelId: null });
    expect(alert.nextCheckAt).not.toBeNull();

    const [row] = await db.select().from(panelAlerts);
    expect(row!.slackWebhookCiphertext).toBeTruthy();
    expect(row!.slackWebhookCiphertext).not.toContain('slack.com');
    expect(await registry()).toMatchObject([{ kind: 'alert', objectId: alert.id, workspaceId: 'ws_alpha' }]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityType: 'panel_alert', action: 'created', entityId: minted(alert.id) });
    expect(JSON.stringify(events)).not.toContain('slack');
    expect(events[0]!.data).toEqual({ id: minted(alert.id), projectId: 'pnp_a', name: 'Signups dropped', state: 'pending', value: null, enabled: true });

    const listed = (await (await alerts().request(`${PATH}?projectId=pnp_a`)).json()) as { data: PanelAlertDto[] };
    expect(listed.data.map((a) => a.id)).toEqual([alert.id]);
  });

  it('refuses a target the caller cannot use, an unknown member, a missing series, and a sealed secret without a key', async () => {
    expect((await alerts().request(PATH, json(body({ reportId: 'pnr_private' })))).status).toBe(404);
    expect((await alerts().request(PATH, json(body({ reportId: 'pnr_funnel' })))).status).toBe(400);
    expect((await alerts().request(PATH, json(body({ seriesIndex: 3 })))).status).toBe(400);
    expect((await alerts().request(PATH, json(body({ channels: { emailUserIds: ['user_nobody'], inApp: false } })))).status).toBe(400);
    expect((await alerts().request(PATH, json(body({ channels: { emailUserIds: [], inApp: false, slackWebhookUrl: 'https://evil.example/hook' } })))).status).toBe(400);
    expect((await alerts().request(PATH, json(body({ reportId: 'pnr_trends', spec: SPEC })))).status).toBe(400);
    expect((await alerts().request(PATH, json(body({ projectId: 'pnp_zzz' })))).status).toBe(404);
    expect((await alerts(['panel_reports:read']).request(PATH, json(body()))).status).toBe(403);
    expect((await alerts(READ_WRITE, 'user_alice', { DATABASE_ENCRYPTION_KEY: undefined }).request(PATH, json(body()))).status).toBe(503);
    expect(await db.select().from(panelAlerts)).toHaveLength(0);
  });

  it('takes a spec of its own instead of a report', async () => {
    const res = await alerts().request(PATH, json(body({ reportId: undefined, spec: SPEC, checkInterval: 'hourly', condition: { type: 'anomaly', sensitivity: 'high' } })));
    expect(res.status).toBe(201);
    expect(await data<PanelAlertDto>(res)).toMatchObject({ reportId: null, checkInterval: 'hourly', condition: { type: 'anomaly', sensitivity: 'high' } });
  });

  it('lets the owner change, disable, snooze and delete, keeps the registry in step, and refuses others', async () => {
    const created = await data<PanelAlertDto>(await alerts().request(PATH, json(body())));
    const url = `${PATH}/${created.id}`;

    expect((await alerts(READ_WRITE, 'user_bram').request(url, json({ name: 'x' }, 'PATCH'))).status).toBe(403);
    expect((await alerts([...READ_WRITE, 'panel_projects:manage'], 'user_bram').request(url, json({ name: 'Managed' }, 'PATCH'))).status).toBe(200);

    const disabled = await data<PanelAlertDto>(await alerts().request(url, json({ enabled: false }, 'PATCH')));
    expect(disabled).toMatchObject({ enabled: false, nextCheckAt: null, channels: { slack: true } });
    expect(await registry()).toHaveLength(0);
    await alerts().request(url, json({ enabled: true, channels: { emailUserIds: [], inApp: false, slackWebhookUrl: null } }, 'PATCH'));
    expect(await registry()).toHaveLength(1);
    expect((await db.select().from(panelAlerts))[0]!.slackWebhookCiphertext).toBeNull();

    expect((await alerts().request(`${url}/snooze`, json({ until: '2020-01-01T00:00:00Z' }))).status).toBe(400);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect((await data<PanelAlertDto>(await alerts().request(`${url}/snooze`, json({ until })))).snoozedUntil).toBe(until);

    const history = (await (await alerts().request(`${url}/events`)).json()) as { data: unknown[] };
    expect(history.data).toEqual([]);

    expect((await alerts(READ_WRITE, 'user_bram').request(url, { method: 'DELETE' })).status).toBe(403);
    expect((await alerts().request(url, { method: 'DELETE' })).status).toBe(204);
    expect(await registry()).toHaveLength(0);
    expect((await alerts().request(url)).status).toBe(404);
    expect(events.map((e) => e.action)).toEqual(['created', 'updated', 'updated', 'updated', 'updated', 'deleted']);
  });

  it('sends a test message on its channels', async () => {
    const created = await data<PanelAlertDto>(await alerts().request(PATH, json(body({ channels: { emailUserIds: ['user_alice', 'user_bram'], inApp: false } }))));
    const res = await alerts().request(`${PATH}/${created.id}/test`, json({}));
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ delivered: [{ channel: 'email', ok: true, recipients: 2, error: null }] });
    expect(state.sent).toHaveLength(2);
    expect((state.sent[0] as { subject: string }).subject).toBe('Test: Signups dropped');
  });
});

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

describe('subscriptions', () => {
  const PATH = '/api/panel/subscriptions';
  // The report's numbers come from the query cache (`WORKSPACE_CACHE`), under
  // the key of the spec a scheduled report runs, so the TypeScript run and
  // the Rust server (which reads the same KV) send the same digest.
  const cache = new Map<string, string>();
  beforeEach(async () => {
    cache.clear();
    const spec = digestSpec(SPEC);
    const result = {
      kind: 'trends',
      result: {
        range: { from: '', to: '', timezone: 'UTC', clampedToRetention: false, previousFrom: null, previousTo: null },
        interval: 'day',
        series: [{ seriesIndex: 0, label: 'Signups', breakdownValue: null, total: 42, points: [], previous: { total: 21, points: [] } }],
      },
    };
    cache.set(await specCacheKey('ws_alpha', 'pnp_a', spec), JSON.stringify({ result, dataAsOf: '2026-11-16T10:00:00.000Z' }));
  });
  const subs = (grants = READ_WRITE, userId = 'user_alice') => mount(PATH, subscriptionsRoutes, grants, userId, { WORKSPACE_CACHE: memoryKv(cache) });
  const body = (extra: Record<string, unknown> = {}) => ({
    projectId: 'pnp_a',
    name: 'Monday signups',
    targetType: 'report',
    targetId: 'pnr_trends',
    schedule: { frequency: 'weekly', hour: 9, weekday: 1, timezone: 'Europe/Amsterdam' },
    channels: { emailUserIds: ['user_alice'], inApp: false },
    ...extra,
  });

  it('creates on a visible target, schedules it, and lists it', async () => {
    const res = await subs().request(PATH, json(body()));
    expect(res.status).toBe(201);
    const sub = await data<PanelSubscriptionDto>(res);
    expect(sub).toMatchObject({ targetType: 'report', targetId: 'pnr_trends', enabled: true, channels: { slack: false } });
    expect(new Date(sub.nextRunAt!).getUTCDay()).toBe(1);
    const [row] = await registry();
    expect(row).toMatchObject({ kind: 'subscription', objectId: sub.id });
    expect(row!.nextRunAt.toISOString()).toBe(sub.nextRunAt);
    expect(events[0]).toMatchObject({ entityType: 'panel_subscription', action: 'created' });
    expect(Object.keys(events[0]!.data)).not.toContain('channels');

    const listed = (await (await subs().request(`${PATH}?projectId=pnp_a&targetId=pnr_trends`)).json()) as { data: PanelSubscriptionDto[] };
    expect(listed.data.map((s) => s.id)).toEqual([sub.id]);
  });

  it('refuses someone else’s private report and an invalid schedule', async () => {
    expect((await subs().request(PATH, json(body({ targetId: 'pnr_private' })))).status).toBe(404);
    expect((await subs().request(PATH, json(body({ targetType: 'dashboard', targetId: 'pnd_none' })))).status).toBe(404);
    expect((await subs().request(PATH, json(body({ schedule: { frequency: 'weekly', hour: 9, timezone: 'UTC' } })))).status).toBe(400);
    expect((await subs().request(PATH, json(body({ schedule: { frequency: 'daily', hour: 9, timezone: 'Mars/Olympus' } })))).status).toBe(400);
  });

  it('pauses, sends now with the report’s numbers, and deletes', async () => {
    const sub = await data<PanelSubscriptionDto>(await subs().request(PATH, json(body())));
    const url = `${PATH}/${sub.id}`;
    const paused = await data<PanelSubscriptionDto>(await subs().request(url, json({ enabled: false }, 'PATCH')));
    expect(paused.nextRunAt).toBeNull();
    expect(await registry()).toHaveLength(0);

    const res = await subs().request(`${url}/send-now`, json({}));
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ delivered: [{ channel: 'email', ok: true, recipients: 1, error: null }] });
    const mail = state.sent[0] as { subject: string; text: string };
    expect(mail.subject).toBe('Monday signups: Signups');
    expect(mail.text).toContain('Signups: 42 · +100%');
    expect((await db.select().from(panelSubscriptions))[0]!.lastRunAt).not.toBeNull();

    expect((await subs(READ_WRITE, 'user_bram').request(`${url}/send-now`, json({}))).status).toBe(403);
    expect((await subs().request(url, { method: 'DELETE' })).status).toBe(204);
    expect((await subs().request(url)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

describe('exports', () => {
  const PATH = '/api/panel/exports';
  const exps = (grants = MANAGE) => mount(PATH, exportsRoutes, grants);
  const destination = { provider: 's3', region: 'eu-west-1', bucket: 'acme-raw', prefix: '/weldpanel/', accessKeyId: 'AKIAEXAMPLE' };
  const body = (extra: Record<string, unknown> = {}) => ({ projectId: 'pnp_a', name: 'Raw', destination, secretAccessKey: 's3cr3t-value', tables: ['events', 'people', 'events'], ...extra });

  it('needs panel_projects:manage', async () => {
    expect((await exps(READ_WRITE).request(PATH, json(body()))).status).toBe(403);
    expect((await exps(READ_WRITE).request(`${PATH}?projectId=pnp_a`)).status).toBe(403);
  });

  it('creates with a write-only secret, due at once, and never shows the key', async () => {
    const res = await exps().request(PATH, json(body()));
    expect(res.status).toBe(201);
    const text = await res.clone().text();
    expect(text).not.toContain('s3cr3t-value');
    const exp = await data<PanelExportDto>(res);
    expect(exp).toMatchObject({ tables: ['events', 'people'], frequency: 'daily', status: 'active', exportedUntil: null, destination: { prefix: 'weldpanel', endpoint: null, pathStyle: false } });
    expect((await db.select().from(panelExports))[0]!.secretCiphertext).not.toContain('s3cr3t');
    const [row] = await registry();
    expect(row!.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(JSON.stringify(events)).not.toContain('s3cr3t');
    expect(events[0]!.data).toEqual({ id: minted(exp.id), projectId: 'pnp_a', name: 'Raw', provider: 's3', bucket: 'acme-raw', status: 'active' });
  });

  it('refuses an endpoint on a private network, and a non-S3 provider without one', async () => {
    expect((await exps().request(PATH, json(body({ destination: { ...destination, provider: 'minio', endpoint: 'https://127.0.0.1:9000' } })))).status).toBe(400);
    expect((await exps().request(PATH, json(body({ destination: { ...destination, provider: 'r2' } })))).status).toBe(400);
    expect((await exps().request(PATH, json(body({ destination: { ...destination, provider: 'minio', endpoint: 'http://minio.example.com' } })))).status).toBe(400);
  });

  it('pauses, resumes, updates the key, lists runs and deletes, keeping the registry in step', async () => {
    const exp = await data<PanelExportDto>(await exps().request(PATH, json(body())));
    const url = `${PATH}/${exp.id}`;
    expect((await data<PanelExportDto>(await exps().request(`${url}/pause`, json({})))).status).toBe('paused');
    expect(await registry()).toHaveLength(0);
    expect((await data<PanelExportDto>(await exps().request(`${url}/resume`, json({})))).status).toBe('active');
    expect(await data<PanelExportDto>(await exps().request(url))).toMatchObject({ id: exp.id, status: 'active' });
    expect(await registry()).toHaveLength(1);

    const before = (await db.select().from(panelExports))[0]!.secretCiphertext;
    const updated = await exps().request(url, json({ secretAccessKey: 'rotated-key', frequency: 'hourly' }, 'PATCH'));
    expect(updated.status).toBe(200);
    expect(await updated.text()).not.toContain('rotated-key');
    expect((await db.select().from(panelExports))[0]!.secretCiphertext).not.toBe(before);

    expect(((await (await exps().request(`${url}/runs`)).json()) as { data: unknown[] }).data).toEqual([]);
    expect((await exps().request(url, { method: 'DELETE' })).status).toBe(204);
    expect(await registry()).toHaveLength(0);
    expect(events.map((e) => e.action)).toEqual(['created', 'updated', 'updated', 'updated', 'deleted']);
  });

  it('tests a destination: writes the test file and deletes it', async () => {
    const calls: { method: string; url: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ method: String(init.method), url });
        return init.method === 'PUT' ? new Response('', { status: 200 }) : new Response(null, { status: 204 });
      }),
    );
    const res = await exps().request(`${PATH}/test`, json({ projectId: 'pnp_a', destination, secretAccessKey: 'k' }));
    expect(await data(res)).toEqual({ ok: true, wrote: true, deleted: true, error: null });
    // Once per backend that answered (both in conformance mode, TypeScript first).
    const testCalls = [
      { method: 'PUT', url: 'https://acme-raw.s3.eu-west-1.amazonaws.com/weldpanel/_weldpanel_test.txt' },
      { method: 'DELETE', url: 'https://acme-raw.s3.eu-west-1.amazonaws.com/weldpanel/_weldpanel_test.txt' },
    ];
    expect(calls).toEqual(Array.from({ length: RUNS }, () => testCalls).flat());

    vi.stubGlobal('fetch', vi.fn(async () => new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 })));
    const saved = await data<PanelExportDto>(await exps().request(PATH, json(body())));
    expect(await data(await exps().request(`${PATH}/test`, json({ exportId: saved.id })))).toEqual({ ok: false, wrote: false, deleted: false, error: 'NoSuchBucket' });
  });
});

// ---------------------------------------------------------------------------
// Custom domains
// ---------------------------------------------------------------------------

describe('custom domains', () => {
  const PATH = '/api/panel/projects/:id/domains';
  const url = (rest = '') => `/api/panel/projects/pnp_a/domains${rest}`;
  const SAAS = { PANEL_SAAS_ZONE_ID: 'zone_saas', PANEL_SAAS_CNAME_TARGET: 'collect.weldpanel.net', CLOUDFLARE_API_TOKEN: 'cf-token' };
  const domains = (envExtra: Record<string, unknown> = SAAS, grants = MANAGE, workspaceId = 'ws_alpha') => mount(PATH, domainsRoutes, grants, 'user_alice', envExtra, workspaceId);
  const ok = (result: unknown) => ({ success: true, errors: [], messages: [], result });

  // Cloudflare's API on the global fetch (the zones client builds its SDK
  // client per call on it, with no transport set), so in conformance mode the
  // Rust server's calls reach it too, through the harness's outbound bridge;
  // every other URL (the harness's own loopback calls) goes to the real fetch.
  const realFetch = globalThis.fetch;
  function cloudflare(hostname: { status: string; ssl: string }) {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!target.startsWith('https://api.cloudflare.com/')) return realFetch(input, init);
      const req = init;
      calls.push({ method: String(req?.method), url: target, body: req?.body ? JSON.parse(String(req.body)) : undefined });
      if (req?.method === 'DELETE') return new Response(JSON.stringify(ok({ id: 'cfh_1' })), { headers: { 'Content-Type': 'application/json' } });
      return new Response(
        JSON.stringify(
          ok({
            id: 'cfh_1',
            hostname: 'stats.example.com',
            status: hostname.status,
            ssl: { status: hostname.ssl, validation_records: [] },
            ownership_verification: { type: 'txt', name: '_cf-custom-hostname.stats.example.com', value: 'abc-123' },
          }),
        ),
        { headers: { 'Content-Type': 'application/json' } },
      );
    };
    __setZonesFetchForTests(undefined);
    vi.stubGlobal('fetch', stub);
    return calls;
  }

  it('answers 503 until Cloudflare for SaaS is configured', async () => {
    const res = await domains({}).request(url());
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FEATURE_UNAVAILABLE');
    expect((await domains({}).request(url(), json({ hostname: 'stats.example.com' }))).status).toBe(503);
  });

  it('registers a host name, shows the records, activates on refresh with its snippet, and removes it', async () => {
    const calls = cloudflare({ status: 'pending', ssl: 'pending_validation' });
    const res = await domains().request(url(), json({ hostname: ' Stats.Example.com ' }));
    expect(res.status).toBe(201);
    const created = await data<PanelDomainDto>(res);
    expect(created).toMatchObject({ hostname: 'stats.example.com', status: 'pending', scriptUrl: null, snippet: null });
    expect(created.records).toEqual([
      { type: 'CNAME', name: 'stats.example.com', value: 'collect.weldpanel.net', purpose: 'routing' },
      { type: 'TXT', name: '_cf-custom-hostname.stats.example.com', value: 'abc-123', purpose: 'ownership' },
    ]);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { hostname: 'stats.example.com', ssl: { method: 'http', type: 'dv' } } });
    expect(calls[0]!.url).toContain('/zones/zone_saas/custom_hostnames');
    expect(events[0]).toMatchObject({ entityType: 'panel_custom_domain', action: 'created', data: { hostname: 'stats.example.com', status: 'pending' } });

    // The same host name again (any project, any workspace) is taken.
    expect((await domains().request(url(), json({ hostname: 'stats.example.com' }))).status).toBe(409);

    cloudflare({ status: 'active', ssl: 'active' });
    const refreshed = await data<PanelDomainDto>(await domains().request(url(`/${created.id}/refresh`), json({})));
    expect(refreshed).toMatchObject({ status: 'active', sslStatus: 'active', scriptUrl: 'https://stats.example.com/s.js' });
    expect(refreshed.snippet).toContain('src="https://stats.example.com/s.js" data-project="wpk_a"');

    // Another workspace cannot see or touch it.
    expect(((await (await domains(SAAS, MANAGE, 'ws_beta').request(url())).json()) as { data: unknown[] }).data).toEqual([]);
    expect((await domains(SAAS, MANAGE, 'ws_beta').request(url(`/${created.id}`), { method: 'DELETE' })).status).toBe(404);

    const removeCalls = cloudflare({ status: 'active', ssl: 'active' });
    expect((await domains().request(url(`/${created.id}`), { method: 'DELETE' })).status).toBe(204);
    expect(removeCalls[0]).toMatchObject({ method: 'DELETE' });
    expect(await master.select().from(panelCustomDomains).where(eq(panelCustomDomains.id, created.id))).toEqual([]);
    expect(events.map((e) => e.action)).toEqual(['created', 'updated', 'deleted']);
  });

  it('refuses WeldSuite’s own hosts, other projects and members without manage', async () => {
    cloudflare({ status: 'pending', ssl: 'pending_validation' });
    expect((await domains().request(url(), json({ hostname: 'pnl.weldsuite.org' }))).status).toBe(400);
    expect((await domains().request('/api/panel/projects/pnp_zzz/domains', json({ hostname: 'a.example.com' }))).status).toBe(404);
    expect((await domains(SAAS, ['panel_projects:read']).request(url())).status).toBe(403);
  });
});
