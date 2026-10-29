/**
 * Mail bodies and raw MIME in R2 (docs/plans/weldmail-mailbox-store-design.md,
 * decision 4; docs/plans/weldmail-mailbox-storage.md phase 2 item 2).
 *
 * No `body_key` / `search_text` columns: every object lives at a deterministic
 * key, so nothing needs to be looked up to find it:
 *
 *   mail/<workspaceId>/<accountId>/<messageId>/body.html
 *   mail/<workspaceId>/<accountId>/<messageId>/body.txt
 *   mail/<workspaceId>/<accountId>/<messageId>/raw.eml
 *
 * `workspaceId` is always `workspaces.id` (the `ws_…` master id), never the
 * Clerk org id — this is a new prefix, not the `workspaces/<id>/` one
 * `@weldsuite/worker-kit/storage` manages, so it carries its own id choice.
 *
 * Every function here is pure over an `R2Bucket`-shaped parameter: no env,
 * no bucket selection. The design puts bodies in the existing `STORAGE`
 * bucket (`weldsuite-storage(-test)`); callers pass that binding in.
 */

export interface MailboxRef {
  /** `workspaces.id` (the `ws_…` id). */
  workspaceId: string;
  accountId: string;
}

export interface MailBodyRef extends MailboxRef {
  messageId: string;
}

export interface MessageBodies {
  html: string | null;
  text: string | null;
}

/** A ref segment must be a single non-empty path component: no `/`, no `..`. */
function assertSafeSegment(value: string, label: string): string {
  if (!value || value.includes('/') || value.includes('..')) {
    throw new Error(`Invalid mail object ref: ${label} must be a plain id, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** `mail/<workspaceId>/<accountId>/` — every object of every message in this mailbox. */
export function mailboxObjectPrefix(ref: MailboxRef): string {
  const workspaceId = assertSafeSegment(ref.workspaceId, 'workspaceId');
  const accountId = assertSafeSegment(ref.accountId, 'accountId');
  return `mail/${workspaceId}/${accountId}/`;
}

/** `mail/<workspaceId>/<accountId>/<messageId>/` — every object of one message. */
export function messageObjectPrefix(ref: MailBodyRef): string {
  const messageId = assertSafeSegment(ref.messageId, 'messageId');
  return `${mailboxObjectPrefix(ref)}${messageId}/`;
}

export function bodyHtmlKey(ref: MailBodyRef): string {
  return `${messageObjectPrefix(ref)}body.html`;
}

export function bodyTextKey(ref: MailBodyRef): string {
  return `${messageObjectPrefix(ref)}body.txt`;
}

export function rawMimeKey(ref: MailBodyRef): string {
  return `${messageObjectPrefix(ref)}raw.eml`;
}

/** Every object key a message can own, in a fixed order. */
export function messageObjectKeys(ref: MailBodyRef): [html: string, text: string, raw: string] {
  return [bodyHtmlKey(ref), bodyTextKey(ref), rawMimeKey(ref)];
}

/**
 * Write whichever of `html`/`text` are given (skips `null`/`undefined`, so a
 * partial call never clobbers the other part). Both puts run in parallel.
 */
export async function putMessageBodies(
  bucket: R2Bucket,
  ref: MailBodyRef,
  bodies: { html?: string | null; text?: string | null },
): Promise<void> {
  const puts: Promise<unknown>[] = [];
  if (bodies.html !== null && bodies.html !== undefined) {
    puts.push(
      bucket.put(bodyHtmlKey(ref), bodies.html, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
      }),
    );
  }
  if (bodies.text !== null && bodies.text !== undefined) {
    puts.push(
      bucket.put(bodyTextKey(ref), bodies.text, {
        httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      }),
    );
  }
  await Promise.all(puts);
}

/** Both bodies, in parallel. A missing object is `null`, never a throw. */
export async function getMessageBodies(bucket: R2Bucket, ref: MailBodyRef): Promise<MessageBodies> {
  const [html, text] = await Promise.all([bucket.get(bodyHtmlKey(ref)), bucket.get(bodyTextKey(ref))]);
  return {
    html: html ? await html.text() : null,
    text: text ? await text.text() : null,
  };
}

/** The raw RFC 5322 source, for forward-as-attachment and the subscriptions scan. */
export async function putRawMime(
  bucket: R2Bucket,
  ref: MailBodyRef,
  bytes: ArrayBuffer | Uint8Array,
): Promise<void> {
  await bucket.put(rawMimeKey(ref), bytes, {
    httpMetadata: { contentType: 'message/rfc822' },
  });
}

/** The full raw message, or `null` when it was never stored (never throws on absence). */
export async function getRawMime(bucket: R2Bucket, ref: MailBodyRef): Promise<ArrayBuffer | null> {
  const obj = await bucket.get(rawMimeKey(ref));
  return obj ? await obj.arrayBuffer() : null;
}

/**
 * The first `maxBytes` of the raw message, decoded as text — enough for the
 * headers a `List-Unsubscribe` scan needs, without pulling a whole raw body.
 * `null` when there is no raw object. R2 clamps the range to the object's
 * actual size, so this is safe for a message shorter than `maxBytes`.
 */
export async function getRawMimeHeader(
  bucket: R2Bucket,
  ref: MailBodyRef,
  maxBytes: number,
): Promise<string | null> {
  const obj = await bucket.get(rawMimeKey(ref), { range: { offset: 0, length: maxBytes } });
  return obj ? await obj.text() : null;
}

/** Delete every object of one message (bodies + raw). Idempotent. */
export async function deleteMessageObjects(bucket: R2Bucket, ref: MailBodyRef): Promise<void> {
  await bucket.delete(messageObjectKeys(ref));
}

/** R2 `list()` returns at most this many keys per page. */
const LIST_PAGE_SIZE = 1000;

/**
 * Delete every object of every message in a mailbox — workspace or mail
 * account teardown. Lists `mail/<ws>/<accountId>/` in pages and deletes each
 * page before listing the next, so it scales past one `list()` page.
 * `pageSize` defaults to R2's own page cap; tests pass a smaller one to
 * exercise the loop without creating thousands of fake objects.
 */
export async function deleteMailboxObjects(
  bucket: R2Bucket,
  ref: MailboxRef,
  pageSize = LIST_PAGE_SIZE,
): Promise<{ deleted: number }> {
  const prefix = mailboxObjectPrefix(ref);
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await bucket.list({ prefix, cursor, limit: pageSize });
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((o) => o.key));
      deleted += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { deleted };
}
