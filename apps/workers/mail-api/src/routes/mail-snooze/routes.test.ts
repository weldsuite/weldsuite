/**
 * /api/mail-snooze against a pglite tenant DB (postgres mode): snooze, wake
 * early, re-snooze and the snoozed lists, with their refusals.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mailSnoozeRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { MEMBER, PRIVATE, SHARED, STRANGER, seedMailboxes, seedMembers, seedMessages } from '../../test/mail-seed';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedMembers(db);
  await seedMailboxes(db);
  await seedMessages(db, [
    { id: 'mmsg_s1', subject: 'Snooze me', labels: ['INBOX'] },
    { id: 'mmsg_s2', subject: 'Leave me', labels: ['INBOX'] },
    { id: 'mmsg_s3', accountId: PRIVATE, subject: 'Private', labels: ['INBOX'] },
  ]);
}, 60_000);

function as(userId: string) {
  const { request } = createTestApp('/api/mail-snooze', mailSnoozeRoutes, {
    context: { userId, tenantDb: db, permissions: permissions('messages:read', 'messages:update') },
  });
  return (method: string, path: string, body?: unknown) =>
    request(`/api/mail-snooze${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

describe('snooze', () => {
  it('snoozes, re-snoozes, lists and wakes', async () => {
    const member = as(MEMBER);
    const path = (id: string, action: string, account = SHARED) => `/accounts/${account}/messages/${id}/${action}`;
    expect((await member('POST', path('mmsg_s1', 'snooze'), { until: future(2) })).status).toBe(200);
    expect((await member('POST', path('mmsg_s1', 'snooze'), { until: '2020-01-01T00:00:00Z' })).status).toBe(400);
    expect((await member('POST', path('mmsg_s1', 'snooze'), { until: 'tomorrow' })).status).toBe(400);
    expect((await member('POST', path('mmsg_missing', 'snooze'), { until: future(1) })).status).toBe(404);
    expect((await member('POST', path('mmsg_s1', 'resnooze'), { until: future(3) })).status).toBe(200);
    expect((await member('POST', path('mmsg_s1', 'resnooze'), { until: '2020-01-01T00:00:00Z' })).status).toBe(400);
    expect((await member('POST', path('mmsg_missing', 'resnooze'), { until: future(3) })).status).toBe(404);
    expect((await as(STRANGER)('POST', path('mmsg_s3', 'resnooze', PRIVATE), { until: future(3) })).status).toBe(403);

    expect((await member('GET', '/snoozed')).status).toBe(200);
    expect((await member('GET', `/snoozed?accountId=${SHARED}`)).status).toBe(200);
    expect((await as(STRANGER)('GET', `/snoozed?accountId=${PRIVATE}`)).status).toBe(403);

    expect((await member('POST', path('mmsg_s2', 'unsnooze'))).status).toBe(400);
    expect((await member('POST', path('mmsg_missing', 'unsnooze'))).status).toBe(404);
    expect((await as(STRANGER)('POST', path('mmsg_s3', 'unsnooze', PRIVATE))).status).toBe(403);
    expect((await member('POST', path('mmsg_s1', 'unsnooze'))).status).toBe(200);
  });
});
