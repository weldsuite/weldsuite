import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rtk = vi.hoisted(() => ({
  calls: [] as string[],
  kickError: null as Error | null,
  endError: null as Error | null,
  /** What RealtimeKit reports as connected; an Error makes the lookup fail. */
  live: 0 as number | Error,
}));

vi.mock('@weldsuite/cloudflare-realtime', () => ({
  kickAllParticipants: vi.fn(async (_env: unknown, id: string) => {
    rtk.calls.push(`kick:${id}`);
    if (rtk.kickError) throw rtk.kickError;
    return 0;
  }),
  endMeeting: vi.fn(async (_env: unknown, id: string) => {
    rtk.calls.push(`end:${id}`);
    if (rtk.endError) throw rtk.endError;
  }),
  getLiveParticipantCount: vi.fn(async (_env: unknown, id: string) => {
    rtk.calls.push(`live:${id}`);
    if (rtk.live instanceof Error) throw rtk.live;
    return rtk.live;
  }),
}));

vi.mock('@weldsuite/notifications', () => ({
  sendMissedCallNotification: vi.fn(async () => undefined),
}));

vi.mock('./realtime/weldchat-call-publisher', () => ({
  publishChatCallEnded: vi.fn(async () => undefined),
  broadcastChatCallToMembers: vi.fn(async () => undefined),
}));

import {
  endChatCall,
  endChatCallIfEmpty,
  scheduleRingTimeout,
  teardownRtkMeeting,
  type CallLifecycleEnv,
} from './call-lifecycle';
import { sendMissedCallNotification } from '@weldsuite/notifications';
import type { Database } from '@weldsuite/worker-kit/db';

function fakeKv() {
  const deleted: string[] = [];
  const kv = {
    deleted,
    get: async () => null,
    put: async () => undefined,
    delete: vi.fn(async (key: string) => {
      deleted.push(key);
    }),
  };
  return kv;
}

beforeEach(() => {
  rtk.calls.length = 0;
  rtk.kickError = null;
  rtk.endError = null;
  rtk.live = 0;
  vi.restoreAllMocks();
});

describe('teardownRtkMeeting', () => {
  it('kicks every participant before it ends the meeting, then drops the KV mapping', async () => {
    const kv = fakeKv();
    await teardownRtkMeeting({ WORKSPACE_CACHE: kv }, 'rtk_1', { callId: 'call_1' });
    expect(rtk.calls).toEqual(['kick:rtk_1', 'end:rtk_1']);
    expect(kv.deleted).toEqual(['rtk-meeting:rtk_1']);
  });

  it('still ends the meeting when the kick throws, and logs the failure with its context', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    rtk.kickError = new Error('room is empty');
    const kv = fakeKv();

    await teardownRtkMeeting({ WORKSPACE_CACHE: kv }, 'rtk_2', { callId: 'call_2' });

    expect(rtk.calls).toEqual(['kick:rtk_2', 'end:rtk_2']);
    expect(kv.deleted).toEqual(['rtk-meeting:rtk_2']);
    expect(error).toHaveBeenCalledWith(
      '[CallLifecycle] RTK kick-all failed',
      expect.objectContaining({ callId: 'call_2', cfAppId: 'rtk_2', err: rtk.kickError }),
    );
  });

  it('still cleans up the KV mapping when ending the meeting throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    rtk.endError = new Error('already inactive');
    const kv = fakeKv();

    await teardownRtkMeeting({ WORKSPACE_CACHE: kv }, 'rtk_3', { callId: 'call_3' });

    expect(kv.deleted).toEqual(['rtk-meeting:rtk_3']);
    expect(error).toHaveBeenCalledWith(
      '[CallLifecycle] RTK end meeting failed',
      expect.objectContaining({ callId: 'call_3', cfAppId: 'rtk_3' }),
    );
  });

  it('works without a KV binding', async () => {
    await expect(teardownRtkMeeting({}, 'rtk_4', { callId: 'call_4' })).resolves.toBeUndefined();
    expect(rtk.calls).toEqual(['kick:rtk_4', 'end:rtk_4']);
  });
});

