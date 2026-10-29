/**
 * Opaque, versioned, base64url cursors for keyset mail listings (design §5).
 *
 * `ThreadCursor` is the unified-inbox cursor: one value-based position
 * `(latestAt, accountId, threadKey)` shared by every mailbox — not "one
 * position per mailbox" (the design's own correction, §5 / "Where the plan or
 * ADR is wrong", item 4). Each mailbox returns its own top page after the
 * same cursor value, and `./merge` takes the combined top page, so the cursor
 * is exact regardless of how many mailboxes are in play.
 *
 * `MessageCursor` is the per-message keyset `(sentAt, id)` used by single- and
 * cross-mailbox message lists.
 *
 * Encoding is base64url of a JSON object, versioned by a short prefix so a
 * future shape change can introduce `t2.`/`m2.` without breaking cursors
 * already handed out. Decoding is strict: a wrong prefix, invalid base64,
 * invalid JSON, or a shape that fails validation all decode to `null` rather
 * than throwing, since a cursor is caller-supplied input that must never take
 * a list request down.
 *
 * No I/O: safe in the object, in a worker, and in a test.
 */

import { z } from 'zod';

const THREAD_CURSOR_PREFIX = 't1.';
const MESSAGE_CURSOR_PREFIX = 'm1.';
const OFFSET_CURSOR_PREFIX = 'o:';

export interface ThreadCursor {
  latestAt: number;
  accountId: string;
  threadKey: string;
}

export interface MessageCursor {
  sentAt: number;
  id: string;
}

const threadCursorSchema = z
  .object({
    latestAt: z.number().finite(),
    accountId: z.string().min(1),
    threadKey: z.string().min(1),
  })
  .strict();

const messageCursorSchema = z
  .object({
    sentAt: z.number().finite(),
    id: z.string().min(1),
  })
  .strict();

/**
 * Trailing `=` padding stripped, without a `/=+$/`-style regex: unanchored at
 * the start, that pattern's backtracking is O(n²) on an adversarial input — a
 * real concern here since a cursor's payload (and so the length of this
 * base64 string) is caller-influenced. A linear scan from the end can't have
 * that problem.
 */
function stripBase64Padding(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 61 /* '=' */) end -= 1;
  return value.slice(0, end);
}

/** `btoa`/`atob` work on Latin-1 strings; this is the standard web-platform way to round-trip UTF-8 through them. */
function utf8ToBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return stripBase64Padding(btoa(binary).replace(/\+/g, '-').replace(/\//g, '_'));
}

/** `null` on anything that isn't valid base64url or doesn't decode to valid UTF-8 — tamper rejection, not an exception. */
function base64UrlToUtf8(input: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) return null;
  try {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    const binary = atob(padded + pad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function encode(prefix: string, value: unknown): string {
  return prefix + utf8ToBase64Url(JSON.stringify(value));
}

function decode<T>(prefix: string, raw: string, schema: z.ZodType<T>): T | null {
  if (!raw.startsWith(prefix)) return null;
  const json = base64UrlToUtf8(raw.slice(prefix.length));
  if (json == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function encodeThreadCursor(cursor: ThreadCursor): string {
  return encode(THREAD_CURSOR_PREFIX, cursor);
}

export function decodeThreadCursor(raw: string | null | undefined): ThreadCursor | null {
  if (!raw) return null;
  return decode(THREAD_CURSOR_PREFIX, raw, threadCursorSchema);
}

export function encodeMessageCursor(cursor: MessageCursor): string {
  return encode(MESSAGE_CURSOR_PREFIX, cursor);
}

export function decodeMessageCursor(raw: string | null | undefined): MessageCursor | null {
  if (!raw) return null;
  return decode(MESSAGE_CURSOR_PREFIX, raw, messageCursorSchema);
}

/**
 * The legacy `o:<offset>` cursor some callers still send (design §5: "legacy
 * `o:<offset>` is still decoded"). A non-negative integer; the caller is
 * responsible for the 5000 cap the design mentions for offset-mode paging.
 */
export function encodeOffsetCursor(offset: number): string {
  return `${OFFSET_CURSOR_PREFIX}${Math.max(0, Math.trunc(offset))}`;
}

export function decodeOffsetCursor(raw: string | null | undefined): number | null {
  if (!raw || !raw.startsWith(OFFSET_CURSOR_PREFIX)) return null;
  const digits = raw.slice(OFFSET_CURSOR_PREFIX.length);
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}
