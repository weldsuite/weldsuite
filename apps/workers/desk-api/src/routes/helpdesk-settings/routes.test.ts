/**
 * Every /api/helpdesk-settings route on pglite, refusals included: the
 * singleton settings (GET, and each section PUT on both the insert and the
 * update branch, with their defaults and merges), the primary widget (GET
 * creating it or giving it a widget id, PUT, PATCH /enabled) and the
 * multi-widget routes, which also write the master `widget_registry`.
 *
 * Nothing is mocked but `getMasterDb`, which hands out the test's master
 * database through `conformanceMasterDb`, so the conformance suite runs these
 * against the Rust backend too.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { CONFORMANCE_WRITE_HEADER } from '@weldsuite/worker-kit/testing/conformance';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  const { conformanceMasterDb } = await import('@weldsuite/worker-kit/testing/conformance');
  return { ...actual, getMasterDb: () => conformanceMasterDb(state.master) };
});

import { helpdeskSettingsRoutes } from './index';

const BASE = '/api/helpdesk-settings';
const WORKSPACE = 'ws_test_default';
const { widgetRegistry, workspaces } = masterSchema;
const { helpdeskSettings, helpdeskWidgetSettings } = schema;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
let db: Database;

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second));

function app(...keys: string[]) {
  return createTestApp(BASE, helpdeskSettingsRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db, masterDb: master },
  });
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** GET /widget creates the widget (or gives it a widget id): compared as a write in conformance mode. */
const WRITING_GET: RequestInit = { headers: { [CONFORMANCE_WRITE_HEADER]: '1' } };

const READ = () => app('settings:read');
const UPDATE = () => app('settings:update', 'settings:read');

async function settingsRow() {
  const rows = await db.select().from(helpdeskSettings);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function registryOf(widgetId: string) {
  const [row] = await master.select().from(widgetRegistry).where(eq(widgetRegistry.widgetId, widgetId));
  return row as typeof widgetRegistry.$inferSelect | undefined;
}

async function seedWidget(id: string, n: number, overrides: Partial<typeof helpdeskWidgetSettings.$inferInsert> = {}) {
  await db.insert(helpdeskWidgetSettings).values({
    id,
    widgetId: `widget_${id}`,
    widgetName: `Widget ${n}`,
    createdAt: at(n),
    updatedAt: at(n),
    ...overrides,
  });
}

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  state.master = master;
  db = (await createPgliteDb()).db;
  await master.insert(workspaces).values({ id: WORKSPACE, clerkOrgId: 'org_test_default', name: 'Desk', slug: 'desk-ws' });
}, 60_000);

describe('GET /api/helpdesk-settings', () => {
  it('needs settings:read', async () => {
    const res = await app('settings:update').request(BASE);
    expect(res.status).toBe(403);
  });

  it('answers nulls before anything was saved', async () => {
    const res = await READ().request(BASE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { settings: null, widgetSettings: null } });
  });
});

describe('PUT /api/helpdesk-settings/notifications', () => {
  it('needs settings:update', async () => {
    const res = await READ().request(`${BASE}/notifications`, send('PUT', { emailNotifications: true, pushNotifications: true, smsNotifications: true }));
    expect(res.status).toBe(403);
  });

  it('rejects a body without the three channel flags, or with a flag that is not a boolean', async () => {
    for (const body of [
      { emailNotifications: true, pushNotifications: true },
      { emailNotifications: 'yes', pushNotifications: true, smsNotifications: true },
      { emailNotifications: true, pushNotifications: true, smsNotifications: true, notifyOnSLABreach: 1 },
    ]) {
      const res = await UPDATE().request(`${BASE}/notifications`, send('PUT', body));
      expect(res.status).toBe(400);
    }
  });

  it('creates the settings row, defaulting every notifyOn* flag to true', async () => {
    const res = await UPDATE().request(
      `${BASE}/notifications`,
      send('PUT', { emailNotifications: true, pushNotifications: false, smsNotifications: false, notifyOnAssignment: false }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true } });
    const row = await settingsRow();
    expect(row.notifications).toEqual({
      emailNotifications: true,
      pushNotifications: false,
      smsNotifications: false,
      notifyOnNewTicket: true,
      notifyOnAssignment: false,
      notifyOnStatusChange: true,
      notifyOnCustomerReply: true,
      notifyOnSLABreach: true,
    });
  });

  it('replaces the whole section on the existing row, flags left out going back to true', async () => {
    const before = await settingsRow();
    const res = await UPDATE().request(
      `${BASE}/notifications`,
      send('PUT', { emailNotifications: false, pushNotifications: true, smsNotifications: true, notifyOnSLABreach: false }),
    );
    expect(res.status).toBe(200);
    const row = await settingsRow();
    expect(row.id).toBe(before.id);
    expect(row.notifications).toEqual({
      emailNotifications: false,
      pushNotifications: true,
      smsNotifications: true,
      notifyOnNewTicket: true,
      notifyOnAssignment: true,
      notifyOnStatusChange: true,
      notifyOnCustomerReply: true,
      notifyOnSLABreach: false,
    });
  });
});

