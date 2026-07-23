import { useEffect } from 'react';
import { useSignIn } from '@clerk/clerk-react';
import { getDesktop, isDesktop } from '@/lib/desktop';
import { onDesktopAuthCallback, startExternalSignIn } from '@/lib/desktop-auth';

/**
 * Listens for `weldsuite://auth?ticket=...` deep links after a browser
 * sign-in handoff, and completes the Clerk session using the ticket strategy.
 *
 * Mount once near the root of the desktop app (e.g. the auth layout).
 */
export function useDesktopAuthHandler(options?: {
  onSuccess?: () => void;
  onError?: (message: string) => void;
}) {
  const { signIn, setActive, isLoaded } = useSignIn();

  useEffect(() => {
    if (!isDesktop() || !isLoaded) return;

    const unsub = onDesktopAuthCallback(async ({ params }) => {
      if (params.status === 'error') {
        options?.onError?.(params.message ?? 'Sign-in failed.');
        return;
      }

      const ticket = params.ticket ?? params.token;
      if (!ticket) {
        options?.onError?.('Sign-in callback missing ticket.');
        return;
      }

      try {
        const result = await signIn.create({ strategy: 'ticket', ticket });
        if (result.status === 'complete' && result.createdSessionId) {
          await setActive({ session: result.createdSessionId });
          options?.onSuccess?.();
          return;
        }
        options?.onError?.(`Unexpected sign-in status: ${result.status}`);
      } catch (err) {
        options?.onError?.(err instanceof Error ? err.message : 'Sign-in failed.');
      }
    });

    return unsub;
  }, [isLoaded, signIn, setActive, options]);
}

/**
 * On desktop, immediately opens the sign-in flow in the user's default
 * browser and keeps the Electron window idle. On web, no-op.
 */
function useRedirectSignInToBrowser(path?: string) {
  useEffect(() => {
    if (isDesktop()) {
      void startExternalSignIn({ path });
    }
  }, [path]);
}

function useReopenInBrowser() {
  const desktop = getDesktop();
  return async (path: string = '/sign-in') => desktop?.signInExternally({ path });
}
