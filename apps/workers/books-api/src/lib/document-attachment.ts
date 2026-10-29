/**
 * Stream a stored invoice/bill attachment from R2 after verifying the key
 * belongs to the document and to this workspace.
 */

import type { Context } from 'hono';
import type { Env, Variables } from '../types';
import { error } from '@weldsuite/worker-kit/response';
import { getStoredObject, isWorkspaceObjectKey } from '@weldsuite/worker-kit/storage';

export async function streamDocumentAttachment(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  args: {
    attachmentKeys: string[] | null | undefined;
    index: number;
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

  const clerkOrgId = c.get('clerkOrgId')?.trim();
  if (!clerkOrgId) {
    return error.orgRequired(c);
  }
  // Uploads sit under the Clerk org id, accounting-inbox mail under
  // `workspaces.id` (mail-inbound-worker): accept the workspace under either.
  if (!isWorkspaceObjectKey(fileKey, clerkOrgId, c.get('workspaceId'))) {
    return error.forbidden(c, 'Attachment is outside this workspace');
  }

  if (!c.env.STORAGE && !c.env.PRIVATE_STORAGE) {
    return error.internal(c, 'Storage is not configured');
  }

  const obj = await getStoredObject(c.env, fileKey);
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
    `inline; filename="${filename.replaceAll('"', '')}"`,
  );
  return new Response(obj.body, { status: 200, headers });
}
