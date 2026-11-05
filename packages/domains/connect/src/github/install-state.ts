/**
 * The signed `state` of the GitHub App install redirect (HS256 JWT, 600 s).
 * connect-api's install flow and merge-api's both sign and verify it here, so
 * either callback accepts a state the other issued. Web Crypto only.
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