describe('PUT /api/helpdesk-settings/automation', () => {
  it('needs settings:update', async () => {
    const res = await READ().request(`${BASE}/automation`, send('PUT', { enabled: true }));
    expect(res.status).toBe(403);
  });

  it('rejects an unknown SLA action, an unknown priority and a missing enabled', async () => {
    for (const body of [{ enabled: true, slaBreachAction: 'shout' }, { enabled: true, priorityAlertThreshold: ['low'] }, {}]) {
      const res = await UPDATE().request(`${BASE}/automation`, send('PUT', body));
      expect(res.status).toBe(400);
    }
  });

  it('creates the row with the body as the section when there is none', async () => {
    await db.delete(helpdeskSettings);
    const res = await UPDATE().request(`${BASE}/automation`, send('PUT', { enabled: true, slaBreachAction: 'notify_only' }));
    expect(res.status).toBe(200);
    expect((await settingsRow()).automation).toEqual({ enabled: true, slaBreachAction: 'notify_only' });
  });

  it('merges into the stored section, keeping keys the form does not send', async () => {
    await db.delete(helpdeskSettings);
    await db.insert(helpdeskSettings).values({
      id: 'hds_seed',
      automation: {
        enabled: false,
        slaBreachAction: 'none',
        deskAssignment: { mode: 'round_robin', memberIds: ['user_a'], awayMemberIds: [], maxOpenPerMember: null },
      },
      createdAt: at(1),
      updatedAt: at(1),
    });
    const res = await UPDATE().request(`${BASE}/automation`, send('PUT', { enabled: true, priorityAlertThreshold: ['urgent', 'high'] }));
    expect(res.status).toBe(200);
    expect((await settingsRow()).automation).toEqual({
      enabled: true,
      slaBreachAction: 'none',
      priorityAlertThreshold: ['urgent', 'high'],
      deskAssignment: { mode: 'round_robin', memberIds: ['user_a'], awayMemberIds: [], maxOpenPerMember: null },
    });
  });
});

describe('PUT /api/helpdesk-settings/tickets', () => {
  it('needs settings:update', async () => {
    const res = await READ().request(`${BASE}/tickets`, send('PUT', { autoAssignment: true }));
    expect(res.status).toBe(403);
  });

  it('rejects an unknown strategy and a number sent as text', async () => {
    for (const body of [{ assignmentStrategy: 'random' }, { autoCloseAfterDays: '7' }, { autoAssignment: 'on' }]) {
      const res = await UPDATE().request(`${BASE}/tickets`, send('PUT', body));
      expect(res.status).toBe(400);
    }
  });

  it('sets the section on a row that has none yet (merging into null)', async () => {
    const res = await UPDATE().request(`${BASE}/tickets`, send('PUT', { autoAssignment: true, defaultPriority: 'high' }));
    expect(res.status).toBe(200);
    expect((await settingsRow()).tickets).toEqual({ autoAssignment: true, defaultPriority: 'high' });
  });

  it('merges a later save into it', async () => {
    const res = await UPDATE().request(
      `${BASE}/tickets`,
      send('PUT', { defaultPriority: 'low', autoCloseAfterDays: 14, assignmentStrategy: 'least_busy' }),
    );
    expect(res.status).toBe(200);
    expect((await settingsRow()).tickets).toEqual({
      autoAssignment: true,
      defaultPriority: 'low',
      autoCloseAfterDays: 14,
      assignmentStrategy: 'least_busy',
    });
  });

  it('creates the row when there is none', async () => {
    await db.delete(helpdeskSettings);
    const res = await UPDATE().request(`${BASE}/tickets`, send('PUT', { requireApproval: false }));
    expect(res.status).toBe(200);
    expect((await settingsRow()).tickets).toEqual({ requireApproval: false });
  });
});

