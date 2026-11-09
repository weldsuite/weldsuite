import { Fragment, useCallback } from 'react';
import { useLocation } from '@tanstack/react-router';
import { LogIn, ShieldAlert } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { adminCopy } from './i18n';
import type * as Clerk from './auth-client';

/**
 * The Node version of `auth-client.tsx`, for the console on Kubernetes (ADR
 * FE-018). The Node build (`pnpm build:node`) resolves `@/lib/auth-client`
 * to this file (vite.config.ts). Staff sign in at the install's identity
 * provider through the console's own `/auth/*` endpoints
 * (`lib/server/auth-routes.ts`), so there is nothing to provide here.
 */

export const AuthProvider: typeof Clerk.AuthProvider = ({ children }) => <Fragment>{children}</Fragment>;

/** Straight to the provider: `/auth/sign-in` is a server endpoint, not a page, so the document reloads. */
export const signInRedirect: typeof Clerk.signInRedirect = (returnTo) => ({
  href: `/auth/sign-in?redirect_url=${encodeURIComponent(returnTo)}`,
  reloadDocument: true,
});

/** The landing page after signing out or a failed sign-in, with a button to sign in again. */
export const SignInScreen: typeof Clerk.SignInScreen = () => {
  const t = adminCopy().signIn;
  const search = useLocation({ select: (location) => location.search as Record<string, unknown> });
  const failed = search.error !== undefined;
  const returnTo = typeof search.redirect_url === 'string' ? search.redirect_url : '/';
  let notice: string | null = null;
  if (failed) notice = t.failed;
  else if (search.signed_out !== undefined) notice = t.signedOut;
  return (
    <Card className="w-full max-w-md py-8">
      <CardContent className="space-y-4 px-8 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          {failed ? <ShieldAlert className="h-6 w-6 text-amber-600 dark:text-amber-400" /> : <LogIn className="h-6 w-6 text-primary" />}
        </div>
        <h1 className="text-lg font-semibold">{t.title}</h1>
        <p className="text-sm text-muted-foreground">{notice ?? t.description}</p>
        <Button asChild>
          <a href={`/auth/sign-in?redirect_url=${encodeURIComponent(returnTo)}`}>{t.button}</a>
        </Button>
      </CardContent>
    </Card>
  );
};

/** Signing out is a POST (the endpoint refuses anything cross-site), sent as a form so the browser follows the redirects. */
export const useSignOut: typeof Clerk.useSignOut = () =>
  useCallback(() => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/auth/sign-out';
    document.body.appendChild(form);
    form.submit();
  }, []);

/** Only the support inbox asks, and it is Global's. */
export const useStaffProfile: typeof Clerk.useStaffProfile = () => ({
  name: null,
  imageUrl: null,
  getToken: async () => '',
});
