/**
 * Mail attachments — metadata and download of a message's files.
 *
 * An attachment is reachable when its message is: the mailbox decides, as
 * everywhere else in mail. The download streams the stored object with the
 * same headers WeldMail uses (`attachment`, `no-store`, `nosniff`), so a file
 * is never rendered inline from an API origin.
 *
 * Uploading files for a new message (`POST /`) lives in `mail-sending`, which
 * only the public API mounts.
 *
 * Locating an attachment goes through `getWorkspaceMail`'s `store`
 * (`WorkspaceMailStore.locateAttachment`, design task D5): a fan-out over the
 * caller's accessible mailboxes rather than a direct `mail_messages` join, so
 * it works the same in every mailbox-store mode.
 */

import { Hono, type Context } from 'hono';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { error, success } from '../../../lib/response';
import { publicAttachment } from '../../../lib/mail';
import { workspaceMailFromContext } from '../../../lib/mail-store-context';
import { getStoredObject } from '@weldsuite/worker-kit/storage';

const app = new Hono<HonoEnv>();

/** The attachment when its message is in a mailbox the caller can open. */
async function reachableAttachment(c: Context<HonoEnv>, id: string) {
  const { store, access } = await workspaceMailFromContext(c);
  const accessibleIds = await access.accessibleAccountIds();
  if (accessibleIds.length === 0) return null;
  return store.locateAttachment(id, accessibleIds);
}

/** RFC 6266 filename, with an ASCII fallback for old clients. */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

app.get('/:id', requireScope('mail_attachments:read'), async (c) => {
  const id = c.req.param('id');
  const located = await reachableAttachment(c, id);
  if (!located) return error.notFound(c, 'MailAttachment', id);
  return success(c, publicAttachment(located.attachment));
});

app.get('/:id/download', requireScope('mail_attachments:read'), async (c) => {
  const id = c.req.param('id');
  const located = await reachableAttachment(c, id);
  if (!located?.attachment.storagePath) return error.notFound(c, 'MailAttachment', id);
  if (!c.env.STORAGE && !c.env.PRIVATE_STORAGE) {
    return c.json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'File storage is not configured' } }, 503);
  }
  const obj = await getStoredObject(c.env, located.attachment.storagePath);
  if (!obj) return error.notFound(c, 'MailAttachment', id);
  return new Response(obj.body, {
    headers: {
      'Content-Type': located.attachment.contentType || obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Content-Disposition': contentDisposition(located.attachment.fileName),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

export default app;
