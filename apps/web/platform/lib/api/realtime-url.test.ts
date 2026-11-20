import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ activeWorkspaceId: null as string | null }));
const env = vi.hoisted(() => ({ origin: 'wss://app.example.eu' }));

vi.mock('@/lib/auth', () => ({ getActiveWorkspaceId: () => auth.activeWorkspaceId }));
vi.mock('@/lib/api/public-env', () => ({ getRealtimeWsOrigin: () => env.origin }));

import { realtimeSocketUrl } from './realtime-url';

describe('realtimeSocketUrl', () => {
  afterEach(() => {
    auth.activeWorkspaceId = null;
    env.origin = 'wss://app.example.eu';
  });

  it('leaves the URL alone when the token names the workspace', () => {
    expect(realtimeSocketUrl('/ws')).toBe('wss://app.example.eu/ws');
    expect(realtimeSocketUrl('/ws/conversation/dconv_1')).toBe('wss://app.example.eu/ws/conversation/dconv_1');
  });

  it('names the active workspace in membership mode', () => {
    auth.activeWorkspaceId = 'ws_123';
    expect(realtimeSocketUrl('/ws')).toBe('wss://app.example.eu/ws?workspace=ws_123');
    expect(realtimeSocketUrl('/ws/chat/meet_9')).toBe('wss://app.example.eu/ws/chat/meet_9?workspace=ws_123');
  });

  it('answers an empty URL when the deployment has no realtime', () => {
    env.origin = '';
    auth.activeWorkspaceId = 'ws_123';
    expect(realtimeSocketUrl('/ws')).toBe('');
  });
});
