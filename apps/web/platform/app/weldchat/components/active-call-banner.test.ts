import { describe, expect, it, vi } from 'vitest';

vi.mock('@/contexts/weldchat-call-context', () => ({ useWeldChatCall: () => ({}) }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApiClient: () => ({}) }));
vi.mock('@/lib/i18n/provider', () => ({ useI18n: () => ({ t: {} }) }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({}) }));

import { showsActiveCallBar } from './active-call-banner';

const ME = 'user_me';
interface TestCall {
  id: string;
  status: string;
  participants: Array<{ userId: string; joinedAt: string; leftAt?: string }>;
}

const call = (overrides: Partial<TestCall> = {}): TestCall => ({
  id: 'call_1',
  status: 'active',
  participants: [
    { userId: ME, joinedAt: '2026-11-21T14:00:00Z' },
    { userId: 'user_gert', joinedAt: '2026-11-21T14:00:05Z' },
  ],
  ...overrides,
});

describe('showsActiveCallBar', () => {
  it('shows for a call going on with me in it, which this tab is not connected to', () => {
    expect(showsActiveCallBar(call(), ME, null)).toBe(true);
  });

  it('hides while this tab is in that call', () => {
    expect(showsActiveCallBar(call(), ME, 'call_1')).toBe(false);
  });

  it('hides for a call that only rings, or has ended', () => {
    expect(showsActiveCallBar(call({ status: 'ringing' }), ME, null)).toBe(false);
    expect(showsActiveCallBar(call({ status: 'ended' }), ME, null)).toBe(false);
    expect(showsActiveCallBar(null, ME, null)).toBe(false);
  });

  it('hides once I left the call, and for a call I am not in', () => {
    expect(
      showsActiveCallBar(
        call({ participants: [{ userId: ME, joinedAt: '2026-11-21T14:00:00Z', leftAt: '2026-11-21T14:01:00Z' }] }),
        ME,
        null,
      ),
    ).toBe(false);
    expect(showsActiveCallBar(call({ participants: [{ userId: 'user_gert', joinedAt: '2026-11-21T14:00:05Z' }] }), ME, null)).toBe(false);
  });
});