describe('PUT /api/helpdesk-settings/satisfaction', () => {
  it('needs settings:update', async () => {
    const res = await READ().request(`${BASE}/satisfaction`, send('PUT', { enableSurveys: true }));
    expect(res.status).toBe(403);
  });

  it('rejects a delay sent as text and a template that is not a string', async () => {
    for (const body of [{ delayMinutes: '5' }, { surveyTemplate: 3 }]) {
      const res = await UPDATE().request(`${BASE}/satisfaction`, send('PUT', body));
      expect(res.status).toBe(400);
    }
  });

  it('creates the row when there is none, then merges into it', async () => {
    await db.delete(helpdeskSettings);
    const first = await UPDATE().request(`${BASE}/satisfaction`, send('PUT', { enableSurveys: true, delayMinutes: 30 }));
    expect(first.status).toBe(200);
    expect((await settingsRow()).satisfaction).toEqual({ enableSurveys: true, delayMinutes: 30 });

    const second = await UPDATE().request(`${BASE}/satisfaction`, send('PUT', { delayMinutes: 60, thankYouMessage: 'Thanks!' }));
    expect(second.status).toBe(200);
    expect((await settingsRow()).satisfaction).toEqual({ enableSurveys: true, delayMinutes: 60, thankYouMessage: 'Thanks!' });
  });
});

describe('GET /api/helpdesk-settings/widget', () => {
  it('needs settings:read', async () => {
    const res = await app('settings:update').request(`${BASE}/widget`);
    expect(res.status).toBe(403);
  });

  it('creates the default widget on first use and registers it in the master database', async () => {
    const res = await READ().request(`${BASE}/widget`, WRITING_GET);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> & { id: string; widgetId: string } };
    expect(data).toMatchObject({
      widgetName: 'Default Widget',
      pageHome: true,
      pageChat: true,
      pageHelp: true,
      pageParcelTracking: false,
      pageChangelog: true,
      pageNews: true,
      pageFeedback: true,
      pageAnnouncements: true,
      pageEventSignUp: false,
      autoOpen: false,
      showWelcomeMessage: true,
      showBranding: true,
      emailCollection: 'none',
      colorPrimary: null,
      deletedAt: null,
    });
    expect(data.widgetId).toMatch(/^widget_/);
    expect(await registryOf(data.widgetId)).toMatchObject({ workspaceId: WORKSPACE, widgetName: 'Default Widget', isActive: true });

    // A second call finds it instead of creating another.
    const again = await READ().request(`${BASE}/widget`);
    expect(((await again.json()) as { data: { id: string } }).data.id).toBe(data.id);
    expect(await db.select().from(helpdeskWidgetSettings)).toHaveLength(1);
  });

  it('gives a widget saved without a widget id one, answering the row as it was read', async () => {
    await db.delete(helpdeskWidgetSettings);
    await seedWidget('wgt_legacy', 2, { widgetId: null, widgetName: 'Legacy', colorPrimary: '#ff0000' });
    const res = await READ().request(`${BASE}/widget`, WRITING_GET);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string; widgetId: string; updatedAt: string; colorPrimary: string } };
    expect(data.id).toBe('wgt_legacy');
    expect(data.widgetId).toMatch(/^widget_/);
    expect(data.colorPrimary).toBe('#ff0000');
    // The answer is the row as read, with only the new widget id laid over it.
    expect(data.updatedAt).toBe(at(2).toISOString());
    const [row] = await db.select().from(helpdeskWidgetSettings).where(eq(helpdeskWidgetSettings.id, 'wgt_legacy'));
    expect(row?.widgetId).toBe(data.widgetId);
    expect(await registryOf(data.widgetId)).toMatchObject({ workspaceId: WORKSPACE, widgetName: 'Legacy' });
  });

  it("registers an unnamed legacy widget as 'Default Widget'", async () => {
    await db.delete(helpdeskWidgetSettings);
    await seedWidget('wgt_unnamed', 3, { widgetId: null, widgetName: null });
    const res = await READ().request(`${BASE}/widget`, WRITING_GET);
    const { data } = (await res.json()) as { data: { widgetId: string; widgetName: string | null } };
    expect(data.widgetName).toBeNull();
    expect(await registryOf(data.widgetId)).toMatchObject({ widgetName: 'Default Widget' });
  });
});

