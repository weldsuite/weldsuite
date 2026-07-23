import type { Context } from 'hono';
import type { Env, AuthInfo } from './protocol';

// ============================================================
// Shared crypto helpers (mirrors the pattern in src/index.ts)
// ============================================================

/**
 * Convert a PEM SPKI public key string into an ArrayBuffer suitable for
 * `crypto.subtle.importKey`.
 */
export function pemToBuffer(pem: string): ArrayBuffer {
  const lines = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s/g, '');
  const binary = atob(lines);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer.buffer;
}

/**
 * Decode a base64url-encoded string into an ArrayBuffer.
 */
export function base64UrlToBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
  const binary = atob(padded);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer.buffer;
}

/**
 * Verify an RS256 JWT signature against a PEM SPKI public key.
 * Throws if the signature is invalid.
 */
async function verifyRs256Signature(
  pemKey: string,
  jwtParts: string[],
): Promise<void> {
  const keyData = pemToBuffer(pemKey);
  const cryptoKey = await crypto.subtle.importKey(
    'spki',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const signedData = new TextEncoder().encode(`${jwtParts[0]}.${jwtParts[1]}`);
  const signature = base64UrlToBuffer(jwtParts[2]);

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signature,
    signedData,
  );
  if (!valid) {
    throw new Error('JWT signature verification failed');
  }
}

// ============================================================
// Token extraction helpers
// ============================================================

function extractToken(
  url: URL,
  authHeader: string | undefined,
  protocol: string | undefined,
): string | undefined {
  let token: string | undefined = url.searchParams.get('token') ?? undefined;

  if (!token && authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }
  if (!token && protocol) {
    const parts = protocol.split(', ');
    const tokenIndex = parts.indexOf('authorization');
    if (tokenIndex >= 0 && parts[tokenIndex + 1]) {
      token = parts[tokenIndex + 1];
    }
  }
  return token;
}

// ============================================================
// Public auth functions
// ============================================================

/**
 * Verify a Clerk JWT.
 *
 * Signature is verified via RS256 using `CLERK_JWT_KEY` (PEM SPKI).
 * After verifying the signature, `exp` is checked and, when `CLERK_ISSUER`
 * is configured, the `iss` claim is validated too.
 *
 * Token can arrive via query param `?token=`, Authorization: Bearer, or the
 * `authorization` WebSocket subprotocol.
 */
export async function verifyClerkJwt(c: Context<{ Bindings: Env }>): Promise<AuthInfo> {
  const url = new URL(c.req.url);
  const token = extractToken(
    url,
    c.req.header('Authorization'),
    c.req.header('Sec-WebSocket-Protocol'),
  );

  if (!token) {
    throw new Error('Missing authorization token');
  }

  const jwtParts = token.split('.');
  if (jwtParts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  // Verify RS256 signature against the Clerk public key.
  await verifyRs256Signature(c.env.CLERK_JWT_KEY, jwtParts);

  // Decode payload only after signature is confirmed.
  const payload = JSON.parse(atob(jwtParts[1].replace(/-/g, '+').replace(/_/g, '/')));

  // Check expiration.
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }

  // Verify issuer when the env var is configured.
  if (c.env.CLERK_ISSUER && payload.iss !== c.env.CLERK_ISSUER) {
    throw new Error('Invalid token issuer');
  }

  // Clerk v2 tokens use `o.id` for org, v1 used `org_id`.
  const orgId = payload.o?.id || payload.org_id || null;
  const orgRole = payload.o?.rol || payload.org_role || 'member';

  if (!orgId) {
    throw new Error('No organization in token');
  }

  return {
    userId: payload.sub,
    userName: payload.name || payload.first_name || 'Unknown',
    workspaceId: orgId,
    role: orgRole.replace('org:', ''), // "org:admin" → "admin"
    type: 'agent',
  };
}

/**
 * Verify a widget customer token (HS256, signed with WIDGET_TOKEN_SECRET).
 *
 * Signature is verified via HMAC-SHA256 using `WIDGET_TOKEN_SECRET`.
 * Token can arrive via query param `?token=`, Authorization: Bearer, or the
 * `authorization` WebSocket subprotocol.
 */
export async function verifyWidgetToken(
  c: Context<{ Bindings: Env }>,
): Promise<AuthInfo> {
  const url = new URL(c.req.url);
  const token = extractToken(
    url,
    c.req.header('Authorization'),
    c.req.header('Sec-WebSocket-Protocol'),
  );

  if (!token) {
    throw new Error('Missing widget token');
  }

  const jwtParts = token.split('.');
  if (jwtParts.length !== 3) {
    throw new Error('Invalid token format');
  }

  // Verify HS256 HMAC signature using WIDGET_TOKEN_SECRET.
  const secretBytes = new TextEncoder().encode(c.env.WIDGET_TOKEN_SECRET);
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  const signedData = new TextEncoder().encode(`${jwtParts[0]}.${jwtParts[1]}`);
  const signature = base64UrlToBuffer(jwtParts[2]);

  const valid = await crypto.subtle.verify('HMAC', hmacKey, signature, signedData);
  if (!valid) {
    throw new Error('Widget token signature verification failed');
  }

  // Decode payload only after signature is confirmed.
  const payload = JSON.parse(atob(jwtParts[1].replace(/-/g, '+').replace(/_/g, '/')));

  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Widget token expired');
  }

  return {
    userId: payload.customerId || payload.sub,
    userName: payload.customerName || 'Customer',
    workspaceId: payload.workspaceId,
    role: 'customer',
    type: 'customer',
    conversationId: payload.conversationId,
    widgetId: payload.widgetId,
  };
}

/**
 * Verify auth — tries Clerk JWT first, falls back to widget token.
 */
export async function verifyAuth(c: Context<{ Bindings: Env }>): Promise<AuthInfo> {
  try {
    return await verifyClerkJwt(c);
  } catch {
    return await verifyWidgetToken(c);
  }
}
