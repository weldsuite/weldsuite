import { describe, expect, it } from 'vitest';
import { NOW, PROJECT_ID, WORKSPACE_ID } from '../testing/fakes';
import { IMPORT_MAX_AGE_MS, TRACK_MAX_AGE_MS, buildServerEventRows, serverEventTime } from './server-rows';

const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

describe('serverEventTime', () => {
  it('keeps a time inside the window as it is', () => {
    expect(serverEventTime(iso(NOW - DAY), NOW, TRACK_MAX_AGE_MS)).toBe(NOW - DAY);
  });

  it('moves a minute of clock skew back to now and refuses further ahead', () => {
    expect(serverEventTime(iso(NOW + 59 * 1000), NOW, TRACK_MAX_AGE_MS)).toBe(NOW);
    expect(serverEventTime(iso(NOW + 61 * 1000), NOW, TRACK_MAX_AGE_MS)).toBeNull();
  });

  it('refuses a time older than the window of the endpoint', () => {
    expect(serverEventTime(iso(NOW - 7 * DAY - 1), NOW, TRACK_MAX_AGE_MS)).toBeNull();
    expect(serverEventTime(iso(NOW - 7 * DAY - 1), NOW, IMPORT_MAX_AGE_MS)).toBe(NOW - 7 * DAY - 1);
    expect(serverEventTime(iso(NOW - 5 * 365 * DAY - 1), NOW, IMPORT_MAX_AGE_MS)).toBeNull();
  });
});

describe('buildServerEventRows', () => {
  const batch = (events: object[]) => ({
    lib: 'server' as const,
    lib_version: '1.2.3',
    events: events.map((e) => ({ event_id: 'evt-00000001', name: 'Paid', ts: iso(NOW), distinct_id: 'd-1', ...e })),
  });

  it('writes the caller-named visitor and leaves the browser columns null', () => {
    const { rows, dropped } = buildServerEventRows({
      record: { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
      batch: batch([{ user_id: 'u-1', anon_id: 'a-1' }]),
      receivedAt: NOW,
      maxAgeMs: TRACK_MAX_AGE_MS,
    });

    expect(dropped).toBe(0);
    expect(rows[0]).toMatchObject({ distinct_id: 'd-1', user_id: 'u-1', anon_id: 'a-1', cookieless: false, session_id: null, device_type: null, lib: 'server', lib_version: '1.2.3', properties: '{}' });
  });

  it('uses the distinct id as anonymous id when none is given', () => {
    const { rows } = buildServerEventRows({ record: { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID }, batch: batch([{}]), receivedAt: NOW, maxAgeMs: TRACK_MAX_AGE_MS });
    expect(rows[0]).toMatchObject({ anon_id: 'd-1', user_id: null });
  });

  it('gives empty url columns when there is no (usable) url', () => {
    const { rows } = buildServerEventRows({
      record: { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
      batch: batch([{ url: 'ftp://example.com/x' }, {}]),
      receivedAt: NOW,
      maxAgeMs: TRACK_MAX_AGE_MS,
    });
    expect(rows.map((r) => [r.url, r.host, r.path])).toEqual([['', '', ''], ['', '', '']]);
  });
});
