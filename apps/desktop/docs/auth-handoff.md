# Desktop Auth Handoff

Google and Microsoft actively block OAuth inside embedded webviews ("this
browser or app may not be secure"). The WeldSuite desktop shell drives the
entire sign-in flow through the user's system browser and hands the Clerk
session back via a custom-protocol deep link.

## Flow overview

```
┌──────────────┐    1. click Sign in     ┌──────────────────────┐
│  Desktop app │ ───────────────────────▶│  platform (Electron) │
└──────────────┘                         └──────────┬───────────┘
                                                    │ 2. startExternalSignIn()
                                                    ▼
                                         ┌──────────────────────┐
                                         │   system browser     │
                                         │   app.weldsuite.com  │
                                         │   /sign-in?desktop=1 │
                                         │   &return_to=        │
                                         │   weldsuite://auth   │
                                         └──────────┬───────────┘
                                                    │ 3. Clerk OAuth (Google / MS / password)
                                                    ▼
                                         ┌──────────────────────┐
                                         │ /desktop-handoff     │
                                         │ creates sign-in      │
                                         │ ticket via Clerk     │
                                         │ backend, then        │
                                         │ location.href =      │
                                         │ weldsuite://auth?    │
                                         │ ticket=...           │
                                         └──────────┬───────────┘
                                                    │ 4. OS dispatches deep link
                                                    ▼
┌──────────────┐    5. auth-callback IPC  ┌──────────────────────┐
│  Desktop app │ ◀──────────────────────── │  Electron main       │
│  signIn.ticket│                          │  focuses window      │
└──────────────┘                          └──────────────────────┘
```

## What the shell does (already implemented)

- **Intercepts OAuth navigation**: `will-navigate` / `will-redirect` catch any
  navigation to `accounts.google.com`, `login.microsoftonline.com`, etc., and
  open them in the system browser.
- **Intercepts our own sign-in routes**: navigation to `/sign-in`, `/sign-up`,
  `/sso-callback` is also routed to the browser.
- **Registers `weldsuite://` protocol** on Win/macOS/Linux so the browser can
  bounce back after sign-in.
- **Exposes** `window.weldsuiteDesktop.signInExternally({ path })` to the
  platform via the preload bridge.
- **Fires `weldsuite:auth-callback`** to the renderer when a
  `weldsuite://auth?...` deep link arrives.

## What the platform app needs to implement

### 1. Render the "continue in browser" screen for desktop users

```tsx
// apps/web/platform/app/auth/sign-in/page.tsx (pseudo)
import { isDesktop } from '@/lib/desktop';
import { ContinueInBrowser } from '@/components/desktop/continue-in-browser';
import { useRedirectSignInToBrowser } from '@/hooks/use-desktop-auth';

export default function SignInPage() {
  useRedirectSignInToBrowser('/sign-in');
  if (isDesktop()) return <ContinueInBrowser />;
  return <ClerkSignIn /* the normal web sign-in */ />;
}
```

### 2. Build the `/desktop-handoff` page on the **web** app

After Clerk's `<SignIn/>` completes and `signUp?.status === 'complete'` (or
user was already signed in), redirect the browser tab to a handoff page:

```tsx
// runs in the external browser only, NOT the Electron shell
import { useAuth } from '@clerk/clerk-react';
import { useEffect } from 'react';

export default function DesktopHandoff() {
  const { getToken } = useAuth();
  const returnTo = new URLSearchParams(location.search).get('return_to')
    ?? 'weldsuite://auth';

  useEffect(() => {
    (async () => {
      // Call your backend to mint a Clerk sign-in ticket for this user.
      const token = await getToken();
      const res = await fetch('/api/auth/desktop-ticket', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const { ticket } = await res.json();

      const url = new URL(returnTo);
      url.searchParams.set('ticket', ticket);
      url.searchParams.set('status', 'success');
      window.location.href = url.toString();
    })();
  }, []);

  return <p>Returning to the WeldSuite desktop app…</p>;
}
```

### 3. Mint the sign-in ticket on the backend

Clerk's Backend API exposes a "sign-in token" endpoint that creates a
single-use, short-lived ticket bound to a `user_id`:

```ts
// core-api or api-worker route
import { createClerkClient } from '@clerk/backend';

const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

export async function createDesktopTicket(userId: string) {
  const token = await clerk.signInTokens.createSignInToken({
    userId,
    expiresInSeconds: 120,
  });
  return token.token; // ← pass back as `ticket`
}
```

Docs: https://clerk.com/docs/reference/backend-api/tag/Sign-in-Tokens

### 4. Complete the session in the desktop renderer

The `useDesktopAuthHandler` hook already consumes `weldsuite://auth?ticket=...`
and calls `signIn.create({ strategy: 'ticket', ticket })` + `setActive()`.
Mount it once near the root of the desktop app (root layout or
`src/main.tsx` equivalent):

```tsx
function DesktopAuthBridge() {
  useDesktopAuthHandler({
    onSuccess: () => router.navigate({ to: '/' }),
    onError: (msg) => toast.error(msg),
  });
  return null;
}
```

## Security notes

- **Only our own origin** is trusted for the handoff page. The
  `return_to` parameter MUST be validated against an allowlist of
  `weldsuite://` URIs before the handoff page redirects, otherwise an
  attacker could craft `/desktop-handoff?return_to=https://evil.com` and
  exfiltrate the ticket.
- Sign-in tickets are **single use, short-lived** (≤ 2 minutes). Even if
  leaked they expire fast.
- The Electron window never sees the OAuth provider's credentials, Google /
  Microsoft only talk to the system browser.

## Testing locally

1. `pnpm --filter @weldsuite/platform dev` (port 3000), this is also the
   "system browser" target during dev.
2. `pnpm --filter desktop dev`, the shell points at
   `http://localhost:3000`.
3. Click sign-in in the shell → the system browser opens `/sign-in?desktop=1`.
4. Complete sign-in, confirm the handoff page redirects to `weldsuite://auth`.
5. Confirm Electron focuses and completes the session.

To test without the backend ticket endpoint ready yet, hard-code a stub that
returns a known test token.
