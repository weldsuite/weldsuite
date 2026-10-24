/**
 * Visitor attachments: which files a message may reference.
 *
 * `POST /api/attachments/upload` stores a file at
 * `widgets/{workspaceId}/{conversationId}/{timestamp}_{attachmentId}_{name}` and
 * hands back its public URL. A message may only point at such a URL, issued for
 * the same workspace and conversation, so a visitor cannot make an agent's inbox
 * link to an arbitrary host or to a file uploaded for someone else's thread.
 */

import type { DeskMessageAttachment } from '@weldsuite/db/schema/desk-messages';
import { trimTrailingSlashes } from '@weldsuite/text';
import type { Env } from '../index';

export const MAX_MESSAGE_ATTACHMENTS = 10;

/** The shape of the object name the upload route generates (`generateId('att')` + sanitised file name). */
const OBJECT_NAME_PATTERN = /^\d+_att_[a-z0-9]+_[A-Za-z0-9._-]*$/;

/** Public bucket origin without a trailing slash, or null when it is not configured. */
export function publicStorageBase(env: Pick<Env, 'R2_PUBLIC_URL'>): string | null {
  const base = trimTrailingSlashes(env.R2_PUBLIC_URL?.trim() ?? '');
  return base || null;
}

/** Public URL of an uploaded object, or null when the public bucket URL is not configured. */
export function publicAttachmentUrl(env: Pick<Env, 'R2_PUBLIC_URL'>, fileKey: string): string | null {
  const base = publicStorageBase(env);
  return base ? `${base}/${fileKey}` : null;
}

/** The R2 object key behind a URL this worker issued for the conversation, or null for anything else. */
export function ownedAttachmentKey(
  env: Pick<Env, 'R2_PUBLIC_URL'>,
  workspaceId: string,
  conversationId: string,
  url: string,
): string | null {
  const base = publicStorageBase(env);
  if (!base) return null;
  const folder = `widgets/${workspaceId}/${conversationId}/`;
  const prefix = `${base}/${folder}`;
  if (!url.startsWith(prefix)) return null;
  const objectName = url.slice(prefix.length);
  if (!OBJECT_NAME_PATTERN.test(objectName)) return null;
  return `${folder}${objectName}`;
}

export type ResolvedAttachments =
  | { ok: true; attachments: DeskMessageAttachment[] }
  | { ok: false; message: string };

/**
 * Check the attachments a visitor sent with a message. URLs must be ones issued
 * for this conversation and the object must exist; the stored size and type win
 * over whatever the client claims.
 */
export async function resolveVisitorAttachments(
  env: Pick<Env, 'R2_PUBLIC_URL' | 'STORAGE'>,
  workspaceId: string,
  conversationId: string,
  attachments: DeskMessageAttachment[],
): Promise<ResolvedAttachments> {
  if (!publicStorageBase(env)) return { ok: false, message: 'File attachments are not available' };
  const resolved: DeskMessageAttachment[] = [];
  for (const attachment of attachments) {
    const key = ownedAttachmentKey(env, workspaceId, conversationId, attachment.url);
    if (!key) return { ok: false, message: 'Attachment was not uploaded to this conversation' };
    const object = await env.STORAGE.head(key);
    if (!object) return { ok: false, message: 'Attachment was not found' };
    resolved.push({
      name: attachment.name,
      url: attachment.url,
      contentType: object.httpMetadata?.contentType ?? attachment.contentType,
      filesize: object.size,
      ...(attachment.width ? { width: attachment.width } : {}),
      ...(attachment.height ? { height: attachment.height } : {}),
    });
  }
  return { ok: true, attachments: resolved };
}
