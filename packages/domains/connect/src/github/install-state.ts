/**
 * The signed `state` of the GitHub App install redirect (HS256 JWT, 600 s).
 * connect-api's install flow and merge-api's both sign and verify it here, so
 * either callback accepts a state the other issued. Web Crypto only. A state
 * is single use: its nonce is stored in KV when it is issued
 * (`rememberInstallNonce`) and taken when it is redeemed (`consumeInstallNonce`).
 *
 * The secret is the worker's `CLERK_SECRET_KEY` (Rust: falls back to
 * `INTERNAL_API_SECRET`). `workspaceId` is whatever ref the issuer holds
 * (`ws_…` or the Clerk org id); both resolve to the tenant DB.
 */

export interface InstallStatePayload {
  workspaceId: string;
  userId: string;
  projectId?: string;
  returnTo?: string;
  nonce: string;
}

export type VerifiedInstallState = InstallStatePayload & { iat: number; exp: number };

/** Signs a state; valid for `expirySeconds` (default ten minutes). */
export async function signInstallStateJwt(
  payload: InstallStatePayload,
  secret: string,
  expirySeconds = 600,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const claims = { ...payload, iat: now, exp: now + expirySeconds };
  const signingInput = `${base64urlEncode(JSON.stringify(header))}.${base64urlEncode(JSON.stringify(claims))}`;
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64urlFromBuffer(signature)}`;
}

/** The claims of a valid, unexpired state; null for anything else (callers reject the request). */
export async function verifyInstallStateJwt(token: string, secret: string): Promise<VerifiedInstallState | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const key = await importHmacKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64urlToBuffer(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!valid) return null;
    const claims = JSON.parse(base64urlDecode(encodedPayload)) as VerifiedInstallState;
    if (claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

/** A random 32-hex-char nonce for a new state. */
export function installStateNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** How long a state is valid, and so how long its nonce is kept. */
export const INSTALL_STATE_TTL_SECONDS = 600;

/** What the nonce store needs of a KV namespace (`WORKSPACE_CACHE`). */
export interface InstallNonceStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The KV key of an issued state's nonce. */
export const installNonceKey = (nonce: string): string => `merge_install_nonce:${nonce}`;

/**
 * Remembers the nonce of a state just issued, for the state's lifetime. Both
 * install routes (merge-api's and connect-api's) share `WORKSPACE_CACHE`, so
 * either setup redirect consumes a nonce the other stored.
 */
export async function rememberInstallNonce(kv: InstallNonceStore, nonce: string, workspaceId: string): Promise<void> {
  await kv.put(installNonceKey(nonce), workspaceId, { expirationTtl: INSTALL_STATE_TTL_SECONDS });
}

/**
 * Takes the nonce of a state being redeemed: true the first time, false when
 * it was never issued, already used or expired (the redirect answers
 * `error=state_expired`). A state is therefore good for one setup redirect.
 */
export async function consumeInstallNonce(kv: InstallNonceStore, nonce: string | undefined): Promise<boolean> {
  if (!nonce) return false;
  const key = installNonceKey(nonce);
  if ((await kv.get(key)) === null) return false;
  await kv.delete(key);
  return true;
}

function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

function base64urlEncode(input: string): string {
  return base64urlFromBuffer(new TextEncoder().encode(input).buffer as ArrayBuffer);
}

function base64urlFromBuffer(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64urlDecode(input: string): string {
  const base64 = input.replaceAll('-', '+').replaceAll('_', '/');
  return atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='));
}

function base64urlToBuffer(input: string): ArrayBuffer {
  const binary = base64urlDecode(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.codePointAt(i)!;
  return bytes.buffer;
}
