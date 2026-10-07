/**
 * GitHub App installation-token minting — shared between `connect-api`
 * (WeldFlow's GitHub project sync, `services/github/auth.ts`) and
 * `workflow-worker` (the `github.*` WeldConnect provider actions,
 * `engine/actions/providers/github.ts`). Workers never import each other's
 * `src/`, so this is the one place the JWT-signing + token-exchange logic
 * lives; both callers import it from here instead of keeping their own copy.
 *
 * WeldConnect's GitHub integration deliberately reuses the GitHub App
 * installation workspaces already set up for WeldFlow's issue/PR sync
 * (`github_connections`, one row per workspace) rather than adding a second,
 * separate OAuth app — see "Provider pattern" in docs/plans/weldconnect.md.
 * A `workflow_integrations` row of type `github` stores the installation id
 * in `settings.installationId`; no long-lived secret is stored for it at
 * all — every action mints a fresh ~1h installation token on demand.
 *
 * Cloudflare Workers compatibility: Web Crypto only (no Node `crypto`), same
 * constraint as the connect-api original this is ported from.
 */

// ============================================================================
// App JWT
// ============================================================================

/**
 * Mint a short-lived GitHub App JWT (valid for up to 10 minutes).
 * GitHub requires RS256, iss = App ID, exp <= iat + 600.
 */
export async function mintGithubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
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

  return `${signingInput}.${base64urlFromBuffer(signature)}`;
}

// ============================================================================
// Installation Token
// ============================================================================

/**
 * Installation ids are positive integers. Validate before interpolating one
 * into a request path, since callers resolve it from `workflow_integrations.
 * settings` (a JSON blob) or a query string.
 */
function installationUrl(installationId: number): string {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error(`Invalid GitHub installation id: ${installationId}`);
  }
  return `https://api.github.com/app/installations/${installationId}`;
}

interface CachedToken {
  token: string;
  expiresAt: number; // Unix timestamp in seconds
}

// Module-level cache — each Worker isolate is short-lived, so this only ever
// saves a redundant GitHub call within a single invocation (not a durable
// cache). Keyed per-module so connect-api and workflow-worker each get their
// own isolate-local cache.
const tokenCache = new Map<number, CachedToken>();

/**
 * Exchange a GitHub App JWT for a per-installation access token (valid for
 * 1 hour; GitHub enforces this). Cached in-isolate while it has more than 5
 * minutes left.
 */
export async function getGithubInstallationToken(
  appId: string,
  privateKeyPem: string,
  installationId: number,
): Promise<string> {
  const cached = tokenCache.get(installationId);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - now > 300) {
    return cached.token;
  }

  const appJwt = await mintGithubAppJwt(appId, privateKeyPem);
  const resp = await fetch(`${installationUrl(installationId)}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'WeldSuite-WeldConnect',
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub installation token exchange failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as { token: string; expires_at: string };
  const expiresAt = Math.floor(new Date(data.expires_at).getTime() / 1000);
  tokenCache.set(installationId, { token: data.token, expiresAt });
  return data.token;
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
      return await crypto.subtle.importKey('pkcs8', pkcs1ToPkcs8(raw).buffer as ArrayBuffer, algo, false, ['sign']);
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
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const version = [0x02, 0x01, 0x00]; // INTEGER 0
  const privateKeyOctet = derTlv(0x04, Array.from(pkcs1)); // OCTET STRING { pkcs1 }
  const seq = derTlv(0x30, [...version, ...algId, ...privateKeyOctet]);
  return new Uint8Array(seq);
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

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