describe('PUT /api/helpdesk-settings/widget', () => {
  it('needs settings:update', async () => {
    const res = await READ().request(`${BASE}/widget`, send('PUT', { widgetName: 'X' }));
    expect(res.status).toBe(403);
  });

  it('rejects an unknown email collection mode and a non-string name', async () => {
    for (const body of [{ emailCollection: 'sometimes' }, { widgetName: 5 }, { autoOpen: 'yes' }]) {
      const res = await UPDATE().request(`${BASE}/widget`, send('PUT', body));
      expect(res.status).toBe(400);
    }
  });

  it('updates the first live widget with the fields sent', async () => {
    const res = await UPDATE().request(`${BASE}/widget`, send('PUT', { widgetName: 'Support', colorPrimary: '#00ff00', autoOpen: true }));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string; widgetId: string; isNew: boolean } };
    expect(data).toMatchObject({ id: 'wgt_unnamed', isNew: false });
    const [row] = await db.select().from(helpdeskWidgetSettings).where(eq(helpdeskWidgetSettings.id, 'wgt_unnamed'));
    expect(row).toMatchObject({ widgetName: 'Support', colorPrimary: '#00ff00', autoOpen: true, pageChat: true });
  });

  it('answers a null widget id for a live widget that has none', async () => {
    await db.delete(helpdeskWidgetSettings);
    await seedWidget('wgt_noid', 4, { widgetId: null });
    const res = await UPDATE().request(`${BASE}/widget`, send('PUT', { welcomeMessage: 'Hello' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'wgt_noid', widgetId: null, isNew: false } });
  });

  it('creates and registers the widget when there is none, with the body over the defaults', async () => {
    await db.delete(helpdeskWidgetSettings);
    const res = await UPDATE().request(
      `${BASE}/widget`,
      send('PUT', { pageNews: false, emailCollection: 'always', showBranding: false, typographyText: '#111' }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; widgetId: string; isNew: boolean } };
    expect(data.isNew).toBe(true);
    const [row] = await db.select().from(helpdeskWidgetSettings).where(eq(helpdeskWidgetSettings.id, data.id));
    expect(row).toMatchObject({
      widgetId: data.widgetId,
      widgetName: 'Default Widget',
      pageNews: false,
      pageParcelTracking: false,
      emailCollection: 'always',
      showBranding: false,
      typographyText: '#111',
      autoOpen: false,
    });
    expect(await registryOf(data.widgetId)).toMatchObject({ workspaceId: WORKSPACE, widgetName: 'Default Widget', isActive: true });
  });
});

