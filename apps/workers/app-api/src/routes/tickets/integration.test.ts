/**
 * DB-backed integration tests for /api/tickets.
 *
 * The route now auto-generates `ticketNumber` when missing, so the
 * happy-path is testable end-to-end. The auth-only contract is
 * already covered by `index.test.ts` and `_auth-gates.test.ts`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { ticketsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/tickets · pglite integration', () => {
  it('POST / writes a ticket and auto-generates ticketNumber', async () => {
    const { request } = createTestApp('/api/tickets', ticketsRoutes, {
      context: { permissions: permissions('tickets:create'), tenantDb: db },
    });

    const res = await request('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'Jane E2E',
        customerEmail: 'jane@e2e.test',
        subject: 'My printer is on fire',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^tkt_/);

    const [row] = await db
      .select()
      .from(schema.helpdeskTickets)
      .where(eq(schema.helpdeskTickets.id, body.data.id))
      .limit(1);
    expect(row?.subject).toBe('My printer is on fire');
    expect(row?.customerEmail).toBe('jane@e2e.test');
    // Auto-generated ticketNumber follows the TKT-<ts>-<rand> shape.
    expect(row?.ticketNumber).toMatch(/^TKT-/);
  });

  it('POST / accepts an explicit ticketNumber verbatim', async () => {
    const { request } = createTestApp('/api/tickets', ticketsRoutes, {
      context: { permissions: permissions('tickets:create'), tenantDb: db },
    });

    const res = await request('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'Jane E2E',
        customerEmail: 'jane@e2e.test',
        subject: 'A second issue',
        ticketNumber: 'CUSTOM-NUMBER-42',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    const [row] = await db
      .select()
      .from(schema.helpdeskTickets)
      .where(eq(schema.helpdeskTickets.id, body.data.id))
      .limit(1);
    expect(row?.ticketNumber).toBe('CUSTOM-NUMBER-42');
  });

  it('POST / rejects an invalid email at the Zod layer', async () => {
    const { request } = createTestApp('/api/tickets', ticketsRoutes, {
      context: { permissions: permissions('tickets:create'), tenantDb: db },
    });
    const res = await request('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'X',
        customerEmail: 'not-an-email',
        subject: 'X',
      }),
    });
    expect(res.status).toBe(400);
  });
});
