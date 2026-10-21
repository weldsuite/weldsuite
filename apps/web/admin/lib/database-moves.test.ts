import { describe, expect, it } from 'vitest';
import {
  STALE_MOVE_MS,
  canCancelMove,
  computeState,
  formatBytes,
  isDatabaseMoveView,
  isMoveTarget,
  liveByProjectId,
  moveProgressPercent,
  moveStepIndex,
  moveTargets,
  recoverMode,
  type ShardCandidate,
} from './database-moves';

const shard = (over: Partial<ShardCandidate> & { id: string }): ShardCandidate => ({
  neonProjectName: over.id,
  region: 'aws-eu-central-1',
  status: 'active',
  databaseCount: 10,
  maxDatabases: 100,
  ...over,
});

describe('moveTargets', () => {
  const shards = [
    shard({ id: 'nsp_current' }),
    shard({ id: 'nsp_busy', databaseCount: 80 }),
    shard({ id: 'nsp_quiet', databaseCount: 5 }),
    shard({ id: 'nsp_full', databaseCount: 100 }),
    shard({ id: 'nsp_disabled', status: 'disabled' }),
    shard({ id: 'nsp_us', region: 'aws-us-east-2' }),
  ];

  it('offers a shared database a dedicated project and every other active shard with room, emptiest first', () => {
    const targets = moveTargets(
      {
        placement: 'shared',
        region: 'aws-eu-central-1',
        shardId: 'nsp_current',
      },
      shards,
    );
    expect(targets.dedicated).toBe(true);
    expect(targets.auto).toBe(true);
    expect(targets.shards.map((s) => s.id)).toEqual(['nsp_quiet', 'nsp_busy']);
  });

  it('offers a dedicated database the shards only', () => {
    const targets = moveTargets({ placement: 'dedicated', region: 'aws-eu-central-1', shardId: null }, shards);
    expect(targets.dedicated).toBe(false);
    expect(targets.shards.map((s) => s.id)).toEqual(['nsp_quiet', 'nsp_current', 'nsp_busy']);
  });

  it('offers nothing without a database or a region, and no auto shard when none has room', () => {
    expect(moveTargets({ placement: 'none', region: 'aws-eu-central-1', shardId: null }, shards)).toEqual({
      dedicated: false,
      auto: false,
      shards: [],
    });
    expect(moveTargets({ placement: 'shared', region: null, shardId: 'nsp_current' }, shards).dedicated).toBe(false);
    const lonely = moveTargets({ placement: 'shared', region: 'aws-us-east-2', shardId: 'nsp_us' }, shards);
    expect(lonely).toEqual({ dedicated: true, auto: false, shards: [] });
  });
});

describe('isMoveTarget', () => {
  it('accepts what the worker accepts', () => {
    for (const target of ['dedicated', 'shard:auto', 'nsp_abc123']) expect(isMoveTarget(target)).toBe(true);
    for (const target of ['', 'shard', 'nsp_', 'NSP_ABC', 'nsp_abc; drop', 42])
      expect(isMoveTarget(target)).toBe(false);
  });
});

