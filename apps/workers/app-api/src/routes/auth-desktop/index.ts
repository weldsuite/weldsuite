/**
 * Desktop sign-in handoff — /api/auth-desktop/*.
 *
 * Ported from core-api's `routes/auth/desktop.ts`.
 *
 *   POST /ticket — mints a short-lived (120s), single-use Clerk sign-in token
 *   so the desktop shell (opened via `weldsuite://auth?ticket=...`) can
 *   complete a session without the user re-entering credentials inside the
 *   Electron webview.
 *
 * IMPORTANT — middleware: this router needs Clerk auth but NOT the
 * workspace-DB middleware. The user may be signed in WITHOUT an active org
 * selected (no workspace chosen yet), and minting a desktop ticket must still
 * work in that state. The global `app.use('/api/*', clerkMiddleware(),
 * workspaceDbMiddleware(), ...)` in `src/index.ts` would 403 such requests at
 * the workspace step, so this router applies `clerkMiddleware()` itself and
 * must be mounted on the root app BEFORE that global middleware (see the
 * WIRING note in the migration report).
 *
 * No entity mutations occur here, so this route is exempt from the
 * entity-event coverage sweep.
 */

import { Hono } from 'hono';
import { createClerkClient } from '@clerk/backend';
import { zValidator } from '@hono/zod-validator';
import { createDesktopTicketInput } from '@weldsuite/app-api-client/schemas/auth-desktop';
import type { Env, Variables } from '../../types';
import { clerkMiddleware } from '../../middleware/clerk';
import { error } from '../../lib/response';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Clerk auth only — deliberately NOT workspaceDbMiddleware (no org required).
app.use('*', clerkMiddleware());

// Only these schemes are allowed as return targets to prevent ticket exfil.
const ALLOWED_RETURN_SCHEMES = ['weldsuite:'];

const TICKET_TTL_SECONDS = 120;

app.post('/ticket', zValidator('json', createDesktopTicketInput), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c, 'No user');

  const { returnTo: requestedReturnTo } = c.req.valid('json');
  const returnTo = requestedReturnTo ?? 'weldsuite://auth';

  try {
    const parsed = new URL(returnTo);
    if (!ALLOWED_RETURN_SCHEMES.includes(parsed.protocol)) {
      return error.badRequest(c, 'return_to scheme not allowed');
    }
  } catch {
    return error.badRequest(c, 'return_to is not a valid URL');
  }

  const clerk = createClerkClient({ secretKey: c.env.CLERK_SECRET_KEY });

  try {
    const token = await clerk.signInTokens.createSignInToken({
      userId,
      expiresInSeconds: TICKET_TTL_SECONDS,
    });

    return c.json({
      data: {
        ticket: token.token,
        expiresAt: Date.now() + TICKET_TTL_SECONDS * 1000,
        returnTo,
      },
    });
  } catch (err) {
    console.error('[app-api/auth-desktop] createSignInToken failed:', err);
    return error.internal(c, 'Could not create desktop sign-in ticket');
  }
});

export const authDesktopRoutes = app;
