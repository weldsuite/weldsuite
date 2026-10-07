/**
 * Compose attachments uploaded through the public API.
 *
 * The send path takes attachments as R2 keys under the workspace's prefix
 * (`workspaces/{orgId}/...`). The platform gets those keys from app-api's
 * upload-URL flow; API callers upload here instead and get an opaque id back,
 * which they pass as `attachmentIds` on a send or a draft.
 *
 * There is no table behind an upload: the object itself carries the filename
 * and content type, and its key is derived from the id. The id is checked
 * against a strict pattern before it becomes part of a key, so a caller can
 * never point a lookup outside its own workspace's upload folder.
 *
 * Once sent, the object becomes the sent copy's attachment (`storagePath`), so
 * it is never deleted after a send. Uploads that are never sent stay in the
 * bucket; cleaning those up is a sweep this module does not run.
 */

import { generateId } from '@weldsuite/worker-kit/id';
import { MAX_EMAIL_SIZE_BYTES, MailSendError, type SendAttachmentInput } from './send';

/** The binding uploads read and write (any worker Env with it fits). */
export interface MailUploadsEnv {
  STORAGE?: R2Bucket;
}

/** One file may use the whole message budget; the send path enforces the total. */
export const MAX_UPLOAD_BYTES = MAX_EMAIL_SIZE_BYTES;

const UPLOAD_ID_PATTERN = /^mupl_[a-z0-9]{8,40}$/;

export interface MailUpload {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export class MailUploadError extends Error {
  constructor(
    public readonly code: 'STORAGE_BINDING_MISSING' | 'EMPTY_FILE' | 'FILE_TOO_LARGE',
    message: string,
  ) {
    super(message);
    this.name = 'MailUploadError';
  }
}

function uploadPrefix(orgId: string, id: string): string {
  return `workspaces/${orgId}/mail/uploads/${id}/`;
}

/** A filename safe to use as the last key segment, keeping its extension. */
function safeFilename(name: string): string {
  const cleaned = name.replace(/[\\/]+/g, '_').replace(/[^\w.\- ]+/g, '_').trim().slice(0, 200);
  return cleaned || 'attachment';
}

export function isUploadId(id: string): boolean {
  return UPLOAD_ID_PATTERN.test(id);
}

export async function storeMailUpload(
  env: MailUploadsEnv,
  orgId: string,
  input: { filename: string; contentType?: string; content: ArrayBuffer },
): Promise<MailUpload> {
  if (!env.STORAGE) throw new MailUploadError('STORAGE_BINDING_MISSING', 'Storage binding not configured');
  if (input.content.byteLength === 0) throw new MailUploadError('EMPTY_FILE', 'The file is empty');
  if (input.content.byteLength > MAX_UPLOAD_BYTES) {
    throw new MailUploadError(
      'FILE_TOO_LARGE',
      `Files are limited to ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB, the size limit of a whole email.`,
    );
  }

  const id = generateId('mupl');
  const filename = input.filename.trim().slice(0, 500) || 'attachment';
  const contentType = input.contentType || 'application/octet-stream';
  const createdAt = new Date().toISOString();
  await env.STORAGE.put(`${uploadPrefix(orgId, id)}${safeFilename(filename)}`, input.content, {
    httpMetadata: { contentType },
    customMetadata: { filename, createdAt },
  });
  return { id, filename, contentType, size: input.content.byteLength, createdAt };
}

async function findUploadObject(env: MailUploadsEnv, orgId: string, id: string): Promise<R2Object | null> {
  if (!env.STORAGE || !isUploadId(id)) return null;
  // The listing finds the key (the filename is part of it); `head` returns the
  // object with its metadata, which a listing does not reliably carry.
  const listed = await env.STORAGE.list({ prefix: uploadPrefix(orgId, id), limit: 1 });
  const key = listed.objects[0]?.key;
  return key ? env.STORAGE.head(key) : null;
}

/** One upload's metadata, or null when there is no such upload in this workspace. */
export async function getMailUpload(env: MailUploadsEnv, orgId: string, id: string): Promise<MailUpload | null> {
  const obj = await findUploadObject(env, orgId, id);
  if (!obj) return null;
  return {
    id,
    filename: obj.customMetadata?.filename ?? obj.key.slice(obj.key.lastIndexOf('/') + 1),
    contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
    size: obj.size,
    createdAt: obj.customMetadata?.createdAt ?? obj.uploaded.toISOString(),
  };
}

/**
 * Turn upload ids into the attachments the send path takes. Throws
 * `ATTACHMENT_NOT_IN_STORAGE` naming the first id that is not an upload of this
 * workspace (an id from another workspace resolves to nothing, by key).
 */
export async function resolveMailUploads(
  env: MailUploadsEnv,
  orgId: string,
  ids: string[],
): Promise<SendAttachmentInput[]> {
  if (ids.length === 0) return [];
  if (!env.STORAGE) throw new MailSendError('STORAGE_BINDING_MISSING', 'Storage binding not configured');
  const resolved: SendAttachmentInput[] = [];
  for (const id of [...new Set(ids)]) {
    const obj = await findUploadObject(env, orgId, id);
    if (!obj) throw new MailSendError('ATTACHMENT_NOT_IN_STORAGE', `Attachment upload ${id} not found`, { id });
    resolved.push({
      filename: obj.customMetadata?.filename ?? obj.key.slice(obj.key.lastIndexOf('/') + 1),
      contentType: obj.httpMetadata?.contentType,
      size: obj.size,
      fileKey: obj.key,
    });
  }
  return resolved;
}
