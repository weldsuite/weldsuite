/**
 * GitHub App Authentication Service
 *
 * Mints GitHub App JWTs (RS256) and exchanges them for per-installation
 * access tokens. Uses the jose library (already used in some places in the
 * workspace) via importPKCS8 / SignJWT.
 *
 * Cloudflare Workers compatibility: uses Web Crypto only (no Node crypto).
 *
 * Note: @octokit/auth-app is NOT in core-api/package.json, so we implement
 * the token exchange manually using fetch against the GitHub REST API.
 */

// ============================================================================
// App JWT
// ============================================================================

/**
 * Mint a short-lived GitHub App JWT (valid for up to 10 minutes).
 * GitHub requires RS256, iss = App ID, exp <= iat + 600.
 *
 * The private key is provided as a PEM string from Cloudflare Worker secrets.
 * We use SubtleCrypto directly for RS256 since jose is not in package.json.
 */
export async function mintAppJwt(
  appId: string,
  privateKeyPem: string,
): Promise<string> {
  const key = await importRsaPrivateKey(privateKeyPem);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60, // backdate by 60s to cover clock skew
    exp: now + 540, // 9-minute lifetime (max is 10)
    iss: appId,
  };

  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(signingInput),
  );

  const encodedSignature = base64urlFromBuffer(signature);
  return `${signingInput}.${encodedSignature}`;
}

// ============================================================================
// Installation Token
// ============================================================================

/**
 * Exchange a GitHub App JWT for an installation access token.
 * The token is valid for 1 hour (GitHub enforces this).
 *
 * We cache the token in a module-level Map for the lifetime of a single
 * Worker invocation (short TTL via expiration check). Each Worker isolate
 * is short-lived so this avoids redundant GitHub API calls within a request.
 */
interface CachedToken {
  token: string;
  expiresAt: number; // Unix timestamp in seconds
}

const tokenCache = new Map<number, CachedToken>();

export async function getInstallationToken(
  appId: string,
  privateKeyPem: string,
  installationId: number,
): Promise<string> {
  const cached = tokenCache.get(installationId);
  const now = Math.floor(Date.now() / 1000);

  // Use cached token if it has more than 5 minutes remaining
  if (cached && cached.expiresAt - now > 300) {
    return cached.token;
  }

  const appJwt = await mintAppJwt(appId, privateKeyPem);

  const resp = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'WeldSuite-Core-API',
      },
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `GitHub installation token exchange failed (${resp.status}): ${body}`,
    );
  }

  const data = (await resp.json()) as {
    token: string;
    expires_at: string;
  };

  const expiresAt = Math.floor(new Date(data.expires_at).getTime() / 1000);
  tokenCache.set(installationId, { token: data.token, expiresAt });

  return data.token;
}

// ============================================================================
// GitHub App Installation Metadata (for callback)
// ============================================================================

export interface GithubInstallationMeta {
  id: number;
  appSlug: string;
  accountType: 'User' | 'Organization';
  accountLogin: string;
  repositorySelection: string;
}

/**
 * Fetch installation metadata using the App JWT.
 * Called during the OAuth callback to persist connection details.
 */
