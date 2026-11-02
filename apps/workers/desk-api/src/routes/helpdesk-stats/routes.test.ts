/**
 * GET /api/helpdesk-stats on pglite: ticket counts by status and priority,
 * on an empty table and a seeded one (deleted tickets left out). Runs against
 * Rust in conformance mode.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { helpdeskStatsRoutes } from './index';

const BASE = '/api/helpdesk-stats';

let db: Database;

const app = (...keys: string[]) =>
  createTestApp(BASE, helpdeskStatsRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('GET /api/helpdesk-stats', () => {
  it('answers zeros when there are no tickets', async () => {
    const res = await app('tickets:read').request(BASE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        totalTickets: 0,
        openTickets: 0,
        pendingTickets: 0,
        resolvedTickets: 0,
        closedTickets: 0,
        newTickets: 0,
        urgentTickets: 0,
        highPriorityTickets: 0,
      },
    });
  });

  it('counts live tickets by status and priority', async () => {
    const created = new Date(Date.UTC(2026, 0, 1));
    const ticket = (n: number, status: string, priority: string, deletedAt: Date | null = null) => ({
      id: `tkt_stats_${n}`,
      ticketNumber: `TKT-${n}`,
      customerName: 'Customer',
      customerEmail: 'c@x.test',
      subject: `Ticket ${n}`,
      status,
      priority,
      deletedAt,
      createdAt: created,
      updatedAt: created,
    });
    await db.insert(schema.helpdeskTickets).values([
      ticket(1, 'open', 'urgent'),
      ticket(2, 'open', 'high'),
      ticket(3, 'pending', 'high'),
      ticket(4, 'resolved', 'low'),
      ticket(5, 'closed', 'medium'),
      ticket(6, 'new', 'urgent'),
      ticket(7, 'on_hold', 'normal'),
      ticket(8, 'open', 'urgent', created),
    ]);

    const res = await app('tickets:read').request(BASE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        totalTickets: 7,
        openTickets: 2,
        pendingTickets: 1,
        resolvedTickets: 1,
        closedTickets: 1,
        newTickets: 1,
        urgentTickets: 2,
        highPriorityTickets: 2,
      },
    });
  });

  it('needs tickets:read', async () => {
    expect((await app().request(BASE)).status).toBe(403);
    expect((await app('articles:read').request(BASE)).status).toBe(403);
  });
});
