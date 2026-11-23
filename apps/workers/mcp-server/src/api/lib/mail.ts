/**
 * Shared pieces of the v1 mail routes.
 *
 * Kept identical to mcp-server's copy (`src/api/lib/mail.ts`), like the route
 * files that use it, so the two surfaces can be diffed when routes change. The
 * wire shapes themselves (`publicMessage`, `publicListMessage`,
 * `publicAttachment`, the cursors and query flags) live once, in
 * `@weldsuite/mail-domain/public-shapes`, and are re-exported here.
 *
 * Every mail route resolves a {@link MailPrincipal} from the session before it
 * touches a mailbox. A personal key or an MCP user acts as that person and gets
 * exactly the mailboxes they can open in WeldMail. A workspace key or a WeldApp
 * token has no person behind it and acts as the workspace: shared mailboxes
 * only. A mailbox outside the principal's reach answers 404, never 403, so a
 * key cannot probe which private mailboxes exist.
 */

import type { Context } from 'hono';
import { principalFromSession, type MailPrincipal } from '@weldsuite/mail-domain/access';
import type { HonoEnv } from '../types';

export * from '@weldsuite/mail-domain/public-shapes';

export function mailPrincipal(c: Context<HonoEnv>): MailPrincipal {
  return principalFromSession(c.get('apiSession'));
}
