import { useEffect } from 'react';
import { onLeaveServer } from '@weldsuite/mobile-platform/runtime';

/**
 * When the app leaves a server (switching to another, weldsuite-documentation/plans/mobile-server-choice.md),
 * remove this device's push token there so that server stops pushing here.
 * Runs while the person is still signed in on the old server.
 *
 * @param getCredentials - the session's credentials (`useAuthSession().getCredentials`)
 * @param unregister - `unregisterDeviceToken` from `@weldsuite/mobile-ui/services/notifications`,
 *   or null where push isn't available (Expo Go)
 */
export function useUnregisterPushOnServerLeave(
  getCredentials: () => Promise<{ accessToken: string } | null>,
  unregister: ((accessToken: string, apiBaseUrl?: string) => Promise<unknown>) | null | undefined,
): void {
  useEffect(
    () =>
      onLeaveServer('push-token', async (runtime) => {
        if (!runtime.pushEnabled || !unregister) return;
        const credentials = await getCredentials();
        if (credentials?.accessToken) await unregister(credentials.accessToken, runtime.apiOrigin);
      }),
    [getCredentials, unregister],
  );
}
