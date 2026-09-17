/**
 * Device-code sessions for `weld login`.
 *
 * Pending sessions live in WORKSPACE_CACHE (KV) under short TTLs. The CLI polls
 * with the device code; the developer portal approves with the user code after
 * Clerk sign-in + workspace selection, then mints a personal `wsk_` key.
 */

export const CLI_AUTH_TTL_SECONDS = 600;
export const CLI_AUTH_POLL_INTERVAL_SECONDS = 2;
export const CLI_KEY_NAME = 'Weld CLI';
export const CLI_KEY_SCOPES = ['user-apps:manage'] as const;

const DEVICE_PREFIX = 'cli-auth:device:';
const USER_PREFIX = 'cli-auth:user:';

/** Alphabet without ambiguous I/O/0/1 — easy to read aloud / type. */
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type CliAuthPending = {
  status: 'pending';
  deviceCode: string;
  userCode: string;
  createdAt: number;
};

export type CliAuthComplete = {
  status: 'complete';
  deviceCode: string;
  userCode: string;
  createdAt: number;
  apiKey: string;
  keyId: string;
  keyPrefix: string;
  orgId: string;
  orgName: string | null;
  userId: string;
  email: string | null;
  apiUrl: string;
};

export type CliAuthSession = CliAuthPending | CliAuthComplete;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function deviceKvKey(deviceCode: string): string {
  return `${DEVICE_PREFIX}${deviceCode}`;
}

export function userKvKey(userCode: string): string {
  return `${USER_PREFIX}${normalizeUserCode(userCode)}`;
}

export function normalizeUserCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function formatUserCode(normalized: string): string {
  const clean = normalizeUserCode(normalized);
  if (clean.length <= 4) return clean;
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

export function generateDeviceCode(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function generateUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length];
  }
  return out;
}

export async function putCliAuthSession(
  kv: KVNamespace,
  session: CliAuthSession,
  ttlSeconds = CLI_AUTH_TTL_SECONDS,
): Promise<void> {
  const payload = JSON.stringify(session);
  await Promise.all([
    kv.put(deviceKvKey(session.deviceCode), payload, { expirationTtl: ttlSeconds }),
    kv.put(userKvKey(session.userCode), session.deviceCode, { expirationTtl: ttlSeconds }),
  ]);
}

export async function getCliAuthByDevice(
  kv: KVNamespace,
  deviceCode: string,
): Promise<CliAuthSession | null> {
  return (await kv.get(deviceKvKey(deviceCode), 'json')) as CliAuthSession | null;
}

export async function getCliAuthByUserCode(
  kv: KVNamespace,
  userCode: string,
): Promise<CliAuthSession | null> {
  const deviceCode = await kv.get(userKvKey(userCode));
  if (!deviceCode) return null;
  return getCliAuthByDevice(kv, deviceCode);
}

export async function deleteCliAuthSession(kv: KVNamespace, session: CliAuthSession): Promise<void> {
  await Promise.all([
    kv.delete(deviceKvKey(session.deviceCode)),
    kv.delete(userKvKey(session.userCode)),
  ]);
}

/** Default external-api host for the minted key, from app-api ENVIRONMENT. */
export function defaultExternalApiUrl(environment: string | undefined): string {
  if (environment === 'test' || environment === 'preview') {
    return 'https://api-test.weldsuite.org';
  }
  return 'https://api.weldsuite.org';
}

/** Default developer-portal host for the verification URI. */
export function defaultLoginUrl(environment: string | undefined): string {
  if (environment === 'test' || environment === 'preview') {
    return 'https://developer-test.weldsuite.org';
  }
  return 'https://developer.weldsuite.org';
}

const ALLOWED_LOGIN_HOSTS = new Set([
  'developer.weldsuite.org',
  'developer-test.weldsuite.org',
  'localhost',
  '127.0.0.1',
]);

/** Reject open redirects — only first-party developer portal hosts. */
export function resolveLoginUrl(requested: string | undefined, environment: string | undefined): string {
  const fallback = defaultLoginUrl(environment);
  if (!requested) return fallback;
  try {
    const url = new URL(requested);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ALLOWED_LOGIN_HOSTS.has(url.hostname))) {
      return fallback;
    }
    if (!ALLOWED_LOGIN_HOSTS.has(url.hostname)) return fallback;
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      if (!url.port) url.port = '3202';
    }
    return url.origin;
  } catch {
    return fallback;
  }
}
