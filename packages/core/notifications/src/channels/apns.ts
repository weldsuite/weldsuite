/**
 * APNs client for PushKit VoIP pushes — the WhatsApp-style incoming-call ring
 * on iOS. Expo's push service cannot send VoIP pushes (`apns-push-type: voip`),
 * so these go straight to Apple with a token-based provider key (.p8).
 *
 * Works in any runtime with `fetch` + WebCrypto. The ES256 provider JWT is
 * signed with WebCrypto (whose ECDSA output is already the raw r||s form JWS
 * wants) and reused for 50 minutes: Apple rejects tokens older than an hour and
 * throttles providers that mint a new one more than every 20 minutes.
 *
 * A device token belongs to either the production or the sandbox APNs
 * environment depending on how the app was signed (App Store / TestFlight vs a
 * development build), which the server cannot tell from the token. We try
 * production first and retry sandbox on `BadDeviceToken`.
 */

const APNS_HOSTS = ['https://api.push.apple.com', 'https://api.sandbox.push.apple.com'] as const;
const JWT_REUSE_MS = 50 * 60_000;

/** The provider-key secrets. All three are needed; any missing disables VoIP. */
export interface ApnsEnv {
  /** Key ID of the APNs auth key (.p8) in the Apple developer account. */
  APNS_KEY_ID?: string;
  /** Apple developer Team ID the key belongs to. */
  APNS_TEAM_ID?: string;
  /** The .p8 file's contents (PEM, `-----BEGIN PRIVATE KEY-----`). */
  APNS_PRIVATE_KEY?: string;
}

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKey: string;
}

export function apnsConfigFromEnv(env: ApnsEnv): ApnsConfig | null {
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const privateKey = env.APNS_PRIVATE_KEY?.trim();
  if (!keyId || !teamId || !privateKey) return null;
  return { keyId, teamId, privateKey };
}

export interface ApnsVoipMessage {
  /** Hex PushKit device token. */
  deviceToken: string;
  /** `<bundle id>.voip`. */
  topic: string;
  payload: Record<string, unknown>;
  /** Unix seconds after which Apple drops an undelivered push. 0 = try once. */
  expiration?: number;
}

export type ApnsResult =
  | { status: 'ok' }
  /** Apple says the token is dead (uninstalled, or never valid): stop using it. */
  | { status: 'invalid-token'; reason: string }
  | { status: 'error'; reason: string };

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64UrlFromString(value: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(value));
}

/** PEM (PKCS#8, as Apple ships the .p8) → DER bytes. Tolerates `\n` escapes from env files. */
export function pkcs8FromPem(pem: string): ArrayBuffer {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

let cachedJwt: { keyId: string; token: string; issuedAt: number } | null = null;

/** Reset the provider-token cache (tests). */
export function resetApnsTokenCache(): void {
  cachedJwt = null;
}

/** The ES256 provider JWT Apple authenticates the request with, cached per key. */
export async function apnsProviderToken(config: ApnsConfig, now = Date.now()): Promise<string> {
  if (cachedJwt && cachedJwt.keyId === config.keyId && now - cachedJwt.issuedAt < JWT_REUSE_MS) {
    return cachedJwt.token;
  }
  const header = base64UrlFromString(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const claims = base64UrlFromString(JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) }));
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8FromPem(config.privateKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );
  const token = `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;
  cachedJwt = { keyId: config.keyId, token, issuedAt: now };
  return token;
}

async function postToHost(
  host: string,
  jwt: string,
  message: ApnsVoipMessage,
): Promise<{ status: number; reason: string }> {
  const response = await fetch(`${host}/3/device/${message.deviceToken}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': message.topic,
      'apns-push-type': 'voip',
      // 10 = deliver immediately. VoIP pushes must always use it.
      'apns-priority': '10',
      'apns-expiration': String(message.expiration ?? 0),
      'content-type': 'application/json',
    },
    body: JSON.stringify(message.payload),
  });
  if (response.ok) return { status: response.status, reason: '' };
  const text = await response.text().catch(() => '');
  let reason = `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text) as { reason?: string };
    if (parsed.reason) reason = parsed.reason;
  } catch {
    // not JSON
  }
  return { status: response.status, reason };
}

/** Send one VoIP push. Never throws. */
export async function sendApnsVoipPush(config: ApnsConfig, message: ApnsVoipMessage): Promise<ApnsResult> {
  if (!/^[0-9a-fA-F]{64,200}$/.test(message.deviceToken)) {
    return { status: 'invalid-token', reason: 'Not a hex PushKit token' };
  }
  try {
    const jwt = await apnsProviderToken(config);
    let last = { status: 0, reason: '' };
    for (const host of APNS_HOSTS) {
      last = await postToHost(host, jwt, message);
      if (last.status === 200) return { status: 'ok' };
      // A sandbox token is "bad" for production and the other way round, so
      // only that error is worth a second try against the other environment.
      if (last.reason !== 'BadDeviceToken') break;
    }
    if (last.status === 410 || last.reason === 'BadDeviceToken' || last.reason === 'Unregistered') {
      return { status: 'invalid-token', reason: last.reason };
    }
    return { status: 'error', reason: last.reason };
  } catch (err) {
    return { status: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
}
