/**
 * Tests for the SEARCH_EVENTS consumer — batch grouping and message disposition.
 *
 * Coalescing is the consumer's whole reason for existing: an edit burst on one
 * record produces a stream of events, and re-embedding once per event would
 * multiply the cost of the feature by however fast someone types.
 *
 * The ack/retry branches matter just as much and are less obvious: acking the
 * wrong failure permanently drops a record from search, retrying the wrong one
 * recycles a poison message until the queue gives up on it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EntityEventMessage } from '@weldsuite/entity-events';
import { groupBatch, handleSearchIndexBatch } from './search-index-consumer';
import type { Env } from '../types';

vi.mock('../services/search/indexer', () => ({
  createEmbedder: vi.fn(() => ({ embed: vi.fn() })),
  indexEntity: vi.fn(async () => ({
    entityType: 'ticket',
    entityId: 'tkt_1',
    embedded: 1,
    skipped: 0,
    removed: 0,
  })),
}));

vi.mock('../db', () => ({
  getTenantDbForWorkspace: vi.fn(async () => ({}) as never),
}));

const { createEmbedder, indexEntity } = await import('../services/search/indexer');
const { getTenantDbForWorkspace } = await import('../db');

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

describe('handleSearchIndexBatch', () => {
  const env = {} as Env;

  function batch(messages: TestMessage[]) {
    return {
      queue: 'search-index',
      messages: messages as unknown as Message<EntityEventMessage>[],
      retryAll: vi.fn(),
      ackAll: vi.fn(),
    };
  }

  beforeEach(() => {
    // Clear call history FIRST, then install implementations. The reverse order
    // happens to work (clearAllMocks keeps implementations) but breaks the day
    // someone reaches for resetAllMocks instead.
    vi.clearAllMocks();
    vi.mocked(createEmbedder).mockReturnValue({ embed: vi.fn() });
    vi.mocked(getTenantDbForWorkspace).mockResolvedValue({} as never);
    vi.mocked(indexEntity).mockResolvedValue({
      entityType: 'ticket',
      entityId: 'tkt_1',
      embedded: 1,
      skipped: 0,
      removed: 0,
    });
  });

  it('acks every message backing a job that indexed successfully', async () => {
    const messages = [message(), message()];
    await handleSearchIndexBatch(batch(messages) as never, env);

    // Two events, one record: indexed once, both acked.
    expect(indexEntity).toHaveBeenCalledOnce();
    for (const m of messages) {
      expect(m.ack).toHaveBeenCalledOnce();
      expect(m.retry).not.toHaveBeenCalled();
    }
  });

  it('retries the whole batch when the AI gateway is unconfigured', async () => {
    vi.mocked(createEmbedder).mockImplementation(() => {
      throw new Error('gateway not configured');
    });
    const b = batch([message()]);

    await handleSearchIndexBatch(b as never, env);

    // An environment fault a redeploy fixes — dropping would leave the index
    // permanently behind with nothing to signal it.
    expect(b.retryAll).toHaveBeenCalledOnce();
    expect(indexEntity).not.toHaveBeenCalled();
  });

  it('acks and drops a workspace that no longer resolves', async () => {
    vi.mocked(getTenantDbForWorkspace).mockRejectedValue(new Error('no such workspace'));
    const m = message();

    await handleSearchIndexBatch(batch([m]) as never, env);

    // Usually a deleted workspace, not an outage — retrying would recycle
    // its backlog forever.
    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
  });

  it('retries only the messages of the job that failed', async () => {
    vi.mocked(indexEntity)
      .mockRejectedValueOnce(new Error('embed failed'))
      .mockResolvedValueOnce({
        entityType: 'ticket',
        entityId: 'tkt_2',
        embedded: 1,
        skipped: 0,
        removed: 0,
      });

    const failing = message({ entityId: 'tkt_1' });
    const succeeding = message({ entityId: 'tkt_2' });

    await handleSearchIndexBatch(batch([failing, succeeding]) as never, env);

    expect(failing.retry).toHaveBeenCalledOnce();
    expect(failing.ack).not.toHaveBeenCalled();
    expect(succeeding.ack).toHaveBeenCalledOnce();
    expect(succeeding.retry).not.toHaveBeenCalled();
  });

  it('resolves one DB handle per workspace, not per record', async () => {
    await handleSearchIndexBatch(
      batch([
        message({ workspaceId: 'org_1', entityId: 'tkt_1' }),
        message({ workspaceId: 'org_1', entityId: 'tkt_2' }),
        message({ workspaceId: 'org_2', entityId: 'tkt_3' }),
      ]) as never,
      env,
    );

    expect(getTenantDbForWorkspace).toHaveBeenCalledTimes(2);
  });
});
