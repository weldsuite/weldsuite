/**
 * Signed cancel / reschedule links for a booking.
 *
 * A booking id alone is not enough to cancel or move a booking: the guest
 * needs the matching token, which is only ever handed out in the confirmation
 * (and reschedule) email and to the browser that made the booking. The token is
 * an HMAC-SHA256 of the booking id, so nothing extra has to be stored.
 *
 * Kept free of imports so it can be unit-tested with the Node test runner
 * (`pnpm test`). Uses Web Crypto, which exists in both the Node and edge runtimes.
 */

const LINK_KEY_LABEL = 'weldsuite:booking-links:v1';
const TOKEN_LABEL = 'weldsuite:booking-manage:v1';

const encoder = new TextEncoder();

/**
 * The signing secret: an explicit `BOOKING_LINK_SECRET`, otherwise one derived
 * from the tenant-DB encryption key the portal already needs to run. Returns
 * null when neither is configured.
 */
export function resolveLinkSecret(env: Record<string, string | undefined>): string | null {
  const candidate =
    env.BOOKING_LINK_SECRET?.trim() ||
    env.DATABASE_ENCRYPTION_KEY?.trim() ||
    env.DATABASE_ENCRYPTION_KEY_V2?.trim();
  return candidate || null;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  // Domain-separate from the other uses of the secret before signing with it.
  const base = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const derived = await crypto.subtle.sign('HMAC', base, encoder.encode(LINK_KEY_LABEL));
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** Token that authorises cancelling / rescheduling `bookingId`. */
export async function signBookingToken(secret: string, bookingId: string): Promise<string> {
  const key = await hmacKey(secret, 'sign');
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${TOKEN_LABEL}:${bookingId}`));
  return toBase64Url(new Uint8Array(signature));
}

/** Constant-time check of a token against a booking id. */
export async function verifyBookingToken(
  secret: string,
  bookingId: string,
  token: string | null | undefined,
): Promise<boolean> {
  if (!token) return false;
  const signature = fromBase64Url(token);
  if (!signature) return false;
  const key = await hmacKey(secret, 'verify');
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(`${TOKEN_LABEL}:${bookingId}`));
}

export type ManageAction = 'reschedule' | 'cancel';

/** Link that opens the portal's reschedule / cancel flow for a booking. */
export function buildManageUrl(params: {
  origin: string;
  workspaceSlug: string;
  pageSlug: string;
  bookingId: string;
  token: string;
  action: ManageAction;
}): string {
  const origin = params.origin.replace(/\/+$/, '');
  const query = new URLSearchParams({
    booking: params.bookingId,
    token: params.token,
    action: params.action,
  });
  return `${origin}/${encodeURIComponent(params.workspaceSlug)}/${encodeURIComponent(params.pageSlug)}?${query.toString()}`;
}

/**
 * The public origin of the portal: an explicit override, otherwise the host the
 * request came in on (behind a proxy the forwarded headers win).
 */
export function resolvePortalOrigin(params: {
  override?: string | null;
  forwardedHost?: string | null;
  host?: string | null;
  forwardedProto?: string | null;
}): string | null {
  const override = params.override?.trim();
  if (override) return override.replace(/\/+$/, '');
  const host = (params.forwardedHost || params.host)?.split(',')[0]?.trim();
  if (!host) return null;
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const proto = params.forwardedProto?.split(',')[0]?.trim() || (isLocal ? 'http' : 'https');
  return `${proto}://${host}`;
}
