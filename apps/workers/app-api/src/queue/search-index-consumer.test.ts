/**
 * Tests for the SEARCH_EVENTS batch grouping.
 *
 * Coalescing is the consumer's whole reason for existing: an edit burst on one
 * record produces a stream of events, and re-embedding once per event would
 * multiply the cost of the feature by however fast someone types.
 */

import { describe, it, expect, vi } from 'vitest';
import type { EntityEventMessage } from '@weldsuite/entity-events';
import { groupBatch } from './search-index-consumer';

function message(
  overrides: {
    workspaceId?: string | undefined;
    entityType?: string;
    entityId?: string;
  } = {},
) {
  // `in` rather than a destructuring default: a default would swallow an
  // explicit `undefined`, which is exactly the malformed case under test.
  const workspaceId = 'workspaceId' in overrides ? overrides.workspaceId : 'org_1';
  const { entityType = 'ticket', entityId = 'tkt_1' } = overrides;
  return {
    body: {
      id: 'evt_1',
      eventType: `${entityType}:updated`,
      entityType,
      entityId,
      action: 'updated',
      data: {},
      metadata: {
        workspaceId,
        userId: 'user_1',
        timestamp: new Date().toISOString(),
        source: 'api',
      },
    } as unknown as EntityEventMessage,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

type TestMessage = ReturnType<typeof message>;

function group(messages: TestMessage[]) {
  return groupBatch(messages as unknown as Message<EntityEventMessage>[]);
}

describe('groupBatch', () => {
  it('collapses repeated events for one record into a single job', () => {
    const messages = [message(), message(), message()];

    const grouped = group(messages);
    const jobs = grouped.get('org_1')!;

    expect(jobs.size).toBe(1);
    // All three still have to be acked once the single index run succeeds.
    expect(jobs.get('ticket:tkt_1')!.messages).toHaveLength(3);
  });

  it('keeps distinct records apart', () => {
    const grouped = group([
      message({ entityId: 'tkt_1' }),
      message({ entityId: 'tkt_2' }),
      message({ entityType: 'project', entityId: 'prj_1' }),
    ]);

    expect(grouped.get('org_1')!.size).toBe(3);
  });

  it('partitions by workspace so each tenant gets its own DB handle', () => {
    const grouped = group([
      message({ workspaceId: 'org_1' }),
      message({ workspaceId: 'org_2' }),
    ]);

    expect([...grouped.keys()].sort()).toEqual(['org_1', 'org_2']);
  });

  it('maps entity-event aliases onto the type they index under', () => {
    // The event catalog emits `person` for the same table search calls
    // `contact`; both must land on one index entry or updates through one
    // path would leave the other stale.
    const grouped = group([
      message({ entityType: 'person', entityId: 'per_1' }),
      message({ entityType: 'contact', entityId: 'per_1' }),
    ]);

    const jobs = grouped.get('org_1')!;
    expect(jobs.size).toBe(1);
    expect(jobs.get('contact:per_1')!.messages).toHaveLength(2);
  });

  it('acks and drops entity types the semantic index does not cover', () => {
    // Invoices are lexical-only by design; retrying would never help.
    const invoice = message({ entityType: 'invoice', entityId: 'inv_1' });

    const grouped = group([invoice]);

    expect(grouped.size).toBe(0);
    expect(invoice.ack).toHaveBeenCalledOnce();
    expect(invoice.retry).not.toHaveBeenCalled();
  });

  it('acks malformed messages instead of recycling them forever', () => {
    const noWorkspace = message({ workspaceId: undefined });

    const grouped = group([noWorkspace]);

    expect(grouped.size).toBe(0);
    expect(noWorkspace.ack).toHaveBeenCalledOnce();
  });
});