describe('PATCH /api/helpdesk-settings/widget/enabled', () => {
  it('needs settings:update', async () => {
    const res = await READ().request(`${BASE}/widget/enabled`, send('PATCH', { enabled: false }));
    expect(res.status).toBe(403);
  });

  it('turns the chat page of the first live widget off and on', async () => {
    const off = await UPDATE().request(`${BASE}/widget/enabled`, send('PATCH', { enabled: false }));
    expect(off.status).toBe(200);
    const { data } = (await off.json()) as { data: { id: string; widgetId: string; isNew: boolean } };
    expect(data.isNew).toBe(false);
    const [row] = await db.select().from(helpdeskWidgetSettings).where(eq(helpdeskWidgetSettings.id, data.id));
    expect(row?.pageChat).toBe(false);

    await UPDATE().request(`${BASE}/widget/enabled`, send('PATCH', { enabled: true }));
    const [back] = await db.select().from(helpdeskWidgetSettings).where(eq(helpdeskWidgetSettings.id, data.id));
    expect(back?.pageChat).toBe(true);
  });

  it('reads a body that is not JSON as enabled: false', async () => {
    const res = await UPDATE().request(`${BASE}/widget/enabled`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(helpdeskWidgetSettings);
    expect(row?.pageChat).toBe(false);
  });

  it('leaves the chat page as it is when the body has no enabled', async () => {
    const res = await UPDATE().request(`${BASE}/widget/enabled`, send('PATCH', {}));
    expect(res.status).toBe(200);
    const [row] = await db.select().from(helpdeskWidgetSettings);
    expect(row?.pageChat).toBe(false);
  });

  it('creates a widget (not registered) when there is none', async () => {
    await db.delete(helpdeskWidgetSettings);
    const res = await UPDATE().request(`${BASE}/widget/enabled`, send('PATCH', { enabled: false }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; widgetId: string; isNew: boolean } };
    expect(data.isNew).toBe(true);
    const [row] = await db.select().from(helpdeskWidgetSettings).where(eq(helpdeskWidgetSettings.id, data.id));
    expect(row).toMatchObject({ widgetName: 'Default Widget', pageChat: false, pageHome: true, pageHelp: true, pageNews: true });
    expect(await registryOf(data.widgetId)).toBeUndefined();
  });
});

describe('GET /api/helpdesk-settings with both saved', () => {
  it('answers the settings row and the first live widget', async () => {
    const res = await READ().request(BASE);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { settings: { satisfaction: unknown; deletedAt: null }; widgetSettings: { widgetName: string; pageChat: boolean } };
    };
    expect(data.settings).toMatchObject({ satisfaction: { enableSurveys: true, delayMinutes: 60 }, deletedAt: null });
    expect(data.widgetSettings).toMatchObject({ widgetName: 'Default Widget', pageChat: false });
  });
});

