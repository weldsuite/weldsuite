import { useCallback, type ReactNode } from 'react';
import { ClerkProvider, SignIn, useAuth, useClerk, useUser } from '@clerk/tanstack-react-start';

/**
 * The browser side of signing in: the console's own invite-only Clerk
 * instance on Global (ADR SEC-009). The Node build for Kubernetes resolves
 * this module to `auth-client.node.tsx` (vite.config.ts), so no Clerk code
 * reaches it. Components use these, never `@clerk/*` directly.
 */

export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  return <ClerkProvider>{children}</ClerkProvider>;
}

/** The sign-in page's body. Clerk returns to `redirect_url` afterwards. */
export function SignInScreen() {
  return <SignIn routing="path" path="/sign-in" fallbackRedirectUrl="/" />;
}

/** Ends the session and leaves the console. */
export function useSignOut(): () => void {
  const { signOut } = useClerk();
  return useCallback(() => void signOut(), [signOut]);
}

/** The signed-in person as the support inbox shows them, and a token for the realtime worker. */
export function useStaffProfile(): { name: string | null; imageUrl: string | null; getToken: () => Promise<string> } {
  const { getToken } = useAuth();
  const { user } = useUser();
  const token = useCallback(async () => (await getToken()) || '', [getToken]);
  return {
    name: user?.fullName || user?.firstName || null,
    imageUrl: user?.imageUrl ?? null,
    getToken: token,
  };
}
