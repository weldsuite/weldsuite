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
 */

import { Hono, type Context } from 'hono';
import { getAttachment } from '@weldsuite/mail-domain/attachments';
import { canOpenAccount } from '@weldsuite/mail-domain/access';
import { getMessageAccountId } from '@weldsuite/mail-domain/messages';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { error, success } from '../../../lib/response';
import { mailPrincipal, publicAttachment } from '../../../lib/mail';

const app = new Hono<HonoEnv>();

/** The attachment when its message is in a mailbox the caller can open. */
async function reachableAttachment(c: Context<HonoEnv>, id: string) {
  const db = c.get('tenantDb');
  const row = await getAttachment(db, id);
  if (!row) return null;
  const accountId = await getMessageAccountId(db, row.messageId);
  if (!accountId || !(await canOpenAccount(db, accountId, mailPrincipal(c)))) return null;
  return row;
}

/** RFC 6266 filename, with an ASCII fallback for old clients. */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

app.get('/:id', requireScope('mail_attachments:read'), async (c) => {
  const id = c.req.param('id');
  const row = await reachableAttachment(c, id);
  if (!row) return error.notFound(c, 'MailAttachment', id);
  return success(c, publicAttachment(row));
});

app.get('/:id/download', requireScope('mail_attachments:read'), async (c) => {
  const id = c.req.param('id');
  const row = await reachableAttachment(c, id);
  if (!row?.storagePath) return error.notFound(c, 'MailAttachment', id);
  if (!c.env.STORAGE) {
    return c.json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'File storage is not configured' } }, 503);
  }
  const obj = await c.env.STORAGE.get(row.storagePath);
  if (!obj) return error.notFound(c, 'MailAttachment', id);
  return new Response(obj.body, {
    headers: {
      'Content-Type': row.contentType || obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Content-Disposition': contentDisposition(row.fileName),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

export default app;
