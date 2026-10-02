import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('@weldsuite/cloudflare-realtime', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/cloudflare-realtime')>(
    '@weldsuite/cloudflare-realtime',
  );
  return {
    ...actual,
    ensurePresets: vi.fn(async () => undefined),
    createMeeting: vi.fn(async () => ({ id: 'rtk_start_instant' })),
    addParticipant: vi.fn(async () => ({ id: 'rtk_part_1', token: 'auth-token' })),
  };
});

import { startInstantMeeting } from './start-instant';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { fakeKv } from '../../test/fakes';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('startInstantMeeting', () => {
  it('creates the meeting with an mtg_ id like every other meeting, and a running session', async () => {
    const kv = fakeKv();
    const result = await startInstantMeeting(
      db,
      { CF_ACCOUNT_ID: 'acc', CF_REALTIME_APP_ID: 'app', CF_REALTIME_APP_SECRET: 'secret', WORKSPACE_CACHE: kv },
      { waitUntil: (p: Promise<unknown>) => void p },
      {
        userId: 'user_instant',
        orgId: 'org_instant',
        user: { name: 'Insta Host', email: 'host@example.com' },
        input: {},
      },
    );

    expect(result.meetingId).toMatch(/^mtg_/);
    expect(result.sessionId).toMatch(/^msess_/);

    const [meeting] = await db
      .select()
      .from(schema.meetings)
      .where(eq(schema.meetings.id, result.meetingId))
      .limit(1);
    expect(meeting?.status).toBe('in_progress');
    expect(meeting?.organizerId).toBe('user_instant');
    expect(meeting?.activeSessionId).toBe(result.sessionId);
    expect(meeting?.attendees?.[0]).toMatchObject({ userId: 'user_instant', role: 'organizer' });
  });
});
