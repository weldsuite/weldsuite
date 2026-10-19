import { describe, expect, it } from 'vitest';
import {
  DRIFT_RECENT_WINDOW_MS,
  classifyPlacement,
  detectShardDrift,
  expectedDatabaseCount,
  hasShardLinkDrift,
  shardFill,
} from './databases';

describe('classifyPlacement', () => {
  const shards = new Set(['proj-shard-a', 'proj-shard-b']);

  it('is shared when the Neon project is one of the shards', () => {
    expect(classifyPlacement({ neonProjectId: 'proj-shard-a' }, shards)).toBe('shared');
    expect(classifyPlacement({ neonProjectId: 'proj-shard-b' }, ['proj-shard-a', 'proj-shard-b'])).toBe('shared');
  });

  it('is dedicated when it has a project that is no shard', () => {
    expect(classifyPlacement({ neonProjectId: 'proj-own' }, shards)).toBe('dedicated');
    expect(classifyPlacement({ neonProjectId: 'proj-own' }, [])).toBe('dedicated');
  });

  it('is none without a Neon project', () => {
    expect(classifyPlacement({ neonProjectId: null }, shards)).toBe('none');
    expect(classifyPlacement({ neonProjectId: undefined }, shards)).toBe('none');
    expect(classifyPlacement({ neonProjectId: '' }, shards)).toBe('none');
  });

  it('matches whole ids, not prefixes', () => {
    expect(classifyPlacement({ neonProjectId: 'proj-shard' }, shards)).toBe('dedicated');
  });
});

describe('hasShardLinkDrift', () => {
  it('is quiet when the shard link is empty', () => {
    expect(hasShardLinkDrift(null, null)).toBe(false);
    expect(hasShardLinkDrift(undefined, 'nsp_a')).toBe(false);
    expect(hasShardLinkDrift('', null)).toBe(false);
  });

  it('is quiet when the shard link names the shard the project belongs to', () => {
    expect(hasShardLinkDrift('nsp_a', 'nsp_a')).toBe(false);
  });

  it('flags a shard link that names a different shard', () => {
    expect(hasShardLinkDrift('nsp_a', 'nsp_b')).toBe(true);
  });

  it('flags a shard link when the project belongs to none', () => {
    expect(hasShardLinkDrift('nsp_a', null)).toBe(true);
    expect(hasShardLinkDrift('nsp_a', undefined)).toBe(true);
  });
});

describe('shardFill', () => {
  it('is ok below 70%', () => {
    expect(shardFill(0, 100)).toEqual({ percent: 0, level: 'ok' });
    expect(shardFill(69, 100)).toEqual({ percent: 69, level: 'ok' });
  });

  it('warns from 70% up to 90%', () => {
    expect(shardFill(70, 100)).toEqual({ percent: 70, level: 'warning' });
    expect(shardFill(89, 100)).toEqual({ percent: 89, level: 'warning' });
  });

  it('is full from 90%', () => {
    expect(shardFill(90, 100)).toEqual({ percent: 90, level: 'full' });
    expect(shardFill(100, 100)).toEqual({ percent: 100, level: 'full' });
  });

  it('scales with the capacity', () => {
    expect(shardFill(347, 500)).toEqual({ percent: 69.4, level: 'ok' });
    expect(shardFill(350, 500)).toEqual({ percent: 70, level: 'warning' });
    expect(shardFill(450, 500)).toEqual({ percent: 90, level: 'full' });
  });

  it('reports a shard over capacity as more than 100%', () => {
    expect(shardFill(105, 100)).toEqual({ percent: 105, level: 'full' });
  });

  it('copes with a zero or missing capacity and a negative count', () => {
    expect(shardFill(0, 0)).toEqual({ percent: 0, level: 'ok' });
    expect(shardFill(3, 0)).toEqual({ percent: 100, level: 'full' });
    expect(shardFill(-4, 100)).toEqual({ percent: 0, level: 'ok' });
  });
});

describe('detectShardDrift', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const quietSince = new Date(now - DRIFT_RECENT_WINDOW_MS - 1_000).toISOString();

  const base = {
    databaseCount: 10,
    liveWorkspaces: 6,
    pendingTeardown: 1,
    unassignedPoolSlots: 3,
    updatedAt: quietSince,
  };

  it('adds workspaces, workspaces awaiting teardown and unassigned pool slots', () => {
    expect(expectedDatabaseCount(base)).toBe(10);
  });

  it('is in sync when the counter matches', () => {
    expect(detectShardDrift(base, now)).toEqual({ actual: 10, expected: 10, delta: 0, state: 'in_sync' });
  });

  it('does not count a pool slot twice once a workspace has it', () => {
    // 4 workspaces, one of which came from the pool, plus 2 slots still warm:
    // 6 databases. The assigned slot adds nothing (callers only pass unassigned ones).
    const drift = detectShardDrift(
      { databaseCount: 6, liveWorkspaces: 4, pendingTeardown: 0, unassignedPoolSlots: 2, updatedAt: quietSince },
      now,
    );
    expect(drift.state).toBe('in_sync');
  });

  it('flags a counter that is too high once nothing is in flight', () => {
    expect(detectShardDrift({ ...base, databaseCount: 12 }, now)).toEqual({
      actual: 12,
      expected: 10,
      delta: 2,
      state: 'drift',
    });
  });

  it('flags a counter that is too low', () => {
    expect(detectShardDrift({ ...base, databaseCount: 8 }, now)).toEqual({
      actual: 8,
      expected: 10,
      delta: -2,
      state: 'drift',
    });
  });

  it('calls a mismatch on a recently changed shard recent, not drift', () => {
    const justNow = new Date(now - 60_000).toISOString();
    expect(detectShardDrift({ ...base, databaseCount: 11, updatedAt: justNow }, now).state).toBe('recent');
    expect(detectShardDrift({ ...base, databaseCount: 9, updatedAt: new Date(now - 60_000) }, now).state).toBe('recent');
  });

  it('stops calling it recent once the window has passed', () => {
    const edge = new Date(now - DRIFT_RECENT_WINDOW_MS).toISOString();
    expect(detectShardDrift({ ...base, databaseCount: 11, updatedAt: edge }, now).state).toBe('drift');
  });

  it('treats an unreadable timestamp as not recent', () => {
    expect(detectShardDrift({ ...base, databaseCount: 11, updatedAt: 'not a date' }, now).state).toBe('drift');
  });

  it('never calls an exact match anything but in sync, however recent', () => {
    const justNow = new Date(now - 1_000).toISOString();
    expect(detectShardDrift({ ...base, updatedAt: justNow }, now).state).toBe('in_sync');
  });
});
