import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import appApi, { type CreditsBalance } from '@/services/app-api';

/** Where credits are bought: in-app purchase is not available yet. */
export const TOP_UP_URL = 'https://app.weldsuite.org';

/** True when the workspace has no credits left to spend (balance at or below zero). */
export function isOutOfCredits(credits: CreditsBalance | null): boolean {
  return credits !== null && (credits.isExhausted || credits.currentBalance <= 0);
}

/**
 * The workspace credit balance, refetched whenever the app returns to the
 * foreground (after topping up in the browser). A failed fetch leaves the
 * balance unknown, and unknown never blocks anything: the server still answers
 * 402 when a turn can't be paid for.
 */
export function useCreditsBalance(): {
  credits: CreditsBalance | null;
  outOfCredits: boolean;
  refresh: () => Promise<void>;
} {
  const [credits, setCredits] = useState<CreditsBalance | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await appApi.credits.balance();
      setCredits(res.data);
    } catch {
      // Balance unknown: leave the previous value alone.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  return { credits, outOfCredits: isOutOfCredits(credits), refresh };
}