describe('endChatCall', () => {
  const db = {
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: () => ({ values: async () => undefined }),
  } as unknown as Database;

  it('tears the RTK room down (kick, then end) so nobody stays connected after the call', async () => {
    const kv = fakeKv();
    const env = { WORKSPACE_CACHE: kv } as unknown as CallLifecycleEnv;

    await endChatCall(
      db,
      env,
      'org_1',
      'call_9',
      {
        startedAt: new Date(Date.now() - 60_000),
        cfAppId: 'rtk_9',
        channelId: 'chan_1',
        initiatorId: 'user_a',
        initiatorName: 'A',
        status: 'active',
        // Answered, so no missed-call notification path is involved.
        participants: [
          { userId: 'user_a', joinedAt: '2026-10-02T10:00:00.000Z' },
          { userId: 'user_b', joinedAt: '2026-10-02T10:00:05.000Z' },
        ] as never,
      },
      'user_a',
    );

    expect(rtk.calls).toEqual(['kick:rtk_9', 'end:rtk_9']);
    expect(kv.deleted).toEqual(['rtk-meeting:rtk_9']);
  });
});

// ============================================================================
// Automatic ends ask RealtimeKit first
// ============================================================================

/** Records every `update().set()` and answers `select()` with the given call row. */
function recordingDb(row?: Record<string, unknown>) {
  const sets: Array<Record<string, unknown>> = [];
  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        sets.push(values);
        return { where: async () => undefined };
      },
    }),
    insert: () => ({ values: async () => undefined }),
    select: () => ({
      from: () => ({
        // Awaitable with or without `.limit()`, like a Drizzle query.
        where: () => {
          const rows = row ? [row] : [];
          return Object.assign(Promise.resolve(rows), { limit: async () => rows });
        },
      }),
    }),
  } as unknown as Database;
  return { db, sets, endedAs: () => sets.find((v) => 'endedAt' in v)?.status };
}

const lifecycleEnv = () => ({ WORKSPACE_CACHE: fakeKv() }) as unknown as CallLifecycleEnv;

const member = (userId: string, extra: Record<string, unknown> = {}) => ({
  userId,
  userName: userId,
  joinedAt: '2026-10-05T10:00:00.000Z',
  cfSessionId: `cf_${userId}`,
  hasAudio: false,
  hasVideo: false,
  hasScreenShare: false,
  ...extra,
});

/** A DM call both people joined. */
const answeredCall = (extra: Record<string, unknown> = {}) => ({
  id: 'call_1',
  startedAt: new Date(Date.now() - 60_000),
  cfAppId: 'rtk_1' as string | null,
  channelId: 'chan_1',
  initiatorId: 'user_a',
  initiatorName: 'A',
  status: 'active',
  callType: 'voice',
  participants: [member('user_a'), member('user_b')],
  ...extra,
});

describe('endChatCallIfEmpty', () => {
  it('ends the call when RealtimeKit reports an empty room', async () => {
    const { db, endedAs } = recordingDb();

    const outcome = await endChatCallIfEmpty(db, lifecycleEnv(), 'org_1', 'call_1', answeredCall(), 'user_a');

    expect(outcome).toBe('ended');
    expect(endedAs()).toBe('ended');
    expect(rtk.calls).toEqual(['live:rtk_1', 'kick:rtk_1', 'end:rtk_1']);
  });

  it('keeps a call RealtimeKit still has someone in, whatever our list says', async () => {
    rtk.live = 1;
    const { db, sets } = recordingDb();
    // Our list has drifted: both are recorded as left, one is still talking.
    const call = answeredCall({
      participants: [
        member('user_a', { leftAt: '2026-10-05T10:05:00.000Z' }),
        member('user_b', { leftAt: '2026-10-05T10:04:00.000Z' }),
      ],
    });

    const outcome = await endChatCallIfEmpty(db, lifecycleEnv(), 'org_1', 'call_1', call, 'user_a');

    expect(outcome).toBe('occupied');
    expect(sets).toEqual([]);
    expect(rtk.calls).toEqual(['live:rtk_1']);
  });

  it('keeps the call when RealtimeKit cannot be asked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    rtk.live = new Error('RTK 503');
    const { db, sets } = recordingDb();

    const outcome = await endChatCallIfEmpty(db, lifecycleEnv(), 'org_1', 'call_1', answeredCall(), 'user_a');

    expect(outcome).toBe('unknown');
    expect(sets).toEqual([]);
    expect(rtk.calls).toEqual(['live:rtk_1']);
  });

  it('endWhenAlone ends a room with a single connection, but not one with two', async () => {
    rtk.live = 1;
    const alone = recordingDb();
    expect(
      await endChatCallIfEmpty(alone.db, lifecycleEnv(), 'org_1', 'call_1', answeredCall(), 'user_a', {
        endWhenAlone: true,
      }),
    ).toBe('ended');

    rtk.live = 2;
    const talking = recordingDb();
    expect(
      await endChatCallIfEmpty(talking.db, lifecycleEnv(), 'org_1', 'call_1', answeredCall(), 'user_a', {
        endWhenAlone: true,
      }),
    ).toBe('occupied');
    expect(talking.sets).toEqual([]);
  });

  it('ends a call that never got a RealtimeKit room without asking', async () => {
    const { db, endedAs } = recordingDb();

    const outcome = await endChatCallIfEmpty(
      db,
      lifecycleEnv(),
      'org_1',
      'call_1',
      answeredCall({ cfAppId: null }),
      'user_a',
    );

    expect(outcome).toBe('ended');
    expect(endedAs()).toBe('ended');
    expect(rtk.calls).toEqual([]);
  });

  it('sends the missed-call push for an unanswered DM call, unless told not to', async () => {
    // The row doubles as the DM channel and its other member.
    const { db } = recordingDb({ type: 'dm', userId: 'user_b' });
    const unanswered = answeredCall({ participants: [member('user_a')] });

    vi.mocked(sendMissedCallNotification).mockClear();
    await endChatCallIfEmpty(db, lifecycleEnv(), 'org_1', 'call_1', unanswered, 'user_a');
    expect(sendMissedCallNotification).toHaveBeenCalledTimes(1);

    vi.mocked(sendMissedCallNotification).mockClear();
    await endChatCallIfEmpty(db, lifecycleEnv(), 'org_1', 'call_1', unanswered, 'user_a', {
      sendMissedIfUnanswered: false,
    });
    expect(sendMissedCallNotification).not.toHaveBeenCalled();
  });
});

