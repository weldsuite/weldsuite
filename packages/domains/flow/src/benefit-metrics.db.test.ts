/**
 * The benefit metric catalogue against a real Postgres (pglite): each metric is
 * one aggregate over other modules' tables, so a schema change in WeldDesk,
 * WeldCommerce or WeldBooks has to break here (FLOW-014).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { measureMetric } from './benefit-metrics';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const at = (iso: string) => new Date(iso);

describe('desk_tickets_by_tag', () => {
  it('counts the live tickets created in the month with the tag', async () => {
    const ticket = (id: string, createdAt: string, tags: string[] | null, deletedAt: string | null = null) => ({
      id,
      ticketNumber: id,
      customerName: 'Customer',
      customerEmail: 'customer@example.com',
      subject: 'Where is my order?',
      tags,
      createdAt: at(createdAt),
      deletedAt: deletedAt ? at(deletedAt) : null,
    });
    await db.insert(schema.helpdeskTickets).values([
      ticket('t_bm_1', '2026-10-02T09:00:00.000Z', ['order status', 'vip']),
      ticket('t_bm_2', '2026-10-31T23:59:59.000Z', ['order status']),
      ticket('t_bm_3', '2026-10-15T09:00:00.000Z', ['order status'], '2026-10-16T09:00:00.000Z'),
      ticket('t_bm_4', '2026-10-15T09:00:00.000Z', ['billing']),
      ticket('t_bm_5', '2026-10-15T09:00:00.000Z', null),
      ticket('t_bm_6', '2026-09-30T23:59:59.000Z', ['order status']),
      ticket('t_bm_7', '2026-11-01T00:00:00.000Z', ['order status']),
    ]);
    expect(await measureMetric(db, 'desk_tickets_by_tag', { tag: 'order status' }, '2026-10')).toBe('2');
    expect(await measureMetric(db, 'desk_tickets_by_tag', { tag: 'order status' }, '2026-09')).toBe('1');
    expect(await measureMetric(db, 'desk_tickets_by_tag', { tag: 'billing' }, '2026-10')).toBe('1');
    expect(await measureMetric(db, 'desk_tickets_by_tag', { tag: 'nothing' }, '2026-10')).toBe('0');
  });
});

describe('commerce_repeat_online_share', () => {
  it('is the share of the months repeat orders that were placed online', async () => {
    const order = (
      id: string,
      createdAt: string,
      buyer: { customerId?: string; counterpartyId?: string },
      source: string,
      status = 'completed',
    ) => ({
      id,
      orderNumber: id,
      customerId: buyer.customerId ?? null,
      counterpartyId: buyer.counterpartyId ?? null,
      source,
      status,
      createdAt: at(createdAt),
    });
    await db.insert(schema.orders).values([
      order('o_bm_1', '2026-09-10T10:00:00.000Z', { customerId: 'cus_c1' }, 'web'),
      order('o_bm_2', '2026-10-05T10:00:00.000Z', { customerId: 'cus_c1' }, 'web'),
      order('o_bm_3', '2026-10-07T10:00:00.000Z', { customerId: 'cus_c1' }, 'pos'),
      // A first order: not a repeat.
      order('o_bm_4', '2026-10-08T10:00:00.000Z', { customerId: 'cus_c2' }, 'web'),
      order('o_bm_5', '2026-09-01T10:00:00.000Z', { counterpartyId: 'cpt_p1' }, 'pos'),
      order('o_bm_6', '2026-10-10T10:00:00.000Z', { counterpartyId: 'cpt_p1' }, 'b2b_portal'),
      // Cancelled orders count neither as the order nor as the earlier one.
      order('o_bm_7', '2026-10-12T10:00:00.000Z', { customerId: 'cus_c1' }, 'web', 'cancelled'),
      order('o_bm_8', '2026-09-02T10:00:00.000Z', { customerId: 'cus_c3' }, 'web', 'cancelled'),
      order('o_bm_9', '2026-10-13T10:00:00.000Z', { customerId: 'cus_c3' }, 'web'),
    ]);
    // Repeat orders in October: o_bm_2 (web), o_bm_3 (pos), o_bm_6 (b2b_portal).
    expect(await measureMetric(db, 'commerce_repeat_online_share', {}, '2026-10')).toBe('66.6667');
    expect(await measureMetric(db, 'commerce_repeat_online_share', { sources: ['web'] }, '2026-10')).toBe('33.3333');
    // September has no repeat order: nothing to measure.
    expect(await measureMetric(db, 'commerce_repeat_online_share', {}, '2026-09')).toBeNull();
  });
});

describe('books_days_to_pay', () => {
  it('averages the days from issue to payment of the standard invoices paid in the month', async () => {
    const invoice = (id: string, issueDate: string, paidAt: string | null, extra: Record<string, unknown> = {}) => ({
      id,
      entityId: 'ent_1',
      contactId: 'con_1',
      issueDate: at(issueDate),
      dueDate: at('2027-01-01T00:00:00.000Z'),
      type: 'standard',
      status: paidAt ? 'paid' : 'sent',
      paidAt: paidAt ? at(paidAt) : null,
      ...extra,
    });
    await db.insert(schema.invoices).values([
      invoice('inv_bm_1', '2026-09-20T00:00:00.000Z', '2026-10-10T00:00:00.000Z'),
      invoice('inv_bm_2', '2026-10-01T00:00:00.000Z', '2026-10-11T00:00:00.000Z'),
      invoice('inv_bm_3', '2026-10-01T00:00:00.000Z', null),
      invoice('inv_bm_4', '2026-10-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z', { type: 'credit_note' }),
      invoice('inv_bm_5', '2026-10-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z', { deletedAt: at('2026-10-21T00:00:00.000Z') }),
      invoice('inv_bm_6', '2024-01-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z'),
    ]);
    expect(await measureMetric(db, 'books_days_to_pay', {}, '2026-10')).toBe('15.0000');
    expect(await measureMetric(db, 'books_days_to_pay', {}, '2026-08')).toBeNull();
  });
});

describe('books_supplier_cost', () => {
  it('sums the approved, partly paid and paid bills of one supplier over the 12 months ending with the month', async () => {
    const bill = (id: string, issueDate: string, total: string, status: string, extra: Record<string, unknown> = {}) => ({
      id,
      entityId: 'ent_1',
      contactId: 'con_other',
      issueDate: at(issueDate),
      dueDate: at('2027-01-01T00:00:00.000Z'),
      type: 'standard',
      status,
      total,
      ...extra,
    });
    await db.insert(schema.bills).values([
      bill('bill_bm_1', '2025-12-01T00:00:00.000Z', '100.00', 'paid', { contactId: 'sup_1' }),
      bill('bill_bm_2', '2026-10-15T00:00:00.000Z', '250.50', 'approved', { contactId: 'sup_1' }),
      bill('bill_bm_3', '2025-10-31T00:00:00.000Z', '999.00', 'paid', { contactId: 'sup_1' }),
      bill('bill_bm_4', '2026-03-01T00:00:00.000Z', '80.00', 'draft', { contactId: 'sup_1' }),
      bill('bill_bm_5', '2026-03-01T00:00:00.000Z', '500.00', 'paid', { contactId: 'sup_2' }),
      bill('bill_bm_6', '2026-04-01T00:00:00.000Z', '49.50', 'partial', { counterpartyId: 'sup_1' }),
      bill('bill_bm_7', '2026-05-01T00:00:00.000Z', '10.00', 'paid', { contactId: 'sup_1', deletedAt: at('2026-05-02T00:00:00.000Z') }),
      bill('bill_bm_8', '2026-11-01T00:00:00.000Z', '70.00', 'paid', { contactId: 'sup_1' }),
    ]);
    expect(await measureMetric(db, 'books_supplier_cost', { supplierId: 'sup_1' }, '2026-10')).toBe('400.00');
    expect(await measureMetric(db, 'books_supplier_cost', { supplierId: 'sup_1' }, '2026-11')).toBe('470.00');
    expect(await measureMetric(db, 'books_supplier_cost', { supplierId: 'sup_none' }, '2026-10')).toBe('0.00');
  });
});

describe('time_hours_per_week_by_tag', () => {
  it('spreads the hours logged on tasks with the tag over the weeks of the month', async () => {
    await db.insert(schema.tasks).values([
      { id: 'task_bm_1', title: 'Research', tags: ['research'] },
      { id: 'task_bm_2', title: 'Other', tags: ['admin'] },
      { id: 'task_bm_3', title: 'Deleted research', tags: ['research'], deletedAt: at('2026-10-20T00:00:00.000Z') },
    ]);
    const entry = (id: string, taskId: string, date: string, duration: string, status = 'approved') => ({
      id,
      taskId,
      userId: 'user_bm',
      date,
      duration,
      status,
    });
    await db.insert(schema.timeEntries).values([
      entry('te_bm_1', 'task_bm_1', '2026-10-01', '600'),
      entry('te_bm_2', 'task_bm_1', '2026-10-31', '300.00', 'draft'),
      entry('te_bm_3', 'task_bm_1', '2026-10-15', '120', 'rejected'),
      entry('te_bm_4', 'task_bm_2', '2026-10-15', '480'),
      entry('te_bm_5', 'task_bm_3', '2026-10-15', '480'),
      entry('te_bm_6', 'task_bm_1', '2026-11-01', '600'),
    ]);
    // 900 minutes = 15 hours over 31 days: 15 * 7 / 31 hours a week.
    expect(await measureMetric(db, 'time_hours_per_week_by_tag', { tag: 'research' }, '2026-10')).toBe('3.3871');
    expect(await measureMetric(db, 'time_hours_per_week_by_tag', { tag: 'research' }, '2026-12')).toBe('0.0000');
  });
});

describe('manual and unknown metrics', () => {
  it('measure nothing', async () => {
    expect(await measureMetric(db, 'manual', {}, '2026-10')).toBeNull();
    expect(await measureMetric(db, 'mystery', {}, '2026-10')).toBeNull();
  });
});
