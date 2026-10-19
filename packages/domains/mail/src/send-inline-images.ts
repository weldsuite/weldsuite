/**
 * Inline images of outgoing mail (TASK-905 follow-up).
 *
 * The HTML a reader gets from mail-api points its inline images at minted
 * `/public/mail-inline/:token` URLs, which expire after about an hour. A reply
 * or forward that quotes that HTML would carry those URLs out, and the images
 * would break in the recipient's inbox. So before a message goes out, every
 * minted URL becomes a `cid:` reference to an inline MIME part holding the
 * image, and a forward's quoted original gets its own inline images the same
 * way (its stored HTML keeps `cid:` references, or a public storage URL from
 * before TASK-905).
 *
 * A token is only a pointer here: the image is sent when the attachment is
 * still a live image attachment of this workspace, at the key the token
 * names, in a mailbox the sender may open. That holds for an expired token
 * too (a draft or a scheduled send quotes HTML from hours ago). Anything else
 * drops the image rather than sending a URL that stops working.
 */

import { eq, inArray, and, isNull } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import { canOpenAccount, type MailCaller } from './access';
import { isWorkspaceStorageKey } from './attachments';
import {
  findInlineImageUrls,
  inlineImageSecret,
  isInlineImageType,
  readInlineImageClaims,
  replaceInlineImageUrls,
  swapInlineReferences,
  type InlineAttachmentRef,
  type InlineImageClaims,
  type InlineImageSecretEnv,
} from './inline-images';

const { mailAttachments, mailMessages } = schema;

/** An inline image to send: an attachment, by its Content-ID. */
export interface InlineImagePart {
  filename: string;
  contentType?: string;
  content: ArrayBuffer;
  cid: string;
}

/** An attachment whose image may go out inline. */
export interface InlineImageSource extends InlineAttachmentRef {
  fileName: string | null;
}

export interface OutboundInlineImagesEnv extends InlineImageSecretEnv {
  STORAGE?: R2Bucket;
}

export interface OutboundInlineImagesInput {
  /** Workspace id, the prefix of its storage keys. */
  workspaceId: string;
  caller: MailCaller;
  /** The mailbox sending; the caller's access to it is already checked. */
  accountId: string;
  /** A quoted original's attachments, whose own references go out inline too (forward). */
  quoted?: InlineImageSource[];
}

/**
 * The HTML with its inline images as `cid:` references, and the parts those
 * references need. HTML without minted URLs or quoted attachments comes back
 * unchanged, with no parts.
 */
export async function embedInlineImages(
  env: OutboundInlineImagesEnv,
  db: Database,
  html: string | undefined,
  input: OutboundInlineImagesInput,
): Promise<{ html: string | undefined; parts: InlineImagePart[] }> {
  if (!html) return { html, parts: [] };
  const minted = findInlineImageUrls(html);
  if (minted.length === 0 && !input.quoted?.length) return { html, parts: [] };

  const parts = partCollector(env.STORAGE);
  let out = html;

  if (minted.length > 0) {
    const sources = await sourcesForTokens(env, db, minted.map((m) => m.token), input);
    const swaps: Array<{ from: string; to: string | null }> = [];
    for (const { url, token } of minted) {
      const source = sources.get(token);
      const cid = source ? await parts.cidFor(source) : null;
      swaps.push({ from: url, to: cid ? `cid:${cid}` : null });
    }
    out = replaceInlineImageUrls(out, swaps);
  }

  if (input.quoted?.length) {
    out = await swapInlineReferences(out, input.quoted, { w: input.workspaceId }, async (source) => {
      const cid = await parts.cidFor(source);
      return cid ? `cid:${cid}` : null;
    });
  }

  return { html: out, parts: await parts.list() };
}

/**
 * The attachment each token points at, for the tokens that check out: sealed
 * by this deployment for this workspace, naming a live image attachment at
 * the key it was minted for, in a mailbox the caller may open.
 */
async function sourcesForTokens(
  env: OutboundInlineImagesEnv,
  db: Database,
  tokens: string[],
  input: OutboundInlineImagesInput,
): Promise<Map<string, InlineImageSource>> {
  const found = new Map<string, InlineImageSource>();
  const secret = inlineImageSecret(env);
  if (!secret) {
    console.warn('[mail-send] no inline-image secret; minted image URLs are dropped from the outgoing mail');
    return found;
  }

  const claimed = new Map<string, InlineImageClaims>();
  for (const token of tokens) {
    const claims = await readInlineImageClaims(secret, token);
    if (claims && claims.w === input.workspaceId && isWorkspaceStorageKey(claims.k, input.workspaceId)) {
      claimed.set(token, claims);
    }
  }
  if (claimed.size === 0) return found;

  const rows = await db
    .select({
      id: mailAttachments.id,
      messageId: mailAttachments.messageId,
      contentId: mailAttachments.contentId,
      storagePath: mailAttachments.storagePath,
      contentType: mailAttachments.contentType,
      fileName: mailAttachments.fileName,
      accountId: mailMessages.accountId,
    })
    .from(mailAttachments)
    .innerJoin(mailMessages, eq(mailMessages.id, mailAttachments.messageId))
    .where(
      and(
        inArray(mailAttachments.id, [...new Set([...claimed.values()].map((c) => c.a))]),
        isNull(mailAttachments.deletedAt),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));

  const access = new Map<string, Promise<boolean>>([[input.accountId, Promise.resolve(true)]]);
  const mayOpen = (accountId: string): Promise<boolean> => {
    let allowed = access.get(accountId);
    if (!allowed) {
      allowed = canOpenAccount(db, accountId, input.caller);
      access.set(accountId, allowed);
    }
    return allowed;
  };

  for (const [token, claims] of claimed) {
    const row = byId.get(claims.a);
    if (!row || row.storagePath !== claims.k || !isInlineImageType(row.contentType)) continue;
    if (!(await mayOpen(row.accountId))) continue;
    found.set(token, row);
  }
  return found;
}

/** Loads each attachment once and hands out its Content-ID; null when its bytes are gone. */
function partCollector(storage: R2Bucket | undefined) {
  const loaded = new Map<string, Promise<InlineImagePart | null>>();

  const load = async (source: InlineImageSource): Promise<InlineImagePart | null> => {
    if (!storage || !source.storagePath) return null;
    try {
      const object = await storage.get(source.storagePath);
      if (!object) return null;
      return {
        filename: source.fileName || source.storagePath.split('/').pop() || 'image',
        contentType: source.contentType?.split(';')[0]?.trim().toLowerCase() || object.httpMetadata?.contentType,
        content: await object.arrayBuffer(),
        // Unique per attachment, so two quoted messages that both used
        // `image001.png@…` don't collide.
        cid: `${source.id}@weldmail`,
      };
    } catch (err) {
      console.error(`[mail-send] Failed to load inline image ${source.id}:`, err);
      return null;
    }
  };

  return {
    async cidFor(source: InlineImageSource): Promise<string | null> {
      let part = loaded.get(source.id);
      if (!part) {
        part = load(source);
        loaded.set(source.id, part);
      }
      return (await part)?.cid ?? null;
    },
    /** The parts handed out so far, in the order they were first referenced. */
    async list(): Promise<InlineImagePart[]> {
      const all = await Promise.all(loaded.values());
      return all.filter((p): p is InlineImagePart => p !== null);
    },
  };
}
