/**
 * Inline images of stored mail, without a public storage URL (TASK-905).
 *
 * An `<img src="cid:…">` points at an attachment of the same message. The
 * inbound worker used to rewrite those references to the bucket's public URL,
 * which serves the file to anyone holding the link, with no session or expiry.
 * The stored HTML now keeps its `cid:` references, and mail-api swaps them
 * when a message is read for a short-lived URL to its own
 * `GET /public/mail-inline/:token` (an `<img>` cannot send a Clerk bearer).
 * Messages stored before the change still hold public URLs; those are swapped
 * the same way, matched on the attachment's storage key.
 *
 * Personal mailboxes (personal-api) use the same token and rewrite, with a
 * personal account as the owner instead of a workspace: their files sit under
 * `personal/<personalAccountId>/`, and personal-api serves its own
 * `GET /public/mail-inline/:token`.
 *
 * The token is sealed (AES-GCM), not just signed: it carries the object key,
 * and the key must not leak while the bucket still has a public domain.
 * The IV is derived from the claims, so one image keeps one URL for an expiry
 * window and the browser can cache it across reads.
 */

import { and, inArray, isNull } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import { isPersonalStorageKey, isWorkspaceStorageKey } from './attachments';

const { mailAttachments } = schema;

/** Path mail-api and personal-api serve inline images under (outside the /api/* auth chain). */
export const INLINE_IMAGE_PATH = '/public/mail-inline';

/** A minted URL lives at least this long… */
export const INLINE_IMAGE_TTL_SECONDS = 60 * 60;
/** …plus up to this much, so reads within one window mint the same URL. */
const EXPIRY_WINDOW_SECONDS = 15 * 60;

/**
 * What a token proves: this owner's attachment, at this key, until `e`. The
 * owner is a workspace (`w`) or a personal account (`p`), never both.
 */
export interface InlineImageClaims {
  /** Workspace id, for workspace mail. */
  w?: string;
  /** Personal account id, for personal mail. */
  p?: string;
  /** Attachment id. */
  a: string;
  /** Object key in the STORAGE bucket. */
  k: string;
  /** Content type to serve. */
  t: string;
  /** Expiry, unix seconds. */
  e: number;
}

/** Whose mail a reading route rewrites: a workspace or a personal account. */
export type InlineImageOwner =
  | { workspaceId: string; personalAccountId?: never }
  | { personalAccountId: string; workspaceId?: never };

/** What a reading route passes to mint inline-image URLs. */
export type InlineImageSigner = InlineImageOwner & {
  /** Origin that serves INLINE_IMAGE_PATH, e.g. `https://mail-api.weldsuite.org`. */
  baseUrl: string;
  /** Secret the token keys are derived from. */
  secret: string;
  /** Clock override for tests (ms). */
  now?: number;
};

/** The attachment fields a rewrite needs. */
export interface InlineAttachmentRef {
  id: string;
  messageId: string;
  contentId: string | null;
  storagePath: string | null;
  contentType: string | null;
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

interface TokenKeys {
  aead: CryptoKey;
  iv: CryptoKey;
}

const keyCache = new Map<string, Promise<TokenKeys>>();

function tokenKeys(secret: string): Promise<TokenKeys> {
  let keys = keyCache.get(secret);
  if (!keys) {
    keys = deriveTokenKeys(secret);
    keyCache.set(secret, keys);
  }
  return keys;
}

async function deriveTokenKeys(secret: string): Promise<TokenKeys> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  const hkdf = (info: string) => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(0),
    info: encoder.encode(info),
  });
  const [aead, iv] = await Promise.all([
    crypto.subtle.deriveKey(hkdf('weldmail:inline-image:aead:v1'), base, { name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
    crypto.subtle.deriveKey(
      hkdf('weldmail:inline-image:iv:v1'),
      base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign'],
    ),
  ]);
  return { aead, iv };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Seal claims into a URL-safe token. Same claims, same token. */
export async function sealInlineImageToken(secret: string, claims: InlineImageClaims): Promise<string> {
  const { aead, iv: ivKey } = await tokenKeys(secret);
  const plain = encoder.encode(JSON.stringify(claims));
  const iv = new Uint8Array(await crypto.subtle.sign('HMAC', ivKey, plain)).slice(0, 12);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aead, plain));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return toBase64Url(out);
}

/**
 * The claims of a token that this secret sealed and that has not expired;
 * null for anything else (tampered, foreign, expired, malformed).
 */
export async function openInlineImageToken(
  secret: string,
  token: string,
  now: number = Date.now(),
): Promise<InlineImageClaims | null> {
  const bytes = fromBase64Url(token);
  if (!bytes || bytes.length <= 12 + 16) return null;
  const { aead } = await tokenKeys(secret);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, aead, bytes.slice(12));
  } catch {
    return null;
  }
  let claims: InlineImageClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(plain)) as InlineImageClaims;
  } catch {
    return null;
  }
  const owners = [claims?.w, claims?.p].filter((o) => o !== undefined);
  if (
    owners.length !== 1 ||
    typeof owners[0] !== 'string' ||
    typeof claims.a !== 'string' ||
    typeof claims.k !== 'string' ||
    typeof claims.t !== 'string' ||
    typeof claims.e !== 'number'
  ) {
    return null;
  }
  if (claims.e * 1000 <= now) return null;
  return claims;
}

/**
 * True when the token's key sits in its owner's folder. Each serving route
 * also checks the owner kind is its own: mail-api serves workspace tokens
 * only, personal-api personal ones only.
 */
