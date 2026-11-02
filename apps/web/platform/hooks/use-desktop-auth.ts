import { useEffect } from 'react';
import { getAuthProvider } from '@/lib/auth';
import { useSignIn } from '@/lib/auth/clerk';
import { isDesktop } from '@/lib/desktop';
import { onDesktopAuthCallback } from '@/lib/desktop-auth';

/**
 * Listens for `weldsuite://auth?ticket=...` deep links after a browser
 * sign-in handoff, and completes the Clerk session using the ticket strategy.
 *
 * Mount once near the root of the desktop app (e.g. the auth layout).
 */
interface DesktopAuthOptions {
  onSuccess?: () => void;
  onError?: (message: string) => void;
}

/** The desktop sign-in ticket is a Clerk sign-in token: nothing to listen for on other providers. */
function useNoDesktopAuth(_options?: DesktopAuthOptions): void {
  // Other providers hand the desktop shell their own session (not built yet).
}

export function useDesktopAuthHandler(options?: DesktopAuthOptions): void {
  const useHandler = getAuthProvider() === 'clerk' ? useClerkDesktopAuth : useNoDesktopAuth;
  useHandler(options);
}

function useClerkDesktopAuth(options?: DesktopAuthOptions): void {
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