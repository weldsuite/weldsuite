/**
 * GET /api/mailboxes — every workspace mailbox the caller can see.
 *
 * Clerk-authenticated but org-LESS: the JWT's `sub` is enough. Mounted
 * BEFORE the global `/api/*` workspaceDb guard so a user with several
 * memberships (or none currently active) can still load the directory.
 * Personal inboxes live on personal-api and are not included here.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { success } from '../../lib/response';
import { listUserMailboxes } from '../../services/mail/mailboxes';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', async (c) => {
  const userId = c.get('userId');

  try {
    const groups = await listUserMailboxes(c.env, userId);
    return success(c, groups);
  } catch (err) {
    console.error('[app-api/mailboxes] list failed:', err);
    return success(c, []);
  }
});

export const mailboxesRoutes = app;
