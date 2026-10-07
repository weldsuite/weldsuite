import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { handleCalendarCreateEvent } from './google-calendar';
import { makeActionContext } from '../../../test/ctx';
import { createPgliteDb } from '../../../test/pglite';
import { schema, type Database } from '../../../db';
import { generateId } from '../../../lib/id';
import { NonRetryableStepError } from '../../errors';

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('google_calendar.create_event (pglite + stubbed Calendar API)', () => {
  let db: Database;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    await db.insert(schema.workspaceMembers).values({ id: 'wm_owner_1', userId: 'owner_1' });
    await db.insert(schema.workflowIntegrations).values({
      id: generateId('win'),
      name: 'Google Calendar',
      type: 'google_calendar',
      status: 'connected',
      oauthTokens: { accessToken: 'ya29-test' },
    });
  });

  it('rejects without summary, start, or end before calling Calendar', async () => {
    const { mock } = stubFetch(() => new Response('{}'));
    await expect(
      handleCalendarCreateEvent({ startDateTime: '2026-07-01T09:00:00Z', endDateTime: '2026-07-01T10:00:00Z' }, makeActionContext({ db })),
    ).rejects.toThrow(NonRetryableStepError);
    await expect(
      handleCalendarCreateEvent({ summary: 'Sync' }, makeActionContext({ db })),
    ).rejects.toThrow(/start and end/i);
    expect(mock).not.toHaveBeenCalled();
  });

  it('requires timeZone when start/end have no UTC offset', async () => {
    const { mock } = stubFetch(() => new Response('{}'));
    await expect(
      handleCalendarCreateEvent(
        { summary: 'Sync', startDateTime: '2026-07-01T09:00:00', endDateTime: '2026-07-01T10:00:00' },
        makeActionContext({ db }),
      ),
    ).rejects.toThrow(/timeZone/i);
    expect(mock).not.toHaveBeenCalled();
  });

  it('creates an event with a Z-suffixed start/end and no timeZone', async () => {
    const { calls } = stubFetch(() =>
      new Response(JSON.stringify({ id: 'evt1', htmlLink: 'https://calendar.google.com/evt1' }), { status: 200 }),
    );
    const result = await handleCalendarCreateEvent(
      { summary: 'Sync', startDateTime: '2026-07-01T09:00:00Z', endDateTime: '2026-07-01T10:00:00Z' },
      makeActionContext({ db }),
    );
    expect(result).toEqual({ ok: true, id: 'evt1', htmlLink: 'https://calendar.google.com/evt1' });
    expect(calls[0].url).toContain('/calendars/primary/events');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.start).toEqual({ dateTime: '2026-07-01T09:00:00Z', timeZone: undefined });
  });

  it('creates an event with an explicit timeZone and attendees', async () => {
    const { calls } = stubFetch(() => new Response(JSON.stringify({ id: 'evt2' }), { status: 200 }));
    await handleCalendarCreateEvent(
      {
        summary: 'Sync',
        startDateTime: '2026-07-01T09:00:00',
        endDateTime: '2026-07-01T10:00:00',
        timeZone: 'Europe/Amsterdam',
        attendees: 'jane@acme.com, john@acme.com',
        calendarId: 'team@acme.com',
      },
      makeActionContext({ db }),
    );
    expect(calls[0].url).toContain(encodeURIComponent('team@acme.com'));
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.start).toEqual({ dateTime: '2026-07-01T09:00:00', timeZone: 'Europe/Amsterdam' });
    expect(body.attendees).toEqual([{ email: 'jane@acme.com' }, { email: 'john@acme.com' }]);
  });

  it('rejects an invalid attendee address before calling Calendar', async () => {
    const { mock } = stubFetch(() => new Response('{}'));
    await expect(
      handleCalendarCreateEvent(
        {
          summary: 'Sync',
          startDateTime: '2026-07-01T09:00:00Z',
          endDateTime: '2026-07-01T10:00:00Z',
          attendees: 'not-an-email',
        },
        makeActionContext({ db }),
      ),
    ).rejects.toThrow(/not valid/);
    expect(mock).not.toHaveBeenCalled();
  });

  describe('error mapping (shared ./google-errors.ts)', () => {
    it('maps a 404 (bad calendarId) to a non-retryable error', async () => {
      stubFetch(() => new Response(JSON.stringify({ error: { message: 'Not Found' } }), { status: 404 }));
      await expect(
        handleCalendarCreateEvent(
          { summary: 'Sync', startDateTime: '2026-07-01T09:00:00Z', endDateTime: '2026-07-01T10:00:00Z', calendarId: 'missing' },
          makeActionContext({ db }),
        ),
      ).rejects.toThrow(NonRetryableStepError);
    });

    it('maps a 429 to a retryable error with the Retry-After hint', async () => {
      stubFetch(
        () =>
          new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
            status: 429,
            headers: { 'Retry-After': '10' },
          }),
      );
      const promise = handleCalendarCreateEvent(
        { summary: 'Sync', startDateTime: '2026-07-01T09:00:00Z', endDateTime: '2026-07-01T10:00:00Z' },
        makeActionContext({ db }),
      );
      await expect(promise).rejects.not.toThrow(NonRetryableStepError);
      await expect(promise).rejects.toThrow(/retry after 10s/i);
    });
  });

  describe('owner membership (shared by every provider action via providers/token.ts)', () => {
    it('refuses once the workflow owner has left the workspace', async () => {
      stubFetch(() => new Response(JSON.stringify({ id: 'evt' }), { status: 200 }));
      const ctx = makeActionContext({
        db,
        tenant: { workspaceId: 'ws_test', userId: 'user_test', ownerUserId: 'owner_gone' },
      });
      await expect(
        handleCalendarCreateEvent(
          { summary: 'Sync', startDateTime: '2026-07-01T09:00:00Z', endDateTime: '2026-07-01T10:00:00Z' },
          ctx,
        ),
      ).rejects.toThrow(/no longer a member/i);
    });
  });
});
