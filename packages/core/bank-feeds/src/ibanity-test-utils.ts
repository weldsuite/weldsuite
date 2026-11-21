/** An RSA key pair and RS512 tokens shaped like Ibanity's webhook signatures, for tests. */
import { utf8 } from './http';
import { bytesToBase64Url } from './test-utils';
import type { IbanityWebhookKey } from './webhook';

export async function ibanityTestKey(kid: string): Promise<{ privateKey: CryptoKey; jwk: IbanityWebhookKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-512' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, jwk: { e: exported.e ?? '', kid, kty: 'RSA', n: exported.n ?? '' } };
}

/** The `Signature` header Ibanity sends; `iss` is Ibanity's unless the claims say otherwise. */
export async function ibanityToken(privateKey: CryptoKey, kid: string, claims: Record<string, unknown>, alg = 'RS512'): Promise<string> {
  const encode = (value: unknown) => bytesToBase64Url(utf8(JSON.stringify(value)));
  const header = encode({ alg, kid });
  const payload = encode({ iss: 'https://api.ibanity.com', jti: 'jti-1', ...claims });
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, utf8(`${header}.${payload}`));
  return `${header}.${payload}.${bytesToBase64Url(signature)}`;
}
