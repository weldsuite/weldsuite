import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const clerk = vi.hoisted(() => ({ confirmations: 0, twoFactorEnabled: false }));
// Clerk's hook, as it behaves: a returned reverification hint opens the dialog
// (here: confirmed at once) and the call is made one more time.
vi.mock('@clerk/clerk-react', () => ({
  useUser: () => ({ user: { twoFactorEnabled: clerk.twoFactorEnabled } }),
  useReverification:
    <A extends unknown[], R>(fetcher: (...args: A) => Promise<R>) =>
    async (...args: A) => {
      const first = await fetcher(...args);
      if (!first || typeof first !== 'object' || !('clerk_error' in first)) return first;
      clerk.confirmations += 1;
      return fetcher(...args);
    },
}));

import { useWithSecondFactor } from './use-second-factor';

function requestError(status: number, code: string) {
  return Object.assign(new Error(code), { status, code });
}

describe('useWithSecondFactor', () => {
  it('passes a call through when books-api accepts it', async () => {
    const call = vi.fn(async (value: string) => `ok:${value}`);
    const { result } = renderHook(() => useWithSecondFactor(call));
    expect(await result.current('a')).toBe('ok:a');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('asks for the second factor when books-api wants a fresh one, then makes the call again', async () => {
    clerk.confirmations = 0;
    const call = vi
      .fn<(value: string) => Promise<string>>()
      .mockRejectedValueOnce(requestError(403, 'REVERIFICATION_REQUIRED'))
      .mockResolvedValueOnce('ok');
    const { result } = renderHook(() => useWithSecondFactor(call));

    expect(await result.current('a')).toBe('ok');
    expect(clerk.confirmations).toBe(1);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('asks for the code of a user who has a second factor but did not use it this session', async () => {
    // Signed in with a passkey, or set up the authenticator app after signing in.
    clerk.confirmations = 0;
    clerk.twoFactorEnabled = true;
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(requestError(403, 'MFA_REQUIRED'))
      .mockResolvedValueOnce('ok');
    const { result } = renderHook(() => useWithSecondFactor(call));

    expect(await result.current()).toBe('ok');
    expect(clerk.confirmations).toBe(1);
    clerk.twoFactorEnabled = false;
  });

  it('reports a confirmation books-api still refuses, and leaves other errors alone', async () => {
    const refused = vi.fn(async () => {
      throw requestError(403, 'REVERIFICATION_REQUIRED');
    });
    const { result } = renderHook(() => useWithSecondFactor(refused));
    await expect(result.current()).rejects.toMatchObject({ status: 403, code: 'REVERIFICATION_REQUIRED' });

    const noMfa = vi.fn(async () => {
      throw requestError(403, 'MFA_REQUIRED');
    });
    const other = renderHook(() => useWithSecondFactor(noMfa));
    await expect(other.result.current()).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    expect(noMfa).toHaveBeenCalledTimes(1);
  });
});
