import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatCallParticipant } from '@weldsuite/db/schema/chat-calls';

const log = vi.hoisted(() => ({
  calls: [] as string[],
  removeError: null as Error | null,
  publishError: null as Error | null,
}));

vi.mock('@weldsuite/cloudflare-realtime', () => ({
  removeParticipant: vi.fn(async (_env: unknown, meetingId: string, participantId: string) => {
    log.calls.push(`remove:${meetingId}:${participantId}`);
    if (log.removeError) throw log.removeError;
  }),
  endMeeting: vi.fn(),
  getLiveParticipantCount: vi.fn(),
  kickAllParticipants: vi.fn(),
}));

vi.mock('@weldsuite/notifications', () => ({
  sendMissedCallNotification: vi.fn(async () => undefined),
}));

vi.mock('./realtime/weldchat-call-publisher', () => ({
  publishChatCallParticipantLeft: vi.fn(async () => undefined),
  publishChatCallEnded: vi.fn(async () => undefined),
  broadcastChatCallToMembers: vi.fn(async () => undefined),
  publishChatCallSuperseded: vi.fn(
    async (_env: unknown, orgId: string, userId: string, data: { kind: string; id: string; cfSessionId?: string | null }) => {
      log.calls.push(`superseded:${orgId}:${userId}:${data.kind}:${data.id}:${String(data.cfSessionId)}`);
      if (log.publishError) throw log.publishError;
    },
  ),
}));

import { evictRtkSessions, upsertParticipant } from './call-participants';

beforeEach(() => {
  log.calls.length = 0;
  log.removeError = null;
  log.publishError = null;
});

function participant(userId: string, cfSessionId: string, extra: Partial<ChatCallParticipant> = {}): ChatCallParticipant {
  return {
    userId,
    userName: userId,
    joinedAt: '2026-10-09T10:00:00.000Z',
    cfSessionId,
    hasAudio: false,
    hasVideo: false,
    hasScreenShare: false,
    ...extra,
  };
}

describe('upsertParticipant', () => {
  it('keeps one entry per user and surfaces the older live session, never the new one', () => {
    const { next, staleSessionIds } = upsertParticipant(
      [participant('u1', 'cf_old'), participant('u2', 'cf_u2')],
      participant('u1', 'cf_new'),
    );

    expect(staleSessionIds).toEqual(['cf_old']);
    expect(next.filter((p) => p.userId === 'u1')).toHaveLength(1);
    expect(next.find((p) => p.userId === 'u1')?.cfSessionId).toBe('cf_new');
  });

  it('has nothing to evict when the previous entry left or carries the same id', () => {
    expect(upsertParticipant([participant('u1', 'cf_old', { leftAt: '2026-10-09T10:05:00.000Z' })], participant('u1', 'cf_new')).staleSessionIds).toEqual([]);
    expect(upsertParticipant([participant('u1', 'cf_same')], participant('u1', 'cf_same')).staleSessionIds).toEqual([]);
  });
});

describe('evictRtkSessions', () => {
  const env = {} as Parameters<typeof evictRtkSessions>[0];

  it('removes each session', async () => {
    await evictRtkSessions(env, 'rtk_1', ['cf_a', 'cf_b']);

    expect(log.calls.sort()).toEqual(['remove:rtk_1:cf_a', 'remove:rtk_1:cf_b']);
  });

  it('with notify, announces call_superseded for every session BEFORE removing it', async () => {
    await evictRtkSessions(env, 'rtk_1', ['cf_a'], { orgId: 'org_1', userId: 'u1', callId: 'call_1' });

    expect(log.calls).toEqual(['superseded:org_1:u1:chat:call_1:cf_a', 'remove:rtk_1:cf_a']);
  });

  it('still removes the session when the announcement fails, and never throws', async () => {
    log.publishError = new Error('realtime down');

    await expect(
      evictRtkSessions(env, 'rtk_1', ['cf_a'], { orgId: 'org_1', userId: 'u1', callId: 'call_1' }),
    ).resolves.toBeUndefined();

    expect(log.calls).toContain('remove:rtk_1:cf_a');
  });

  it('swallows a failed removal', async () => {
    log.removeError = new Error('RTK 404');

    await expect(evictRtkSessions(env, 'rtk_1', ['cf_a'])).resolves.toBeUndefined();
  });

  it('does nothing without a meeting or without sessions', async () => {
    await evictRtkSessions(env, null, ['cf_a'], { orgId: 'org_1', userId: 'u1', callId: 'call_1' });
    await evictRtkSessions(env, 'rtk_1', []);

    expect(log.calls).toEqual([]);
  });
});
