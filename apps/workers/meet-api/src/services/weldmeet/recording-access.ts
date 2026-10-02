/**
 * Tokenized access to private meeting recordings.
 *
 * Recordings live in the PRIVATE `MEETING_RECORDINGS` bucket (no public
 * domain). A member who may read a recording asks `POST
 * /api/meeting-sessions/:id/recording/access`; we mint opaque, short-lived KV
 * tokens and hand back `/public/meeting-recordings/:token` URLs, which a
 * `<video>` / `<audio>` element or a download link can use without an
 * Authorization header. The token IS the credential, so it is random (192 bits),
 * expires after an hour, is read-only and scoped to one object.
 */

export const RECORDING_TOKEN_TTL_SECONDS = 60 * 60;
/** URL-safe base64 of 24 random bytes = 32 chars. */
export const RECORDING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;
export const PUBLIC_RECORDINGS_PATH = '/public/meeting-recordings';

export interface RecordingTokenGrant {
  /** Clerk org id the object belongs to. */
  orgId: string;
  sessionId: string;
  /** Object key in MEETING_RECORDINGS; always under `{orgId}/{sessionId}/`. */
  key: string;
  kind: 'video' | 'audio';
  contentType: string;
  /** Download file name (ASCII-safe). */
  filename: string;
  /** Who it was minted for (audit only). */
  userId: string;
}

export function recordingTokenKey(token: string): string {
  return `rec-token:${token}`;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newRecordingToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

/** `Team sync / Q3` -> `Team_sync_Q3`, bounded. */
export function safeFilename(title: string | null | undefined, ext: string): string {
  const base = (title ?? 'meeting')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return `${base || 'meeting'}.${ext}`;
}

/** Store a grant and return its token. */
export async function mintRecordingToken(
  kv: Pick<KVNamespace, 'put'>,
  grant: RecordingTokenGrant,
): Promise<string> {
  const token = newRecordingToken();
  await kv.put(recordingTokenKey(token), JSON.stringify(grant), {
    expirationTtl: RECORDING_TOKEN_TTL_SECONDS,
  });
  return token;
}

export type ByteRange = { offset: number; length: number };

/**
 * Parse a single-range `Range: bytes=...` header against an object of `size`
 * bytes. `null` = no (usable) range, serve the whole object; `'unsatisfiable'`
 * = answer 416. Multi-range and malformed headers are ignored, as RFC 9110 allows.
 */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, from = '', to = ''] = match;
  if (from === '' && to === '') return null;

  if (from === '') {
    const suffix = Number(to);
    if (suffix === 0) return 'unsatisfiable';
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }

  const start = Number(from);
  if (start >= size) return 'unsatisfiable';
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}
