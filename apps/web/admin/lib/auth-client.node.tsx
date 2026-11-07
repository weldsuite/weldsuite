import { Fragment } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { adminCopy } from './i18n';
import type * as Clerk from './auth-client';

/**
 * The Node version of `auth-client.tsx`, for the console on Kubernetes (ADR
 * FE-018). The Node build (`pnpm build:node`) resolves `@/lib/auth-client`
 * to this file (vite.config.ts). Staff will sign in with the install's
 * Zitadel; until that lands the server lets nobody in
 * (`lib/server/identity.node.ts`), and the sign-in page says so.
 */

export const AuthProvider: typeof Clerk.AuthProvider = ({ children }) => <Fragment>{children}</Fragment>;

export const SignInScreen: typeof Clerk.SignInScreen = () => {
  const t = adminCopy().signIn;
  return (
    <Card className="w-full max-w-md py-8">
      <CardContent className="space-y-4 px-8 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
          <ShieldAlert className="h-6 w-6 text-amber-600 dark:text-amber-400" />
        </div>
        <h1 className="text-lg font-semibold">{t.unavailableTitle}</h1>
        <p className="text-sm text-muted-foreground">{t.unavailableBody}</p>
      </CardContent>
    </Card>
  );
};

/** Back to the sign-in page; there is no session to end yet. */
export const useSignOut: typeof Clerk.useSignOut = () => () => {
  window.location.assign('/sign-in');
};

/** Only the support inbox asks, and it is Global's. */
export const useStaffProfile: typeof Clerk.useStaffProfile = () => ({
  name: null,
  imageUrl: null,
  getToken: async () => '',
});