export function isOwnedStorageKey(owner: { w?: string; p?: string }, key: string): boolean {
  if (owner.w !== undefined) return owner.p === undefined && isWorkspaceStorageKey(key, owner.w);
  if (owner.p !== undefined) return isPersonalStorageKey(key, owner.p);
  return false;
}

/** Expiry for a URL minted now: at least the TTL, rounded up to the window. */
export function inlineImageExpiry(now: number = Date.now()): number {
  const earliest = Math.floor(now / 1000) + INLINE_IMAGE_TTL_SECONDS;
  return Math.ceil(earliest / EXPIRY_WINDOW_SECONDS) * EXPIRY_WINDOW_SECONDS;
}

/** Only images are served inline: a token never serves HTML or a script from the API origin. */
export function isInlineImageType(contentType: string | null | undefined): boolean {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return /^image\/[a-z0-9.+-]+$/.test(type);
}

// ---------------------------------------------------------------------------
// HTML rewrite
// ---------------------------------------------------------------------------

/** `<image001.png@x>` → `image001.png@x`. */
function bareContentId(contentId: string): string {
  return contentId.trim().replace(/^</, '').replace(/>$/, '');
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// `cid:` up to the end of the attribute / url() value.
const CID_REFERENCE = /cid:([^"'\s)<>]+)/gi;
// An absolute URL whose path is a workspace or personal mail-attachment key
// (the form the inbound worker wrote before TASK-905), whatever host served it.
const STORAGE_URL =
  /https?:\/\/[^/"'\s<>()]+\/((?:workspaces|personal)\/[^/"'\s<>()?#]+\/mail\/attachments\/[^"'\s<>()?#]+)/gi;

/**
 * Point a message's inline-image references at freshly minted URLs: `cid:`
 * references by the attachment's Content-ID, and public storage URLs by the
 * attachment's key. A reference that matches none of the message's own image
 * attachments is left as it is. Returns the HTML unchanged when there is
 * nothing to swap.
 */
export async function rewriteInlineImages(
  html: string,
  attachments: InlineAttachmentRef[],
  signer: InlineImageSigner,
): Promise<string> {
  if (!html || attachments.length === 0) return html;
  const owner =
    signer.workspaceId !== undefined ? { w: signer.workspaceId } : { p: signer.personalAccountId };
  const usable = attachments.filter(
    (a) => a.storagePath && isOwnedStorageKey(owner, a.storagePath) && isInlineImageType(a.contentType),
  );
  if (usable.length === 0) return html;

  const byContentId = new Map<string, InlineAttachmentRef>();
  const byKey = new Map<string, InlineAttachmentRef>();
  for (const a of usable) {
    if (a.contentId) byContentId.set(bareContentId(a.contentId), a);
    byKey.set(a.storagePath!, a);
  }

  const expiry = inlineImageExpiry(signer.now);
  const minted = new Map<string, string>();
  const urlFor = async (a: InlineAttachmentRef): Promise<string> => {
    const cached = minted.get(a.id);
    if (cached) return cached;
    const token = await sealInlineImageToken(signer.secret, {
      ...owner,
      a: a.id,
      k: a.storagePath!,
      t: a.contentType!.split(';')[0]!.trim().toLowerCase(),
      e: expiry,
    });
    const url = `${signer.baseUrl.replace(/\/+$/, '')}${INLINE_IMAGE_PATH}/${token}`;
    minted.set(a.id, url);
    return url;
  };

  const swaps: Array<{ from: string; to: string }> = [];
  for (const match of html.matchAll(CID_REFERENCE)) {
    const id = match[1]!;
    const att = byContentId.get(id) ?? byContentId.get(safeDecode(id));
    if (att) swaps.push({ from: match[0], to: await urlFor(att) });
  }
  for (const match of html.matchAll(STORAGE_URL)) {
    const att = byKey.get(match[1]!) ?? byKey.get(safeDecode(match[1]!));
    if (att) swaps.push({ from: match[0], to: await urlFor(att) });
  }
  if (swaps.length === 0) return html;

  let out = html;
  // Longest first, so a reference that is a prefix of another is not cut short.
  for (const { from, to } of swaps.sort((x, y) => y.from.length - x.from.length)) {
    out = out.replaceAll(from, to);
  }
  return out;
}

/** The attachments a rewrite needs for these messages (live rows only). */
export async function loadInlineAttachmentRefs(
  db: Database,
  messageIds: string[],
): Promise<InlineAttachmentRef[]> {
  if (messageIds.length === 0) return [];
  return db
    .select({
      id: mailAttachments.id,
      messageId: mailAttachments.messageId,
      contentId: mailAttachments.contentId,
      storagePath: mailAttachments.storagePath,
      contentType: mailAttachments.contentType,
    })
    .from(mailAttachments)
    .where(and(inArray(mailAttachments.messageId, messageIds), isNull(mailAttachments.deletedAt)));
}

/**
 * Rewrite `htmlBody` in place on every message that has attachments. Loads
 * the attachments unless the caller already holds them.
 */
export async function applyInlineImages(
  db: Database,
  messages: Array<{ id: string; htmlBody: string | null; hasAttachments: boolean | null }>,
  signer: InlineImageSigner,
  loaded?: InlineAttachmentRef[],
): Promise<void> {
  const withHtml = messages.filter((m) => m.htmlBody && m.hasAttachments);
  if (withHtml.length === 0) return;
  const refs = loaded ?? (await loadInlineAttachmentRefs(db, withHtml.map((m) => m.id)));
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
