import { describe, it, expect, vi, beforeEach } from 'vitest';

const rtk = vi.hoisted(() => ({
  calls: [] as string[],
  removeError: null as Error | null,
}));

vi.mock('@weldsuite/cloudflare-realtime', () => ({
  removeParticipant: vi.fn(async (_env: unknown, meetingId: string, participantId: string) => {
    rtk.calls.push(`remove:${meetingId}:${participantId}`);
    if (rtk.removeError) throw rtk.removeError;
  }),
  endMeeting: vi.fn(),
  getLiveParticipantCount: vi.fn(),
  kickAllParticipants: vi.fn(),
}));

import { evictSupersededConnection, supersededCfSessionId } from './leave-other-sessions';

beforeEach(() => {
  rtk.calls.length = 0;
  rtk.removeError = null;
});

describe('supersededCfSessionId', () => {
  it('returns the older live connection of the user', () => {
    expect(supersededCfSessionId({ cfSessionId: 'cf_old' }, 'cf_new')).toBe('cf_old');
  });

  it('never returns the connection that was just created', () => {
    expect(supersededCfSessionId({ cfSessionId: 'cf_new' }, 'cf_new')).toBeNull();
  });

  it('has nothing to evict without a previous entry, for an entry that left, or without an id', () => {
    expect(supersededCfSessionId(undefined, 'cf_new')).toBeNull();
    expect(supersededCfSessionId({ cfSessionId: 'cf_old', leftAt: '2026-10-09T10:00:00.000Z' }, 'cf_new')).toBeNull();
    expect(supersededCfSessionId({ cfSessionId: '' }, 'cf_new')).toBeNull();
  });
});

describe('evictSupersededConnection', () => {
  const session = { id: 'msess_1', meetingId: 'mtg_1', cfAppId: 'rtk_1' };

  /** A REALTIME binding that records each publish into the same log as the RTK calls. */
  function env() {
    return {
      REALTIME: {
        fetch: vi.fn(async (_url: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { topic: string; event: string; data: Record<string, unknown> };
          rtk.calls.push(`publish:${body.topic}:${body.event}:${String(body.data.cfSessionId)}`);
          return new Response('{}');
        }),
      },
    } as unknown as Parameters<typeof evictSupersededConnection>[0];
  }

  it('announces call_superseded on the user topic BEFORE it removes the old RealtimeKit participant', async () => {
    await evictSupersededConnection(env(), 'org_1', 'user_1', session, 'cf_old');

    expect(rtk.calls).toEqual(['publish:chat.user.user_1:call_superseded:cf_old', 'remove:rtk_1:cf_old']);
  });

  it('still removes the participant when the announcement fails, and never throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = {
      REALTIME: { fetch: vi.fn(async () => new Response('nope', { status: 500 })) },
    } as unknown as Parameters<typeof evictSupersededConnection>[0];

    await expect(evictSupersededConnection(failing, 'org_1', 'user_1', session, 'cf_old')).resolves.toBeUndefined();

    expect(rtk.calls).toEqual(['remove:rtk_1:cf_old']);
  });

  it('swallows a failed removal (the participant may already be gone)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    rtk.removeError = new Error('RTK 404');

    await expect(
      evictSupersededConnection(env(), 'org_1', 'user_1', session, 'cf_old'),
    ).resolves.toBeUndefined();
  });

  it('removes nothing from a session without a RealtimeKit meeting', async () => {
    await evictSupersededConnection(env(), 'org_1', 'user_1', { ...session, cfAppId: null }, 'cf_old');

    expect(rtk.calls.filter((c) => c.startsWith('remove:'))).toEqual([]);
  });
});