describe('/api/helpdesk-settings/widgets', () => {
  beforeAll(async () => {
    await db.delete(helpdeskWidgetSettings);
    await seedWidget('wgt_one', 10, { widgetId: 'widget_one', colorHeader: '#123456' });
    await seedWidget('wgt_gone', 11, { widgetId: 'widget_gone', deletedAt: at(12) });
    await master.insert(widgetRegistry).values({
      id: 'wr_one',
      widgetId: 'widget_one',
      workspaceId: WORKSPACE,
      widgetName: 'Widget 10',
      isActive: true,
      createdAt: at(10),
      updatedAt: at(10),
    });
  });

  it('needs settings:read to list and read one', async () => {
    expect((await app('settings:update').request(`${BASE}/widgets`)).status).toBe(403);
    expect((await app('settings:update').request(`${BASE}/widgets/widget_one`)).status).toBe(403);
  });

  it('lists the live widgets', async () => {
    const res = await READ().request(`${BASE}/widgets`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string; colorHeader: string | null }> };
    expect(data.map((w) => w.id)).toEqual(['wgt_one']);
    expect(data[0]?.colorHeader).toBe('#123456');
  });

  it('reads one widget by its widget id, and not a deleted or unknown one', async () => {
    const res = await READ().request(`${BASE}/widgets/widget_one`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { id: string; createdAt: string } }).data).toMatchObject({
      id: 'wgt_one',
      createdAt: at(10).toISOString(),
    });
    for (const id of ['widget_gone', 'widget_missing']) {
      const missing = await READ().request(`${BASE}/widgets/${id}`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Widget with ID '${id}' not found` } });
    }
  });

  it('needs settings:create to add one, and validates the body', async () => {
    expect((await app('settings:update').request(`${BASE}/widgets`, send('POST', {}))).status).toBe(403);
    const bad = await app('settings:create').request(`${BASE}/widgets`, send('POST', { emailCollection: 'never' }));
    expect(bad.status).toBe(400);
  });

  it("adds a widget named 'New Widget' by default and registers it", async () => {
    const res = await app('settings:create').request(`${BASE}/widgets`, send('POST', {}));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; widgetId: string; widgetName: string } };
    expect(data.widgetName).toBe('New Widget');
    const [row] = await db.select().from(helpdeskWidgetSettings).where(eq(helpdeskWidgetSettings.id, data.id));
    expect(row).toMatchObject({
      widgetId: data.widgetId,
      pageHome: true,
      pageParcelTracking: false,
      pageEventSignUp: false,
      showBranding: true,
      emailCollection: 'none',
      colorPrimary: null,
    });
    expect(await registryOf(data.widgetId)).toMatchObject({ workspaceId: WORKSPACE, widgetName: 'New Widget', isActive: true });
  });

  it('adds a named widget with its colours and pages', async () => {
    const res = await app('settings:create').request(
      `${BASE}/widgets`,
      send('POST', { widgetName: 'Sales', pageChat: false, colorPrimary: '#abcdef', welcomeMessage: 'Hi', emailCollection: 'outside_office_hours' }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; widgetId: string; widgetName: string } };
    expect(data.widgetName).toBe('Sales');
    const [row] = await db.select().from(helpdeskWidgetSettings).where(eq(helpdeskWidgetSettings.id, data.id));
    expect(row).toMatchObject({ widgetName: 'Sales', pageChat: false, colorPrimary: '#abcdef', welcomeMessage: 'Hi', emailCollection: 'outside_office_hours' });
  });

  it('updates a widget, renaming it in the registry too', async () => {
    expect((await READ().request(`${BASE}/widgets/widget_one`, send('PUT', { widgetName: 'X' }))).status).toBe(403);
    expect((await UPDATE().request(`${BASE}/widgets/widget_one`, send('PUT', { pageHome: 'no' }))).status).toBe(400);
    const missing = await UPDATE().request(`${BASE}/widgets/widget_gone`, send('PUT', { widgetName: 'X' }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Widget with ID 'widget_gone' not found" } });

    const res = await UPDATE().request(`${BASE}/widgets/widget_one`, send('PUT', { widgetName: 'Renamed', fontSize: '14px' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'wgt_one', widgetId: 'widget_one' } });
    const [row] = await db.select().from(helpdeskWidgetSettings).where(eq(helpdeskWidgetSettings.id, 'wgt_one'));
    expect(row).toMatchObject({ widgetName: 'Renamed', fontSize: '14px', colorHeader: '#123456' });
    expect(await registryOf('widget_one')).toMatchObject({ widgetName: 'Renamed' });
  });

  it('leaves the registry alone when the name is not sent', async () => {
    const res = await UPDATE().request(`${BASE}/widgets/widget_one`, send('PUT', { position: 'left' }));
    expect(res.status).toBe(200);
    expect(await registryOf('widget_one')).toMatchObject({ widgetName: 'Renamed', updatedAt: expect.any(Date) });
    const [row] = await db.select().from(helpdeskWidgetSettings).where(eq(helpdeskWidgetSettings.id, 'wgt_one'));
    expect(row?.position).toBe('left');
  });

  it('deletes a widget softly and deactivates it in the registry', async () => {
    expect((await UPDATE().request(`${BASE}/widgets/widget_one`, send('DELETE'))).status).toBe(403);
    const missing = await app('settings:delete').request(`${BASE}/widgets/widget_gone`, send('DELETE'));
    expect(missing.status).toBe(404);

    const res = await app('settings:delete').request(`${BASE}/widgets/widget_one`, send('DELETE'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true } });
    const [row] = await db.select().from(helpdeskWidgetSettings).where(eq(helpdeskWidgetSettings.id, 'wgt_one'));
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(await registryOf('widget_one')).toMatchObject({ isActive: false });
  });

  it('refuses to delete the last live widget', async () => {
    const live = await db.select().from(helpdeskWidgetSettings);
    const remaining = live.filter((w) => w.deletedAt === null);
    expect(remaining).toHaveLength(2);
    const first = await app('settings:delete').request(`${BASE}/widgets/${remaining[0]!.widgetId}`, send('DELETE'));
    expect(first.status).toBe(200);
    const last = await app('settings:delete').request(`${BASE}/widgets/${remaining[1]!.widgetId}`, send('DELETE'));
    expect(last.status).toBe(400);
    expect(await last.json()).toEqual({ success: false, error: 'Cannot delete the last widget.' });
  });
});
