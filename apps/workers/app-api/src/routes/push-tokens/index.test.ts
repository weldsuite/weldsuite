/**
 * Route-level tests for /api/push-tokens. The service layer is mocked —
 * these assert the route wiring, request validation, and response envelope.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pushTokensRoutes } from './index';
import { createTestApp } from '../../test/harness';

vi.mock('../../services/push-tokens', async () => {
  const actual = await vi.importActual<typeof import('../../services/push-tokens')>(
    '../../services/push-tokens',
  );
  return { ...actual, registerPushToken: vi.fn(), unregisterPushToken: vi.fn() };
});

import * as pushTokensService from '../../services/push-tokens';

const mockedRegister = pushTokensService.registerPushToken as ReturnType<typeof vi.fn>;
const mockedUnregister = pushTokensService.unregisterPushToken as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/push-tokens', () => {
  it('200 with the register envelope on a valid body', async () => {
    mockedRegister.mockResolvedValueOnce(undefined);
    const { request } = createTestApp('/api/push-tokens', pushTokensRoutes);
    const res = await request('/api/push-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'ExponentPushToken[abc]',
        platform: 'ios',
        deviceId: 'device_1',
        appCode: 'weldmail',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deviceId: string; registered: boolean } };
    expect(body.data).toEqual({ deviceId: 'device_1', platform: 'ios', registered: true });
    expect(mockedRegister).toHaveBeenCalledOnce();
  });

  it('400 when required fields are missing', async () => {
    const { request } = createTestApp('/api/push-tokens', pushTokensRoutes);
    const res = await request('/api/push-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'ios' }),
    });
    expect(res.status).toBe(400);
    expect(mockedRegister).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/push-tokens', () => {
  it('200 with the unregister envelope when deviceId is supplied', async () => {
    mockedUnregister.mockResolvedValueOnce(undefined);
    const { request } = createTestApp('/api/push-tokens', pushTokensRoutes);
    const res = await request('/api/push-tokens?deviceId=device_1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deviceId: string; unregistered: boolean } };
    expect(body.data).toEqual({ deviceId: 'device_1', unregistered: true });
    expect(mockedUnregister).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'device_1');
  });

  it('400 when deviceId is missing', async () => {
    const { request } = createTestApp('/api/push-tokens', pushTokensRoutes);
    const res = await request('/api/push-tokens', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(mockedUnregister).not.toHaveBeenCalled();
  });
});
