import { describe, it, expect, vi, beforeEach } from 'vitest';

const rtk = vi.hoisted(() => ({
  calls: [] as string[],
  kickError: null as Error | null,
  endError: null as Error | null,
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
}));

vi.mock('@weldsuite/notifications', () => ({
  sendMissedCallNotification: vi.fn(async () => undefined),
}));

vi.mock('./realtime/weldchat-call-publisher', () => ({
  publishChatCallEnded: vi.fn(async () => undefined),
  broadcastChatCallToMembers: vi.fn(async () => undefined),
}));

import { endChatCall, teardownRtkMeeting, type CallLifecycleEnv } from './call-lifecycle';
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