export async function fetchInstallationMeta(
  appId: string,
  privateKeyPem: string,
  installationId: number,
): Promise<GithubInstallationMeta> {
  const appJwt = await mintAppJwt(appId, privateKeyPem);

  const resp = await fetch(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'WeldSuite-Core-API',
      },
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Failed to fetch installation metadata (${resp.status}): ${body}`,
    );
  }

  const data = (await resp.json()) as {
    id: number;
    app_slug: string;
    account: { login: string; type: string };
    repository_selection: string;
  };

  return {
    id: data.id,
    appSlug: data.app_slug,
    accountType: data.account.type === 'Organization' ? 'Organization' : 'User',
    accountLogin: data.account.login,
    repositorySelection: data.repository_selection,
  };
}

// ============================================================================
// State JWT helpers (for install flow)
// ============================================================================

export interface InstallStatePayload {
  workspaceId: string;
  userId: string;
  projectId?: string;
  returnTo?: string;
  nonce: string;
}

/**
 * Sign a state JWT for the GitHub install redirect using HMAC-SHA256.
 * Not RS256 — we use a simpler symmetric token since this is short-lived
 * and used entirely within our own infrastructure.
 *
 * We do NOT use jose here because it is not in core-api package.json.
 * Instead we build a minimal HS256 JWT via Web Crypto.
 */
export async function signInstallStateJwt(
  payload: InstallStatePayload,
  secret: string,
  expirySeconds = 600,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const claims = { ...payload, iat: now, exp: now + expirySeconds };

  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64urlFromBuffer(signature)}`;
}

/**
 * Verify and decode a state JWT.
 * Returns null if expired or signature invalid — callers should treat null as a rejected request.
 */
export async function verifyInstallStateJwt(
  token: string,
  secret: string,
): Promise<(InstallStatePayload & { iat: number; exp: number }) | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const key = await importHmacKey(secret);
    const signatureBytes = base64urlToBuffer(encodedSignature);

    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes,
      new TextEncoder().encode(signingInput),
    );

    if (!valid) return null;

    const claims = JSON.parse(base64urlDecode(encodedPayload)) as InstallStatePayload & {
      iat: number;
      exp: number;
    };

    const now = Math.floor(Date.now() / 1000);
    if (claims.exp < now) return null;

    return claims;
  } catch {
    return null;
  }
}

// ============================================================================
// Web Crypto Helpers
// ============================================================================

async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  // Strip ANY PEM armor (PKCS#1 "RSA PRIVATE KEY", PKCS#8 "PRIVATE KEY", or a
  // bare base64 body where the header was stripped before storage) + whitespace.
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s/g, '');

  const raw = new Uint8Array(base64ToBuffer(body));
  const algo = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // GitHub App keys are PKCS#1; Web Crypto only imports PKCS#8. Try PKCS#8
  // directly first (in case it was converted), then wrap PKCS#1 → PKCS#8.
  try {
    return await crypto.subtle.importKey('pkcs8', raw.buffer as ArrayBuffer, algo, false, ['sign']);
  } catch (pkcs8Err) {
    try {
      return await crypto.subtle.importKey(
        'pkcs8',
        pkcs1ToPkcs8(raw).buffer as ArrayBuffer,
        algo,
        false,
        ['sign'],
      );
    } catch (pkcs1Err) {
      throw new Error(
        `Failed to import GitHub App private key (tried PKCS#8 and PKCS#1→PKCS#8). pkcs8: ${msg(pkcs8Err)}; pkcs1: ${msg(pkcs1Err)}`,
      );
    }
  }
}

/** DER length octets for a given content length. */
function encodeDerLength(len: number): number[] {
  if (len < 0x80) return [len];
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function derTlv(tag: number, content: number[]): number[] {
  return [tag, ...encodeDerLength(content.length), ...content];
}

/** Wrap a PKCS#1 RSAPrivateKey DER into a PKCS#8 PrivateKeyInfo DER. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  // AlgorithmIdentifier: SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }
  const algId = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ];
  const version = [0x02, 0x01, 0x00]; // INTEGER 0
  const privateKeyOctet = derTlv(0x04, Array.from(pkcs1)); // OCTET STRING { pkcs1 }
  const seq = derTlv(0x30, [...version, ...algId, ...privateKeyOctet]);
  return new Uint8Array(seq);
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const keyBytes = new TextEncoder().encode(secret);
  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function base64urlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  return base64urlFromBuffer(bytes.buffer as ArrayBuffer);
}

function base64urlFromBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  return atob(padded);
}

function base64urlToBuffer(input: string): ArrayBuffer {
  const binary = base64urlDecode(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
