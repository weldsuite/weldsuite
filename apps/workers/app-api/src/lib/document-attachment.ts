/**
 * Stream a stored invoice/bill attachment from R2 after verifying the key
 * belongs to the document and to this workspace.
 */

import type { Context } from 'hono';
import type { Env, Variables } from '../../types';
import { error } from '../../lib/response';

export async function streamDocumentAttachment(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  args: {
    attachmentKeys: string[] | null | undefined;
    index: number;
    workspaceId: string | null | undefined;
  },
): Promise<Response> {
  if (!Number.isInteger(args.index) || args.index < 0) {
    return error.badRequest(c, 'Invalid attachment index');
  }
  const keys = args.attachmentKeys ?? [];
  const fileKey = keys[args.index];
  if (!fileKey) {
    return error.notFound(c, 'Attachment', String(args.index));
  }

  const workspaceId = args.workspaceId?.trim();
  if (!workspaceId) {
    return error.orgRequired(c);
  }
  const prefix = `workspaces/${workspaceId}/`;
  if (!fileKey.startsWith(prefix) || fileKey.split('/').includes('..')) {
    return error.forbidden(c, 'Attachment is outside this workspace');
  }

  if (!c.env.STORAGE) {
    return error.internal(c, 'Storage is not configured');
  }

  const obj = await c.env.STORAGE.get(fileKey);
  if (!obj) {
    return error.notFound(c, 'Attachment', fileKey);
  }

  const filename = fileKey.split('/').pop() || 'attachment';
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('Cache-Control', 'private, max-age=3600');
  headers.set(
    'Content-Disposition',
    `inline; filename="${filename.replace(/"/g, '')}"`,
  );
  return new Response(obj.body, { status: 200, headers });
}
