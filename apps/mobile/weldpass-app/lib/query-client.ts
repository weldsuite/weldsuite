/**
 * TanStack Query for WeldPass. WeldPass publishes no realtime events, so
 * lists refresh when the app comes back to the foreground (focus) and after
 * every write. Revealed secrets never go through the cache: screens keep them
 * in component state only.
 */

import { focusManager, QueryClient } from '@tanstack/react-query';
import { AppState, Platform, type AppStateStatus } from 'react-native';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 30 * 60_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

/** Wire React Native's foreground to TanStack Query's focus. Returns the unsubscribe. */
export function trackAppFocus(): () => void {
  const subscription = AppState.addEventListener('change', (status: AppStateStatus) => {
    if (Platform.OS !== 'web') focusManager.setFocused(status === 'active');
  });
  return () => subscription.remove();
}
