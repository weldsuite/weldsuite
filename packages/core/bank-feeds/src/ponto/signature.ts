/**
 * Ibanity's HTTP request signatures for Ponto Connect: the `Digest` and
 * `Signature` headers a live application sends on every call
 * (https://documentation.isabel.eu/security#http-signature). The sandbox does
 * not need them. Mirrors `rust/crates/books-domain/src/bank_feeds/ponto_signature.rs`.
 *
 * The scheme is the draft "Signing HTTP Messages" with `hs2019`: RSASSA-PSS
 * over SHA-256 (MGF1 SHA-256, a 32-byte salt) of a signing string made of
 * `(request-target)`, `host`, `digest`, `(created)` and, when the request
 * carries them, `authorization` and any `ibanity-*` header. `Digest` is
 * SHA-512 of the body as sent, of "" when there is none. The key id is the
 * signature certificate's id in Isabel's developer portal, not the TLS
 * certificate's.
 */

import { FeedProviderError } from '../errors';
import { utf8 } from '../http';

/** The signature certificate a live Ponto application signs with (`PONTO_SIGNATURE_CERT_ID`, `PONTO_SIGNATURE_KEY`). */
export interface PontoSignatureConfig {
  /** The certificate's id in the developer portal: the header's `keyId`. */
  certificateId: string;
  /** Its private key, unencrypted PEM (PKCS#8 or PKCS#1). `\n` escapes are accepted. */
  privateKey: string;
}

/** A request about to be sent, as `requestJson` builds it. */
export interface SignableRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** The `Digest` header: SHA-512 of the body as sent, base64. */
export async function pontoDigest(body: string | undefined): Promise<string> {
  return `SHA-512=${base64(new Uint8Array(await crypto.subtle.digest('SHA-512', utf8(body ?? ''))))}`;
}

/** The signed header names (the `headers` parameter) and the signing string, in the same order. */
export function pontoSigningString(request: SignableRequest, digest: string, created: number): { headers: string; signingString: string } {
  const url = new URL(request.url);
  const names = ['(request-target)', 'host', 'digest', '(created)'];
  const lines = [
    `(request-target): ${request.method.toLowerCase()} ${url.pathname}${url.search}`,
    `host: ${url.host}`,
    `digest: ${digest}`,
    `(created): ${created}`,
  ];
  const entries = Object.entries(request.headers);
  const signed = [
    ...entries.filter(([name]) => name.toLowerCase() === 'authorization'),
    ...entries.filter(([name]) => name.toLowerCase().startsWith('ibanity-')),
  ];
  for (const [name, value] of signed) {
    lines.push(`${name.toLowerCase()}: ${value}`);
    names.push(name.toLowerCase());
  }
  return { headers: names.join(' '), signingString: lines.join('\n') };
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return [0x80 | bytes.length, ...bytes];
}

/** Wrap a PKCS#1 `RSAPrivateKey` in a PKCS#8 `PrivateKeyInfo`, the only private key form WebCrypto imports. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  // version 0, AlgorithmIdentifier { rsaEncryption, NULL }
  const algorithm = [0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octets = [0x04, ...derLength(pkcs1.length)];
  const head = [0x30, ...derLength(algorithm.length + octets.length + pkcs1.length), ...algorithm, ...octets];
  const out = new Uint8Array(new ArrayBuffer(head.length + pkcs1.length));
  out.set(head);
  out.set(pkcs1, head.length);
  return out;
}

function unreadable(): FeedProviderError {
  return new FeedProviderError('ponto', 'auth', 'Ponto signature key unreadable (an unencrypted RSA PEM key)');
}

/** Import the signature certificate's private key for RSASSA-PSS SHA-256. */
export async function importPontoSigningKey(pem: string): Promise<CryptoKey> {
  const text = pem.replace(/\\n/g, '\n');
  const label = /-----BEGIN ([A-Z ]+)-----/.exec(text)?.[1];
  if (label !== 'PRIVATE KEY' && label !== 'RSA PRIVATE KEY') throw unreadable();
  let der: Uint8Array<ArrayBuffer>;
  try {
    const binary = atob(text.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, ''));
    der = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i += 1) der[i] = binary.charCodeAt(i);
    if (label === 'RSA PRIVATE KEY') der = pkcs1ToPkcs8(der);
    return await crypto.subtle.importKey('pkcs8', der, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    throw unreadable();
  }
}

/**
 * The `Digest` and `Signature` headers for a request about to be sent,
 * `created` being the Unix time in seconds (Ibanity allows 60 seconds of drift).
 */
export async function pontoSignatureHeaders(
  request: SignableRequest,
  certificateId: string,
  key: CryptoKey,
  created: number,
): Promise<{ Digest: string; Signature: string }> {
  const digest = await pontoDigest(request.body);
  const { headers, signingString } = pontoSigningString(request, digest, created);
  const signature = base64(new Uint8Array(await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, key, utf8(signingString))));
  return {
    Digest: digest,
    Signature: `keyId="${certificateId}",created=${created},algorithm="hs2019",headers="${headers}",signature="${signature}"`,
  };
}
