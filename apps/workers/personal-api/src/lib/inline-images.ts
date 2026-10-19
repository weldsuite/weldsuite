/**
 * Inline images of personal mail (TASK-905).
 *
 * The inbound worker keeps `cid:` references in the stored HTML and writes no
 * public URL. When the owner reads a message, its inline-image references
 * (`cid:`, and the public storage URLs of messages stored before the change)
 * are swapped for short-lived `/public/mail-inline/:token` URLs on this
 * worker. Token and rewrite: `@weldsuite/mail-domain/inline-images`, with the
 * personal account as the owner.
 */

import type { Context } from 'hono';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  rewriteInlineImages,
  type InlineAttachmentRef,
  type InlineImageSigner,
} from '@weldsuite/mail-domain/inline-images';
import { personalSchema, type PersonalDatabase } from '../db';
import type { Env, Variables } from '../types';

const { personalMailAttachments } = personalSchema;

/**
 * The secret inline-image tokens are sealed with. personal-api holds no
 * DATABASE_ENCRYPTION_KEY (mail-api's fallback), and should not get it for
 * this, so it is MAIL_INLINE_IMAGE_SECRET only. Rotating it only breaks URLs
 * minted in the last hour.
 */
export function inlineImageSecret(env: Env): string | undefined {
  return env.MAIL_INLINE_IMAGE_SECRET || undefined;
}

/**
 * The signer for the caller's own messages. Undefined without a secret: the
 * HTML then keeps its `cid:` references (images do not show, and no public URL
 * is handed out).
 */
export function inlineImageSigner(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  personalAccountId: string,
): InlineImageSigner | undefined {
  const secret = inlineImageSecret(c.env);
  if (!secret) {
    console.warn('[personal-api] no MAIL_INLINE_IMAGE_SECRET; inline images are not rewritten');
    return undefined;
  }
  return {
    personalAccountId,
    baseUrl: c.env.PERSONAL_API_PUBLIC_URL || new URL(c.req.url).origin,
    secret,
  };
}

/**
 * Rewrite `htmlBody` in place on the caller's messages that have attachments.
 * Attachment rows are scoped to the personal account as well as the message,
 * and the rewrite only mints for keys under that account's folder.
 */
export async function applyPersonalInlineImages(
  db: PersonalDatabase,
  personalAccountId: string,
  messages: Array<{ id: string; htmlBody: string | null; hasAttachments: boolean | null }>,
  signer: InlineImageSigner | undefined,
): Promise<void> {
  if (!signer) return;
  const withHtml = messages.filter((m) => m.htmlBody && m.hasAttachments);
  if (withHtml.length === 0) return;

  const refs: InlineAttachmentRef[] = await db
    .select({
      id: personalMailAttachments.id,
      messageId: personalMailAttachments.messageId,
      contentId: personalMailAttachments.contentId,
      storagePath: personalMailAttachments.storagePath,
      contentType: personalMailAttachments.contentType,
    })
    .from(personalMailAttachments)
    .where(
      and(
        inArray(
          personalMailAttachments.messageId,
          withHtml.map((m) => m.id),
        ),
        eq(personalMailAttachments.personalAccountId, personalAccountId),
        isNull(personalMailAttachments.deletedAt),
      ),
    );

  const byMessage = new Map<string, InlineAttachmentRef[]>();
  for (const ref of refs) {
    const list = byMessage.get(ref.messageId) ?? [];
    list.push(ref);
    byMessage.set(ref.messageId, list);
  }
  for (const m of withHtml) {
    const own = byMessage.get(m.id);
    if (own) m.htmlBody = await rewriteInlineImages(m.htmlBody!, own, signer);
  }
}
