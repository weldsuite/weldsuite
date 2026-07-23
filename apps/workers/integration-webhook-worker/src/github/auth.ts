/**
 * GitHub App Authentication — mints App JWTs and installation access tokens.
 * Web Crypto only (Cloudflare Workers compatible). Ported from core-api as part
 * of consolidating GitHub onto app-api + integration-webhook-worker.
 */

const USER_AGENT = 'WeldSuite-Integration-Webhooks';

export async function mintAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const key = await importRsaPrivateKey(privateKeyPem);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: now - 60, exp: now + 540, iss: appId };

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

interface CachedToken {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<number, CachedToken>();

export async function getInstallationToken(
  appId: string,
  privateKeyPem: string,
  installationId: number,
): Promise<string> {
  const cached = tokenCache.get(installationId);
  const now = Math.floor(Date.now() / 1000);
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
        'User-Agent': USER_AGENT,
      },
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GitHub installation token exchange failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as { token: string; expires_at: string };
  const expiresAt = Math.floor(new Date(data.expires_at).getTime() / 1000);
  tokenCache.set(installationId, { token: data.token, expiresAt });
  return data.token;
}

// ── Web Crypto helpers ───────────────────────────────────────

async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s/g, '');

  const raw = new Uint8Array(base64ToBuffer(body));
  const algo = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // GitHub App keys are PKCS#1; Web Crypto only imports PKCS#8. Try PKCS#8
  // directly first, then wrap PKCS#1 → PKCS#8.
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
  const algId = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ];
  const version = [0x02, 0x01, 0x00];
  const privateKeyOctet = derTlv(0x04, Array.from(pkcs1));
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
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
