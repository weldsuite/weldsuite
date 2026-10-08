/**
 * Daily tax reminders (pglite): sales tax returns 7 days, 1 day and overdue,
 * calendar deadlines, expiring certificates, nexus; sent once per key and
 * threshold; the in-app delivery; and the books sweep wiring.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { addAgency, createUsFixture, postSale, type UsFixture } from '../services/sales-tax-returns/test-fixtures';
import { createInAppNotifier } from './reminder-notifier';
import {
  kvMarkers,
  memoryMarkers,
  reminderRecipients,
  runTaxReminders,
  type ReminderNotice,
  type ReminderNotifier,
} from './tax-reminders';

let db: Database;
let f: UsFixture;

vi.mock('../services/accounting-currency', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/accounting-currency')>()),
  persistDailyEcbRates: async () => 0,
}));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getTenantDbForWorkspace: async () => db,
}));

function recorder(failFor: string[] = []) {
  const sent: Array<{ userId: string; notice: ReminderNotice }> = [];
  const notifier: ReminderNotifier = {
    async send(userId, notice) {
      if (failFor.includes(userId)) throw new Error('delivery failed');
      sent.push({ userId, notice });
    },
  };
  return { sent, notifier, titles: () => [...new Set(sent.map((s) => s.notice.title))].sort() };
}

const at = (iso: string) => new Date(iso);
const zero = (code: string, name: string) => [{ code, name, level: 'state' as const, rate: 0, tax: 0 }];

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  f = await createUsFixture(db);
  await addAgency(f, { id: 'agy_tx', stateCode: 'TX', name: 'Texas Comptroller', firstPeriodStart: '2026-07-01' });
  await addAgency(f, { id: 'agy_ny', stateCode: 'NY', name: 'New York DTF', firstPeriodStart: '2026-07-01' });
  // New York filed its third quarter already.
  await db.insert(schema.taxReturns).values({
    id: 'txr_ny', entityId: f.entityId, jurisdictionCode: 'US', agencyId: 'agy_ny', stateCode: 'NY',
    periodStart: '2026-07-01', periodEnd: '2026-09-30', dueDate: '2026-10-20', status: 'filed', filedAt: new Date('2026-10-05T12:00:00Z'),
  });
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_1', userId: 'user_owner', role: 'OWNER', status: 'ACTIVE' },
    { id: 'wm_2', userId: 'user_admin', role: 'ADMIN', status: 'ACTIVE' },
    { id: 'wm_3', userId: 'user_member', role: 'MEMBER', status: 'ACTIVE' },
    { id: 'wm_4', userId: 'user_gone', role: 'ADMIN', status: 'SUSPENDED' },
  ]);
}, 120_000);

describe('recipients', () => {
  it('are the active owners and admins', async () => {
    expect((await reminderRecipients(db)).sort()).toEqual(['user_admin', 'user_owner']);
  });
});

describe('sales tax return reminders', () => {
  const markers = memoryMarkers();

  it('7 days before the due date, with the calendar deadline due in 2 days', async () => {
    const { sent, notifier, titles } = recorder();
    const result = await runTaxReminders(db, { notifier, markers, now: at('2026-10-13T10:00:00Z') });
    expect(result).toMatchObject({ entities: 1, sent: 2, skipped: 0, failed: 0 });
    expect(titles()).toEqual([
      'Sales tax return due in 7 days: Texas Comptroller',
      'Schedule C (Form 1040), tax year 2025, extended is due in 2 days',
    ]);
    expect(new Set(sent.map((s) => s.userId))).toEqual(new Set(['user_owner', 'user_admin']));
    const sales = sent.find((s) => s.notice.entityType === 'sales_tax_agency')!.notice;
    expect(sales).toMatchObject({ severity: 'warning', entityId: 'agy_tx', data: { threshold: '7d', dueDate: '2026-10-20', periodEnd: '2026-09-30' } });
    expect(sales.body).toContain('The return has not been started.');
    expect([...markers.all.keys()].sort()).toEqual([
      'calendar:sch_c:2025:extended:3d',
      'sales_tax:agy_tx:2026-09-30:7d',
    ]);
  });

  it('does not send the same reminder twice, even when the run repeats', async () => {
    const { sent, notifier } = recorder();
    const result = await runTaxReminders(db, { notifier, markers, now: at('2026-10-13T22:00:00Z') });
    expect(result).toMatchObject({ sent: 0, skipped: 2 });
    expect(sent).toEqual([]);
    const next = await runTaxReminders(db, { notifier, markers, now: at('2026-10-14T10:00:00Z') });
    expect(next).toMatchObject({ sent: 0 });
  });

  it('1 day before the due date, once', async () => {
    const { notifier, titles } = recorder();
    const result = await runTaxReminders(db, { notifier, markers, now: at('2026-10-19T10:00:00Z') });
    expect(result.sent).toBe(1);
    expect(titles()).toEqual(['Sales tax return due tomorrow: Texas Comptroller']);
    expect(markers.all.has('sales_tax:agy_tx:2026-09-30:1d')).toBe(true);
  });

  it('overdue once the due date has passed, once', async () => {
    const { sent, notifier, titles } = recorder();
    await runTaxReminders(db, { notifier, markers, now: at('2026-10-21T10:00:00Z') });
    expect(titles()).toEqual(['Sales tax return overdue: Texas Comptroller']);
    expect(sent[0]!.notice.severity).toBe('error');
    expect(sent[0]!.notice.body).toContain('due 2026-10-20 (yesterday)');
    const again = recorder();
    await runTaxReminders(db, { notifier: again.notifier, markers, now: at('2026-10-22T10:00:00Z') });
    expect(again.sent).toEqual([]);
  });

  it('a missed day still sends the reminder the next day', async () => {
    // Fresh markers, first run on the due day itself (the 7-day window was missed).
    const { titles, notifier } = recorder();
    await runTaxReminders(db, { notifier, markers: memoryMarkers(), now: at('2026-10-20T10:00:00Z') });
    expect(titles()).toEqual(['Sales tax return due today: Texas Comptroller']);
  });
});

describe('certificate and nexus reminders', () => {
  it('sends one notice for the certificates that expire within 30 days, then only for new ones', async () => {
    await db.insert(schema.exemptionCertificates).values([
      { id: 'cert_1', entityId: f.entityId, partyId: 'pty_1', states: ['TX'], reason: 'resale', certificateNumber: 'C-1', form: 'state_form', expiresOn: '2026-11-02' },
      { id: 'cert_2', entityId: f.entityId, partyId: 'pty_2', states: ['TX'], reason: 'resale', certificateNumber: 'C-2', form: 'state_form', expiresOn: '2026-11-05' },
      { id: 'cert_far', entityId: f.entityId, partyId: 'pty_3', states: ['TX'], reason: 'resale', certificateNumber: 'C-FAR', form: 'state_form', expiresOn: '2027-03-01' },
    ]);
    const markers = memoryMarkers();
    const first = recorder();
    // 12 October 2026 is a Monday; nothing else is due, so only the certificates and (Monday) nexus run
    const result = await runTaxReminders(db, { notifier: first.notifier, markers, now: at('2026-10-12T10:00:00Z'), recipients: ['user_admin'] });
    const certificateNotices = first.sent.filter((s) => s.notice.entityType === 'exemption_certificate');
    expect(certificateNotices).toHaveLength(1);
    expect(certificateNotices[0]!.notice.title).toBe('2 exemption certificates expire within 30 days');
    expect(certificateNotices[0]!.notice.body).toContain('C-1');
    expect(certificateNotices[0]!.notice.body).toContain('C-2');
    expect(result.failed).toBe(0);
    expect([...markers.all.keys()].filter((k) => k.startsWith('certificate:')).sort()).toEqual([
      'certificate:cert_1:2026-11-02:30d',
      'certificate:cert_2:2026-11-05:30d',
    ]);

    await db.insert(schema.exemptionCertificates).values({
      id: 'cert_3', entityId: f.entityId, partyId: 'pty_4', states: ['TX'], reason: 'resale', certificateNumber: 'C-3', form: 'state_form', expiresOn: '2026-11-10',
    });
    const second = recorder();
    await runTaxReminders(db, { notifier: second.notifier, markers, now: at('2026-10-13T10:00:00Z'), recipients: ['user_admin'] });
    const fresh = second.sent.filter((s) => s.notice.entityType === 'exemption_certificate');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.notice.title).toBe('Exemption certificate expiring');
    expect(fresh[0]!.notice.body).toContain('C-3');
  });

  it('reports a state that newly crossed its nexus threshold, once, on Mondays or when forced', async () => {
    for (const [i, date] of ['2026-02-10', '2026-04-15', '2026-06-20', '2026-08-20', '2026-09-25'].entries()) {
      await postSale(f, {
        id: `inv_wa${i}`, number: `INV-WA${i}`, date, agencyId: null, stateCode: 'WA',
        lines: [{ id: `inv_wa${i}_l1`, gross: 20_000, taxable: 20_000, rows: zero('WA-STATE', 'Washington') }],
      });
    }
    const markers = memoryMarkers();
    const tuesday = recorder();
    await runTaxReminders(db, { notifier: tuesday.notifier, markers, now: at('2026-10-13T10:00:00Z'), recipients: ['user_admin'] });
    expect(tuesday.sent.some((s) => s.notice.entityType === 'nexus')).toBe(false);

    const monday = recorder();
    await runTaxReminders(db, { notifier: monday.notifier, markers, now: at('2026-10-12T10:00:00Z'), recipients: ['user_admin'] });
    const nexus = monday.sent.filter((s) => s.notice.entityType === 'nexus');
    expect(nexus).toHaveLength(1);
    expect(nexus[0]!.notice).toMatchObject({ title: 'Economic nexus reached in Washington', severity: 'error', entityId: 'WA' });
    expect(nexus[0]!.notice.body).toContain('Collect sales tax from 2026-09-26');
    expect(markers.all.has('nexus:WA:2026-09-25:exceeded')).toBe(true);

    const forced = recorder();
    await runTaxReminders(db, { notifier: forced.notifier, markers, now: at('2026-10-13T10:00:00Z'), recipients: ['user_admin'], forceNexus: true });
    expect(forced.sent.some((s) => s.notice.entityType === 'nexus')).toBe(false);
  });
});

describe('delivery failures', () => {
  it('marks a reminder once one member got it, and retries when nobody did', async () => {
    const partial = recorder(['user_admin']);
    const markers = memoryMarkers();
    const first = await runTaxReminders(db, { notifier: partial.notifier, markers, now: at('2026-10-13T10:00:00Z') });
    // the sales tax return, the calendar deadline and the certificates (earlier tests added two): one notice each
    expect(first.sent).toBe(3);
    expect(first.failed).toBe(3);
    expect(partial.sent.every((s) => s.userId === 'user_owner')).toBe(true);
    // two markers for the notices of one reminder each, one per certificate in the combined notice
    expect(markers.all.size).toBe(5);

    const nobody = recorder(['user_admin', 'user_owner']);
    const failing = memoryMarkers();
    const second = await runTaxReminders(db, { notifier: nobody.notifier, markers: failing, now: at('2026-10-13T10:00:00Z') });
    expect(second.sent).toBe(0);
    expect(failing.all.size).toBe(0);
    const retry = recorder();
    const third = await runTaxReminders(db, { notifier: retry.notifier, markers: failing, now: at('2026-10-14T10:00:00Z') });
    expect(third.sent).toBeGreaterThan(0);
  });

  it('does nothing for a tenant without a US entity or without admins', async () => {
    // (the test database is shared, so the entity is taken out of play for a moment instead)
    await db.update(schema.entities).set({ deletedAt: new Date() });
    const result = await runTaxReminders(db, { notifier: recorder().notifier, markers: memoryMarkers(), now: at('2026-10-13T10:00:00Z') });
    await db.update(schema.entities).set({ deletedAt: null });
    expect(result).toEqual({ entities: 0, sent: 0, skipped: 0, failed: 0 });
    const noAdmins = await runTaxReminders(db, { notifier: recorder().notifier, markers: memoryMarkers(), now: at('2026-10-13T10:00:00Z'), recipients: [] });
    expect(noAdmins.sent).toBe(0);
  });
});

describe('markers and in-app delivery', () => {
  it('stores a marker per reminder in the workspace KV namespace with a TTL', async () => {
    const store = new Map<string, { value: string; ttl?: number }>();
    const kv = {
      get: async (key: string) => store.get(key)?.value ?? null,
      put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
        store.set(key, { value, ttl: options?.expirationTtl });
      },
    } as unknown as KVNamespace;
    const markers = kvMarkers(kv, 'org_1');
    expect(await markers.has('sales_tax:a:2026-09-30:7d')).toBe(false);
    await markers.set('sales_tax:a:2026-09-30:7d', 150 * 86_400);
    expect(await markers.has('sales_tax:a:2026-09-30:7d')).toBe(true);
    expect(store.get('books:reminder:org_1:sales_tax:a:2026-09-30:7d')).toEqual({ value: '1', ttl: 150 * 86_400 });
    // the next tenant has its own markers
    expect(await kvMarkers(kv, 'org_2').has('sales_tax:a:2026-09-30:7d')).toBe(false);
  });

  it('writes a notification row and publishes it live', async () => {
    const calls: Array<{ url: string; body: Record<string, any> }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const realtime = {
      fetch: async (url: string, init?: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response('{}', { status: 200 });
      },
    } as unknown as Fetcher;
    const notifier = createInAppNotifier(db, { REALTIME: realtime }, 'org_1');
    await notifier.send('user_admin', {
      title: 'Sales tax return overdue: Texas Comptroller',
      body: 'The TX return is overdue.',
      severity: 'error',
      actionUrl: '/weldbooks/tax/sales-tax',
      entityType: 'sales_tax_agency',
      entityId: 'agy_tx',
      data: { kind: 'sales_tax_due' },
    });
    const [row] = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, 'user_admin'));
    expect(row).toMatchObject({
      title: 'Sales tax return overdue: Texas Comptroller',
      category: 'weldbooks',
      notificationType: 'sales_tax_due',
      entityType: 'sales_tax_agency',
      entityId: 'agy_tx',
      actionUrl: '/weldbooks/tax/sales-tax',
      severity: 'error',
      isRead: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://internal/publish/workspace');
    expect(calls[0]!.body).toMatchObject({ workspaceId: 'org_1', topic: 'notification.user_admin', event: 'created' });
    expect(calls[0]!.body.data).toMatchObject({ id: row!.id, isRead: false, _access: { userIds: ['user_admin'] } });

    // without the binding (local dev) the row is still saved
    await createInAppNotifier(db, {}, 'org_1').send('user_owner', {
      title: 'x', body: 'y', severity: 'info', actionUrl: '/weldbooks/tax', entityType: 'tax_deadline', entityId: 'e',
    });
    const rows = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, 'user_owner'));
    expect(rows).toHaveLength(1);
  });
});

describe('books sweep', () => {
  it('sends the reminders of every registered tenant and keeps the markers in KV', async () => {
    const { runBooksDailySweep } = await import('./books-sweep');
    const kvStore = new Map<string, string>([['books:active:org_sweep', '1']]);
    const kv = {
      list: async ({ prefix }: { prefix: string }) => ({
        keys: [...kvStore.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      }),
      get: async (key: string) => kvStore.get(key) ?? null,
      put: async (key: string, value: string) => {
        kvStore.set(key, value);
      },
    } as unknown as KVNamespace;
    const env = { WORKSPACE_CACHE: kv } as unknown as Parameters<typeof runBooksDailySweep>[0];

    // The 20th of October: the Texas return is due today.
    const result = await runBooksDailySweep(env, at('2026-10-20T10:00:00Z'));
    expect(result).toEqual({ tenants: 1, failed: 0 });
    const notes = await db.select().from(schema.notifications);
    const titles = notes.filter((n) => n.title.startsWith('Sales tax return due today')).map((n) => n.userId).sort();
    expect(titles).toEqual(['user_admin', 'user_owner']);
    expect([...kvStore.keys()].some((k) => k === 'books:reminder:org_sweep:sales_tax:agy_tx:2026-09-30:1d')).toBe(true);

    // The next run the same day sends nothing new.
    const before = (await db.select().from(schema.notifications)).length;
    await runBooksDailySweep(env, at('2026-10-20T11:00:00Z'));
    expect((await db.select().from(schema.notifications)).length).toBe(before);
  });
});
