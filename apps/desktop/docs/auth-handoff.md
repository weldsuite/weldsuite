# Desktop Auth Handoff

Google and Microsoft actively block OAuth inside embedded webviews ("this
browser or app may not be secure"). The WeldSuite desktop shell drives the
entire sign-in flow through the user's system browser. How the session gets
back to the app depends on the edition, which the platform reads from
`/config.json` (`auth.provider`):

- **Global (Clerk)**: a single-use Clerk sign-in ticket, handed back by a
  `weldsuite://auth` deep link (below, from "Flow overview").
- **EU and self-hosted (OIDC: WeldID, or Zitadel)**: plain OIDC with PKCE and
  a loopback redirect, as RFC 8252 asks of native apps ("OIDC editions", at
  the end). No ticket and no deep link: `desktop-sign-in` (the Clerk ticket
  endpoint) stays unavailable there and hides nothing else.

## Flow overview (Global, Clerk)

```
┌──────────────┐    1. click Sign in     ┌──────────────────────┐
│  Desktop app │ ───────────────────────▶│  platform (Electron) │
└──────────────┘                         └──────────┬───────────┘
                                                    │ 2. startExternalSignIn()
                                                    ▼
                                         ┌──────────────────────┐
                                         │   system browser     │
                                         │   app.weldsuite.org  │
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

## OIDC editions (EU and self-hosted)

The Kubernetes editions sign in with an OIDC provider: WeldID (header mode,
the workspace in `X-Weld-Workspace`) or Zitadel (claim mode). The desktop app
is a **public native client** of its own, `desktopClientId` in
`/config.json` (`OIDC_DESKTOP_CLIENT_ID`; `weldsuite-desktop` on WeldID), with
the one redirect URI `http://127.0.0.1/callback`. Both providers match a
native client's loopback redirect on any port (RFC 8252 section 7.3).

```
┌──────────────────────┐ 1. "Continue in your browser"   ┌──────────────────┐
│ platform (app view)  │ ─ oidcSignIn.start() ─────────▶ │ Electron main    │
│ oidc-client-ts:      │ ◀─ { id, redirectUri } ──────── │ listens on       │
│ state, nonce, PKCE   │                                 │ 127.0.0.1:<port> │
│ (its state store)    │ 2. oidcSignIn.authorize(url) ─▶ │ checks the URL,  │
└──────────────────────┘                                 │ opens the browser│
          ▲                                              └────────┬─────────┘
          │                                   3. sign-in at the   │
          │                                      provider         ▼
          │                                              ┌──────────────────┐
          │ 5. { status: 'callback', callbackUrl }       │ system browser   │
          │    (main closes the listener, focuses        │ → 127.0.0.1:<port>│
          │    the window)                               │   /callback?code │
          │                                              │   &state         │
          │                                              └────────┬─────────┘
          │ 6. code + verifier → token endpoint                   │ 4. "You're signed
          │    (this page, CORS); session stored where            │    in" page
          │    a browser sign-in stores it                        ▼
```

- **The page does the OIDC part, the shell only listens.** The platform
  builds the authorization request with oidc-client-ts (state, nonce, PKCE
  S256, scopes `openid profile email offline_access` plus the edition's
  audience/organization scopes) and redeems the code at the token endpoint
  itself. The PKCE verifier and the tokens never cross IPC, never touch the
  main process, and land in the same place as a browser sign-in's
  (oidc-client-ts's user store), under the desktop client. Refresh is the
  usual refresh-token grant (`offline_access`).
- **The shell** (`src/main/loopback-sign-in.ts`) opens a one-shot HTTP
  listener on `127.0.0.1` (never `localhost` or `0.0.0.0`) with a port the OS
  picks, checks the authorization request before opening it, and answers
  only `GET /callback` with that `state` and its own `Host`. The check:
  - the endpoint is on the issuer's origin. Main reads the issuer itself from
    `APP_URL`'s `/config.json` when the sign-in starts (https, or http to a
    loopback provider in development), and opens the request rebuilt on that
    origin, so the page can't choose where the browser goes;
  - `response_type=code`, `code_challenge_method=S256`, a `state`, and its
    own redirect URI.
  Anything else is refused and the listener keeps waiting, so a stray
  request can't end a real sign-in. The browser gets a small page in the
  app's language that loads nothing (`default-src 'none'`). The sign-in ends
  after 10 minutes, on cancel, when the app view navigates, or when the
  window closes. Nothing logs a URL: the callback carries the code.
- **IPC** (`window.weldsuiteDesktop.oidcSignIn`, shells 0.3.0 and later):
  `start()`, `authorize({ id, url, page })` and `cancel(id)`. Main answers
  only the app view's main frame on `APP_URL`'s origin: a link that takes
  the view elsewhere keeps the preload, so the bridge alone proves nothing.
- **The platform** (`apps/web/platform`): `src/boot/runtime.tsx` picks the
  desktop client and the shell's sign-in (`desktopBrowserSignIn()`,
  `lib/desktop-auth.ts`) when the shell has `oidcSignIn` and `/config.json`
  names `desktopClientId`; `lib/auth/oidc/session.ts` runs the flow. In the
  shell, `/auth/login` (and the other provider entry points) show a
  "Continue in your browser" button (`components/auth/browser-sign-in-screen.tsx`)
  and never open the browser on their own: the app also starts at login,
  minimised. A Zitadel workspace switch (claim mode) takes the same route.
- **Sign-out** revokes the refresh token at the provider, forgets the
  session, and opens the provider's end-session endpoint in the system
  browser, where the provider's session cookie lives. It names the client
  only, never an `id_token_hint`, so no token goes into the browser's
  history; WeldID then asks before ending the browser's session.
- **Older shells, or no `desktopClientId`**: the platform signs in inside the
  window with the web client, as before (Google and Microsoft sign-in is
  refused there).

### Registering the client

- WeldID: the `weldsuite-desktop` client in
  `rust/deploy/flux/infrastructure/weldid/values/weldid.yaml` (public,
  `redirectUris: [http://127.0.0.1/callback]`, `firstParty`, audience
  `weldsuite-api`), named by the weldid-switch layer's `desktopClientId`.
- Zitadel: a Native application with PKCE and refresh tokens and the same
  redirect URI (`rust/deploy/hetzner/README.md`, step 7, item 2c); its id is
  `ZITADEL_DESKTOP_CLIENT_ID`.

### Testing locally

1. Run the Rust backend with `AUTH_PROVIDER=oidc` and
   `OIDC_DESKTOP_CLIENT_ID` (or put `desktopClientId` in the platform's
   `public/config.json`), and the platform with `VITE_RUNTIME_CONFIG=on`.
2. `DESKTOP_APP_URL=http://localhost:3000 pnpm --filter desktop dev`.
3. Sign in: the browser opens the provider, then shows "You're signed in";
   the window comes to the front, signed in.
4. `pnpm --filter desktop test` covers the listener (state, timeout, cancel,
   127.0.0.1 only, the page's lack of external resources).
