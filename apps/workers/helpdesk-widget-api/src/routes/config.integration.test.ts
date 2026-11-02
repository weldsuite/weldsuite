/**
 * GET /api/config on pglite: what the widget shows before a visitor types
 * anything. Branding (defaults and set values), `showBranding` from the
 * workspace's plan, the team's faces, office hours, the away text, the
 * expected reply time and the realtime origin.
 *
 * Conformance-ready: the master database (registry, workspaces, plans) and the
 * tenant database (widget settings, members) are shared with the Rust backend
 * by the harness, and the office hours are either off, open every day all day,
 * or without a valid window, so the answer never depends on the clock.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import * as tenantSchema from '@weldsuite/db/schema';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import {
  REALTIME_URL,
  WIDGET,
  addWidget,
  at,
  get,
  member,
  seedWorkspaces,
  widgetEnv } from '../test/widget-fixtures';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
  getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
  getWorkspaceForOrg: async () => ({ id: 'ws_acme' }),
}));

import worker from '../index';

let tenantDb: Database;
let masterDb: Database;

function app(env: Record<string, unknown> = {}) {
  return createTestApp('/', worker as never, {
    context: { tenantDb, masterDb, orgId: null, clerkOrgId: null },
    env: widgetEnv(env),
    rustBasePath: '/public/helpdesk-widget',
  });
}

interface Config {
  success: true;
  data: Record<string, unknown>;
}

async function config(widgetId: string = WIDGET, env: Record<string, unknown> = {}): Promise<Config['data']> {
  const res = await app(env).request('/api/config', get(widgetId));
  expect(res.status, widgetId).toBe(200);
  const body = (await res.json()) as Config;
  expect(body.success).toBe(true);
  return body.data;
}

const ALL_DAY = { start: '00:00', end: '24:00' };
const EVERY_DAY = { mon: ALL_DAY, tue: ALL_DAY, wed: ALL_DAY, thu: ALL_DAY, fri: ALL_DAY, sat: ALL_DAY, sun: ALL_DAY };

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db;
  holder.master = masterDb;
  holder.tenant = tenantDb;
  await seedWorkspaces(masterDb);

  await addWidget(masterDb, tenantDb, WIDGET);
  await addWidget(masterDb, tenantDb, 'wdg_full', {
    settings: {
      widgetName: 'Acme Support',
      greeting: 'Welcome to Acme!',
      branding: { primaryColor: '#ff5500', backgroundColor: '#101010', position: 'left' },
      awayMessage: '  Back on Monday.  ',
      expectedReplyTime: 'few_hours',
    },
  });
  await addWidget(masterDb, tenantDb, 'wdg_partial', { settings: { branding: { position: 'left' } } });
  await addWidget(masterDb, tenantDb, 'wdg_blank', {
    settings: { greeting: '', branding: {}, awayMessage: '   ', widgetName: '' },
  });
  await addWidget(masterDb, tenantDb, 'wdg_basic', { workspaceId: 'ws_basic' });
  await addWidget(masterDb, tenantDb, 'wdg_white', { workspaceId: 'ws_white' });

  await addWidget(masterDb, tenantDb, 'wdg_hours_off', {
    settings: { officeHours: { enabled: false, days: { mon: { start: '09:00', end: '17:00' } } }, timezone: 'Europe/Amsterdam' },
  });
  await addWidget(masterDb, tenantDb, 'wdg_hours_open', {
    settings: { officeHours: { enabled: true, days: EVERY_DAY }, timezone: 'Pacific/Auckland' },
  });
  // A zone the runtime does not know: the schedule is read in UTC, and it covers every hour.
  await addWidget(masterDb, tenantDb, 'wdg_hours_zone', {
    settings: { officeHours: { enabled: true, days: EVERY_DAY }, timezone: 'Mars/Olympus' },
  });
  await addWidget(masterDb, tenantDb, 'wdg_hours_none', {
    settings: { officeHours: { enabled: true, days: {} }, timezone: 'Europe/Amsterdam' },
  });
  // Every window is unusable: ends before it starts, malformed, empty, past 24:00, or closed.
  await addWidget(masterDb, tenantDb, 'wdg_hours_invalid', {
    settings: {
      officeHours: {
        enabled: true,
        days: {
          mon: { start: '18:00', end: '09:00' },
          tue: { start: '9am', end: '5pm' },
          wed: null,
          thu: { start: '10:30', end: '10:30' },
          fri: { start: '09:00', end: '25:00' },
          sat: { start: '12:60', end: '13:00' },
        },
      },
    },
  });
}, 120_000);

describe('GET /api/config', () => {
  it('answers the defaults of a widget with nothing set', async () => {
    expect(await config()).toEqual({
      widgetId: WIDGET,
      name: null,
      enabled: true,
      greeting: 'Hi — how can we help?',
      branding: { primaryColor: '#2563eb', backgroundColor: '#ffffff', position: 'right' },
      showBranding: true,
      realtimeUrl: REALTIME_URL,
      team: [],
      availability: { isOpen: true, nextOpenAt: null },
      awayMessage: null,
      expectedReplyTime: null,
    });
  });

  it('answers what the widget has set', async () => {
    expect(await config('wdg_full')).toEqual({
      widgetId: 'wdg_full',
      name: 'Acme Support',
      enabled: true,
      greeting: 'Welcome to Acme!',
      branding: { primaryColor: '#ff5500', backgroundColor: '#101010', position: 'left' },
      showBranding: true,
      realtimeUrl: REALTIME_URL,
      team: [],
      availability: { isOpen: true, nextOpenAt: null },
      awayMessage: 'Back on Monday.',
      expectedReplyTime: 'few_hours',
    });
  });

  it('fills the branding keys the widget did not set', async () => {
    expect((await config('wdg_partial')).branding).toEqual({
      primaryColor: '#2563eb',
      backgroundColor: '#ffffff',
      position: 'left',
    });
  });

  it('keeps an empty greeting and name, defaults an empty branding, and drops a blank away message', async () => {
    const data = await config('wdg_blank');
    expect(data).toMatchObject({
      name: '',
      greeting: '',
      branding: { primaryColor: '#2563eb', backgroundColor: '#ffffff', position: 'right' },
      awayMessage: null,
    });
  });

  it('answers each expected reply time as stored', async () => {
    const settings = tenantSchema.deskWidgetSettings;
    for (const time of ['few_minutes', 'hour', 'few_hours', 'day'] as const) {
      await tenantDb.update(settings).set({ expectedReplyTime: time }).where(eq(settings.widgetId, WIDGET));
      expect((await config()).expectedReplyTime, time).toBe(time);
    }
    await tenantDb.update(settings).set({ expectedReplyTime: null }).where(eq(settings.widgetId, WIDGET));
    expect((await config()).expectedReplyTime).toBeNull();
  });

  it('advertises the realtime origin only when one is configured', async () => {
    expect((await config(WIDGET, { REALTIME_PUBLIC_URL: 'wss://other.realtime.test' })).realtimeUrl).toBe(
      'wss://other.realtime.test',
    );
    expect((await config(WIDGET, { REALTIME_PUBLIC_URL: undefined })).realtimeUrl).toBeNull();
  });
});

describe('GET /api/config: showBranding', () => {
  it('is on without a plan and with a plan that keeps the branding', async () => {
    expect((await config(WIDGET)).showBranding).toBe(true);
    expect((await config('wdg_basic')).showBranding).toBe(true);
  });

  it('is off when the plan removes the branding', async () => {
    expect((await config('wdg_white')).showBranding).toBe(false);
  });
});

describe('GET /api/config: office hours', () => {
  it('counts the team as in when office hours are off, whatever the schedule says', async () => {
    expect((await config('wdg_hours_off')).availability).toEqual({ isOpen: true, nextOpenAt: null });
  });

  it('is open when a window covers every day, in any zone', async () => {
    for (const widgetId of ['wdg_hours_open', 'wdg_hours_zone']) {
      expect((await config(widgetId)).availability, widgetId).toEqual({ isOpen: true, nextOpenAt: null });
    }
  });

  it('is closed, with no next opening, when there is no valid window', async () => {
    for (const widgetId of ['wdg_hours_none', 'wdg_hours_invalid']) {
      expect((await config(widgetId)).availability, widgetId).toEqual({ isOpen: false, nextOpenAt: null });
    }
  });
});

describe('GET /api/config: team', () => {
  const members = tenantSchema.workspaceMembers;
  const team = async () => (await config()).team;
  const face = (n: number) => `https://img.widget.test/t${n}.png`;

  /** Rows are inserted in the order the team is expected in (and by id, name and creation time too). */
  it('is empty while no teammate has a picture', async () => {
    await tenantDb.insert(members).values([
      member('user_t0a', { name: 'No Picture' }),
      member('user_t0b', { name: 'Also None', picture: null }),
    ]);
    expect(await team()).toEqual([]);
  });

  it('shows an active internal teammate by first name', async () => {
    await tenantDb
      .insert(members)
      .values(member('user_t1', { name: 'Ann Lee-Smith', picture: face(1), createdAt: at(1), updatedAt: at(1) }));
    expect(await team()).toEqual([{ name: 'Ann', avatar: face(1) }]);
  });

  it('leaves out pending, suspended, guest and employee members', async () => {
    await tenantDb.insert(members).values([
      member('user_x_pending', { name: 'Pending Pat', picture: face(90), status: 'PENDING', createdAt: at(2) }),
      member('user_x_suspended', { name: 'Suspended Sam', picture: face(91), status: 'SUSPENDED', createdAt: at(2) }),
      member('user_x_guest', { name: 'Guest Gail', picture: face(92), memberType: 'EXTERNAL_GUEST', createdAt: at(2) }),
      member('user_x_employee', { name: 'Employee Eli', picture: face(93), memberType: 'EMPLOYEE', createdAt: at(2) }),
    ]);
    expect(await team()).toEqual([{ name: 'Ann', avatar: face(1) }]);
  });

  it('reads status and member type without regard to case, and keeps the first name as written', async () => {
    await tenantDb.insert(members).values([
      member('user_t2', {
        name: 'bob   marley',
        picture: face(2),
        status: 'active',
        memberType: 'internal',
        createdAt: at(3),
        updatedAt: at(3),
      }),
      member('user_t3', { name: null, picture: face(3), createdAt: at(4), updatedAt: at(4) }),
    ]);
    expect(await team()).toEqual([
      { name: 'Ann', avatar: face(1) },
      { name: 'bob', avatar: face(2) },
      { name: 'Support', avatar: face(3) },
    ]);
  });

  it('shows at most three teammates', async () => {
    await tenantDb
      .insert(members)
      .values(member('user_t4', { name: 'Dan Four', picture: face(4), createdAt: at(5), updatedAt: at(5) }));
    expect(await team()).toEqual([
      { name: 'Ann', avatar: face(1) },
      { name: 'bob', avatar: face(2) },
      { name: 'Support', avatar: face(3) },
    ]);
  });

  it('calls a teammate with a blank name Support', async () => {
    await tenantDb.delete(members).where(inArray(members.userId, ['user_t1', 'user_t2']));
    await tenantDb
      .insert(members)
      .values(member('user_t5', { name: '   ', picture: face(5), createdAt: at(6), updatedAt: at(6) }));
    expect(await team()).toEqual([
      { name: 'Support', avatar: face(3) },
      { name: 'Dan', avatar: face(4) },
      { name: 'Support', avatar: face(5) },
    ]);
  });
});