describe('move steps, progress and actions', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('places statuses on the happy path, and off it for failed and cancelled', () => {
    expect(moveStepIndex('queued')).toBe(0);
    expect(moveStepIndex('copying')).toBe(4);
    expect(moveStepIndex('completed')).toBe(7);
    expect(moveStepIndex('failed')).toBe(-1);
    expect(moveStepIndex('cancelled')).toBe(-1);
  });

  it('turns copy progress into a whole percentage, or null while the total is unknown', () => {
    expect(moveProgressPercent({ copiedRows: 333, totalRows: 1000 })).toBe(33);
    expect(moveProgressPercent({ copiedRows: 1200, totalRows: 1000 })).toBe(100);
    expect(moveProgressPercent({ copiedRows: 10, totalRows: null })).toBeNull();
    expect(moveProgressPercent({ copiedRows: 0, totalRows: 0 })).toBeNull();
    expect(moveProgressPercent(null)).toBeNull();
  });

  it('lets a move be cancelled before the switch, once', () => {
    expect(canCancelMove({ status: 'copying', cancelRequestedAt: null })).toBe(true);
    expect(canCancelMove({ status: 'copying', cancelRequestedAt: ago(1000) })).toBe(false);
    expect(canCancelMove({ status: 'switching', cancelRequestedAt: null })).toBe(false);
    expect(canCancelMove({ status: 'completed', cancelRequestedAt: null })).toBe(false);
  });

  it('offers a recovery for failed and cancelling moves, a forced one for a stale running move, none otherwise', () => {
    expect(recoverMode({ status: 'failed', updatedAt: ago(1000) }, now)).toBe('recover');
    expect(recoverMode({ status: 'cancelling', updatedAt: ago(1000) }, now)).toBe('recover');
    expect(recoverMode({ status: 'copying', updatedAt: ago(STALE_MOVE_MS - 1) }, now)).toBe('none');
    expect(recoverMode({ status: 'copying', updatedAt: ago(STALE_MOVE_MS) }, now)).toBe('force');
    expect(recoverMode({ status: 'completed', updatedAt: ago(STALE_MOVE_MS * 10) }, now)).toBe('none');
    expect(recoverMode({ status: 'cancelled', updatedAt: ago(STALE_MOVE_MS * 10) }, now)).toBe('none');
  });
});

describe('live compute', () => {
  const endpoint = (currentState: string) => ({
    id: `ep-${currentState}`,
    type: 'read_write',
    currentState,
    minCu: 0.25,
    maxCu: 2,
    suspendTimeoutSeconds: 0,
    lastActive: null,
  });

  it('sums a project up in one word', () => {
    expect(
      computeState({
        endpoints: [endpoint('idle'), endpoint('active')],
        error: null,
      }),
    ).toBe('active');
    expect(computeState({ endpoints: [endpoint('init')], error: null })).toBe('starting');
    expect(
      computeState({
        endpoints: [endpoint('idle'), endpoint('idle')],
        error: null,
      }),
    ).toBe('suspended');
    expect(computeState({ endpoints: [], error: null })).toBe('unknown');
    expect(computeState({ endpoints: [endpoint('active')], error: 'Neon is down' })).toBe('unknown');
    expect(computeState(undefined)).toBe('unknown');
  });

  it('indexes shards and dedicated projects by Neon project id', () => {
    const map = liveByProjectId({
      shards: [
        {
          neonProjectId: 'proj-shard',
          endpoints: [],
          error: null,
          shardId: 'nsp_a',
          name: 'a',
          region: 'r',
          status: 'active',
          databaseCount: 1,
          maxDatabases: 2,
        },
      ],
      dedicated: [{ neonProjectId: 'proj-own', endpoints: [], error: null }],
      fetchedAt: '2026-10-19T12:00:00Z',
    });
    expect([...map.keys()]).toEqual(['proj-shard', 'proj-own']);
  });
});

describe('formatBytes', () => {
  it('picks a readable unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB');
    expect(formatBytes(3.2 * 1024 ** 3)).toBe('3.2 GB');
    expect(formatBytes(-1)).toBe('—');
  });
});

describe('isDatabaseMoveView', () => {
  const view = {
    id: 'dbm_1',
    workspaceId: 'ws_1',
    kind: 'shard_to_dedicated',
    status: 'copying',
    source: {
      neonProjectId: 'p',
      databaseName: 'd',
      sharedProjectId: 'nsp_a',
      region: 'r',
    },
    createdAt: '2026-10-19T12:00:00Z',
    updatedAt: '2026-10-19T12:00:00Z',
  };

  it('accepts a projected move and refuses anything else', () => {
    expect(isDatabaseMoveView(view)).toBe(true);
    expect(isDatabaseMoveView({ ...view, status: 'exploded' })).toBe(false);
    expect(isDatabaseMoveView({ ...view, source: null })).toBe(false);
    expect(isDatabaseMoveView(null)).toBe(false);
  });
});
