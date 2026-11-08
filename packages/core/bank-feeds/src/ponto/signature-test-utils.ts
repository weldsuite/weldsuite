/** Test helpers for Ponto's HTTP signatures: a fresh key, and a check of what a request carries. */
import { expect } from 'vitest';
import { pontoDigest, pontoSigningString, type SignableRequest } from './signature';

export function pem(label: string, der: Uint8Array): string {
  const body = btoa(String.fromCharCode(...der));
  return `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g)?.join('\n')}\n-----END ${label}-----`;
}

/** A fresh RSA key (none is committed): its PKCS#8 PEM and the public key that verifies it. */
export async function testKey(): Promise<{ privateKey: string; publicKey: CryptoKey; pkcs8: Uint8Array }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { privateKey: pem('PRIVATE KEY', pkcs8), publicKey: pair.publicKey, pkcs8 };
}

/** Check a request's `Digest` and `Signature` headers; returns the key id and `created`. */
export async function verifySignature(
  request: SignableRequest,
  publicKey: CryptoKey,
): Promise<{ keyId: string; created: number }> {
  const header = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'signature')?.[1] ?? '';
  const digest = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'digest')?.[1] ?? '';
  const params = Object.fromEntries(header.split(',').map((part) => {
    const at = part.indexOf('=');
    return [part.slice(0, at), part.slice(at + 1).replace(/^"|"$/g, '')];
  }));
  const created = Number(params.created);
  expect(params.algorithm).toBe('hs2019');
  expect(digest).toBe(await pontoDigest(request.body));
  const unsigned = { ...request, headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => !/^(signature|digest)$/i.test(name))) };
  const { headers, signingString } = pontoSigningString(unsigned, digest, created);
  expect(params.headers).toBe(headers);
  const signature = Uint8Array.from(atob(params.signature ?? ''), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, publicKey, signature, new TextEncoder().encode(signingString));
  expect(ok).toBe(true);
  return { keyId: params.keyId ?? '', created };
}
