/**
 * Inline images of a forwarded personal message (TASK-905).
 *
 * A forward quotes the original's stored HTML. That HTML keeps `cid:`
 * references (or, for messages stored before TASK-905, the bucket's public
 * URL), and both point at the original's own attachments, which a forward
 * does not otherwise carry. So the images the quote references go out as
 * inline MIME parts: under the original's Content-ID, so its `cid:`
 * references resolve as they are, and an older message's public URLs become
 * `cid:` references to those parts.
 *
 * Only live image attachments of the owner's own message, under the owner's
 * `personal/<personalAccountId>/` folder, are sent. One that cannot be read
 * is left out, and so are images past the size budget.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { isPersonalStorageKey } from '@weldsuite/mail-domain/attachments';
import { isInlineImageType } from '@weldsuite/mail-domain/inline-images';
import { personalSchema, type PersonalDatabase } from '../db';

const { personalMailAttachments } = personalSchema;

/**
 * At most this many bytes of quoted images per forward, well under
 * Cloudflare's message size limit with room for the rest of the message.
 */
export const FORWARD_INLINE_IMAGE_BUDGET = 15 * 1024 * 1024;

/** One inline image to send with the forward, and where its bytes live. */
export interface ForwardInlineImage {
  filename: string;
  contentType: string;
  content: ArrayBuffer;
  /** Content-ID without angle brackets. */
  cid: string;
  /** The original's object key; the sent copy's attachment row points at it too. */
  storagePath: string;
  size: number;
}

function bare(contentId: string): string {
  return contentId.trim().replace(/^</, '').replace(/>$/, '').trim();
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * The quoted HTML with older public URLs turned into `cid:` references, and
 * the inline parts its references need. HTML without references to the
 * original's images comes back unchanged, with no parts.
 */
export async function forwardInlineImages(
  storage: R2Bucket | undefined,
  db: PersonalDatabase,
  personalAccountId: string,
  originalMessageId: string,
  html: string,
): Promise<{ html: string; parts: ForwardInlineImage[] }> {
  if (!html) return { html, parts: [] };

  const rows = await db
    .select({
      id: personalMailAttachments.id,
      fileName: personalMailAttachments.fileName,
      contentType: personalMailAttachments.contentType,
      contentId: personalMailAttachments.contentId,
      storagePath: personalMailAttachments.storagePath,
    })
    .from(personalMailAttachments)
    .where(
      and(
        eq(personalMailAttachments.messageId, originalMessageId),
        eq(personalMailAttachments.personalAccountId, personalAccountId),
        isNull(personalMailAttachments.deletedAt),
      ),
    );

  const lower = html.toLowerCase();
  const referenced = rows.flatMap((row) => {
    if (!row.storagePath || !isPersonalStorageKey(row.storagePath, personalAccountId)) return [];
    if (!isInlineImageType(row.contentType)) return [];
    const contentId = row.contentId ? bare(row.contentId) : '';
    const byCid = !!contentId && lower.includes(`cid:${contentId.toLowerCase()}`);
    const byUrl = html.includes(`/${row.storagePath}`);
    if (!byCid && !byUrl) return [];
    return [{ row, storagePath: row.storagePath, cid: contentId || `${row.id}@weldmail`, byUrl }];
  });
  if (referenced.length === 0) return { html, parts: [] };
  if (!storage) {
    console.warn('[personal-api] no STORAGE binding; a forward goes out without its inline images');
    return { html, parts: [] };
  }

  const parts: ForwardInlineImage[] = [];
  let budget = FORWARD_INLINE_IMAGE_BUDGET;
  let out = html;
  for (const { row, storagePath, cid, byUrl } of referenced) {
    try {
      const object = await storage.get(storagePath);
      if (!object || object.size > budget) continue;
      budget -= object.size;
      parts.push({
        filename: row.fileName,
        contentType: row.contentType!.split(';')[0]!.trim().toLowerCase(),
        content: await object.arrayBuffer(),
        cid,
        storagePath,
        size: object.size,
      });
      if (byUrl) {
        // An older message's public URL for this file, whatever host served it.
        const url = new RegExp(String.raw`https?://[^/"'\s<>()]+/${escapeRegExp(storagePath)}`, 'g');
        out = out.replace(url, `cid:${cid}`);
      }
    } catch (err) {
      console.error(`[personal-api] Failed to load inline image ${row.id} for a forward:`, err);
    }
  }
  return { html: out, parts };
}
