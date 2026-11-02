import { describe, expect, it } from 'vitest';
import { maskVolatile, maskVolatileEvents } from './conformance-volatile';

describe('maskVolatile', () => {
  it("masks a route's per-run values and keeps their type", () => {
    const body = { data: { deviceCode: 'ab12', userCode: 'ABCD-EFGH', verificationUriComplete: 'x', expiresIn: 600 } };
    expect(maskVolatile('POST', '/api/cli-auth/device', body)).toEqual({
      data: {
        deviceCode: '<volatile:string>',
        userCode: '<volatile:string>',
        verificationUriComplete: '<volatile:string>',
        expiresIn: 600,
      },
    });
    expect(maskVolatile('POST', '/api/auth-desktop/ticket', { data: { expiresAt: 1_800_000_000_000 } })).toEqual({
      data: { expiresAt: '<volatile:number>' },
    });
  });

  it('masks only the matching part of a string with a pattern', () => {
    const body = { data: { path: '/public/user-apps/app/s/123.d3M.sig/index.html', signed: true } };
    expect(maskVolatile('POST', '/api/user-apps/code/:code/bundle-url', body)).toEqual({
      data: { path: '/public/user-apps/app/s/<volatile>/index.html', signed: true },
    });
    expect(
      maskVolatile('POST', '/api/user-apps/:id/versions', { data: { bundleKey: 'user-apps/uapp_x/uav_abc123def456' } }),
    ).toEqual({ data: { bundleKey: 'user-apps/uapp_x/<id>' } });
  });

  it("masks the widget worker's realtime token and health timestamp at the prefixed routes", () => {
    const token = { success: true, data: { token: 'a.b.c', expiresIn: 3600 } };
    expect(maskVolatile('POST', '/public/helpdesk-widget/api/realtime/token', token)).toEqual({
      success: true,
      data: { token: '<volatile:string>', expiresIn: 3600 },
    });
    // desk-api has no such route: the unprefixed path is never masked.
    expect(maskVolatile('POST', '/api/realtime/token', token)).toBe(token);
    expect(
      maskVolatile('GET', '/public/helpdesk-widget/health', { status: 'ok', environment: 'test', timestamp: '2026-01-01T00:00:00.000Z' }),
    ).toEqual({ status: 'ok', environment: 'test', timestamp: '<volatile:string>' });
  });

  it("masks a stopped timer's sub-minute duration in the answer and its event, keeping the minutes", () => {
    const stopped = { data: { id: 'te_1', duration: '10.03', cost: null } };
    expect(maskVolatile('POST', '/api/time-entries/timer/stop', stopped)).toEqual({
      data: { id: 'te_1', duration: '10.<volatile>', cost: null },
    });
    const events = [{ entityType: 'project_time_entry', action: 'created', data: { duration: '10.04' } }];
    expect(maskVolatileEvents('POST', '/api/time-entries/timer/stop', events)).toEqual([
      { entityType: 'project_time_entry', action: 'created', data: { duration: '10.<volatile>' } },
    ]);
    // The same duration in seconds and hours ticks too, and keeps its type.
    const analytics = [{ entityType: 'project_time_entry', data: { durationSeconds: 302, actualHours: 0.08 } }];
    expect(maskVolatileEvents('POST', '/api/time-entries/timer/stop', analytics)).toEqual([
      { entityType: 'project_time_entry', data: { durationSeconds: '<volatile:number>', actualHours: '<volatile:number>' } },
    ]);
    // A different number of minutes still differs.
    expect(maskVolatile('POST', '/api/time-entries/timer/stop', { data: { duration: '11.00' } })).toEqual({
      data: { duration: '11.<volatile>' },
    });
    // Routes without event paths leave events as they are.
    expect(maskVolatileEvents('POST', '/api/cli-auth/device', events)).toBe(events);
    expect(maskVolatileEvents('POST', null, events)).toBe(events);
  });

  it('leaves other routes, methods and missing paths alone', () => {
    const body = { data: { deviceCode: 'ab12' } };
    expect(maskVolatile('GET', '/api/cli-auth/device', body)).toBe(body);
    expect(maskVolatile('POST', '/api/other', body)).toBe(body);
    expect(maskVolatile('POST', null, body)).toBe(body);
    expect(maskVolatile('POST', '/api/cli-auth/approve', { error: { code: 'BAD_REQUEST' } })).toEqual({
      error: { code: 'BAD_REQUEST' },
    });
  });
});
