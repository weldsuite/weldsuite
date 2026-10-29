import { describe, expect, it } from 'vitest';
import { maskVolatile } from './conformance-volatile';

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