describe('scheduleRingTimeout', () => {
  const realScheduler = (globalThis as { scheduler?: unknown }).scheduler;

  beforeEach(() => {
    // Skip the 25 s ring window.
    (globalThis as { scheduler?: unknown }).scheduler = { wait: async () => undefined };
  });
  afterEach(() => {
    (globalThis as { scheduler?: unknown }).scheduler = realScheduler;
  });

  /** Runs the timeout to completion and returns what it wrote. */
  async function ringOut(row: Record<string, unknown>) {
    const { db, sets, endedAs } = recordingDb(row);
    let done: Promise<unknown> = Promise.resolve();
    scheduleRingTimeout(
      (p) => {
        done = p;
      },
      db,
      lifecycleEnv(),
      'org_1',
      'call_1',
    );
    await done;
    return { sets, endedAs };
  }

  // start-and-join: the call is 'active' with the caller already in the room.
  const ringing = (extra: Record<string, unknown> = {}) =>
    answeredCall({ participants: [member('user_a')], ...extra });

  it('ends an unanswered call as missed while the caller is still waiting in the room', async () => {
    rtk.live = 1;

    const { endedAs } = await ringOut(ringing());

    expect(endedAs()).toBe('missed');
    expect(rtk.calls).toEqual(['live:rtk_1', 'kick:rtk_1', 'end:rtk_1']);
  });

  it('ends a call nobody connected to at all (rung through POST /, no RealtimeKit session)', async () => {
    rtk.live = 0;

    const { endedAs } = await ringOut(ringing({ status: 'ringing', participants: [] }));

    expect(endedAs()).toBe('missed');
  });

  it('keeps the call when the callee is in the room but our list missed their join', async () => {
    rtk.live = 2;

    const { sets } = await ringOut(ringing());

    expect(sets).toEqual([]);
    expect(rtk.calls).toEqual(['live:rtk_1']);
  });

  it('keeps the call when the callee is recorded as left but is still connected', async () => {
    rtk.live = 2;
    const row = ringing({
      participants: [member('user_a'), member('user_b', { leftAt: '2026-10-05T10:00:10.000Z' })],
    });

    const { sets } = await ringOut(row);

    expect(sets).toEqual([]);
  });

  it('still times the ring out when RealtimeKit cannot be asked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    rtk.live = new Error('RTK 503');

    const { endedAs } = await ringOut(ringing());

    expect(endedAs()).toBe('missed');
  });

  it('leaves an answered call alone without asking RealtimeKit', async () => {
    const { sets } = await ringOut(answeredCall());

    expect(sets).toEqual([]);
    expect(rtk.calls).toEqual([]);
  });
});
