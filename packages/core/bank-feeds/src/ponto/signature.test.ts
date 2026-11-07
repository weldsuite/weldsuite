import { describe, expect, it } from 'vitest';
import { importPontoSigningKey, pontoDigest, pontoSignatureHeaders, pontoSigningString, type SignableRequest } from './signature';
import { pem, testKey, verifySignature } from './signature-test-utils';

// The same vectors as rust/crates/books-domain/src/bank_feeds/ponto_signature.rs.
const CREATED = 1599659223;
const EMPTY_DIGEST = 'SHA-512=z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==';
const TOKEN_DIGEST = 'SHA-512=SOVBxxLqSeamoFz1pCkbBH/Snw+ucxqSUDtsd8R9ABrFNBRtusOfY4BCV2/DEvC5Gl+M43b30SaMFcwAsURIWw==';

const tokenRequest = (): SignableRequest => ({
  method: 'POST',
  url: 'https://api.ibanity.com/ponto-connect/oauth2/token',
  headers: { Accept: 'application/json', Authorization: 'Basic Y2lkOmNzZWNyZXQ=', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=refresh_token&refresh_token=rt-1',
});

describe('Ponto request signing', () => {
  it('digests no body as the empty string, the value Isabel’s own example shows', async () => {
    expect(await pontoDigest(undefined)).toBe(EMPTY_DIGEST);
    expect(await pontoDigest('')).toBe(EMPTY_DIGEST);
  });

  it('signs a POST’s target, host, digest, created and authorization', async () => {
    const request = tokenRequest();
    const digest = await pontoDigest(request.body);
    expect(digest).toBe(TOKEN_DIGEST);
    expect(pontoSigningString(request, digest, CREATED)).toEqual({
      headers: '(request-target) host digest (created) authorization',
      signingString: [
        '(request-target): post /ponto-connect/oauth2/token',
        'host: api.ibanity.com',
        `digest: ${TOKEN_DIGEST}`,
        '(created): 1599659223',
        'authorization: Basic Y2lkOmNzZWNyZXQ=',
      ].join('\n'),
    });
  });

  it('signs a GET’s query and any ibanity-* header', () => {
    const request: SignableRequest = {
      method: 'GET',
      url: 'https://api.ibanity.com/ponto-connect/accounts?page%5Blimit%5D=100',
      headers: { 'Ibanity-Idempotency-Key': '61f02718', Authorization: 'Bearer at-1' },
    };
    expect(pontoSigningString(request, EMPTY_DIGEST, CREATED)).toEqual({
      headers: '(request-target) host digest (created) authorization ibanity-idempotency-key',
      signingString: [
        '(request-target): get /ponto-connect/accounts?page%5Blimit%5D=100',
        'host: api.ibanity.com',
        `digest: ${EMPTY_DIGEST}`,
        '(created): 1599659223',
        'authorization: Bearer at-1',
        'ibanity-idempotency-key: 61f02718',
      ].join('\n'),
    });
  });

  it('keeps a non-default port in the host', () => {
    const request = { ...tokenRequest(), url: 'https://localhost:8443/ponto-connect/accounts' };
    expect(pontoSigningString(request, EMPTY_DIGEST, CREATED).signingString).toContain('\nhost: localhost:8443\n');
  });

  it('signs with RSASSA-PSS SHA-256 and a 32-byte salt', async () => {
    const { privateKey, publicKey } = await testKey();
    const request = tokenRequest();
    const headers = await pontoSignatureHeaders(request, '62f02718-eeee-46e1-b5eb-e8fd6e799c2e', await importPontoSigningKey(privateKey), CREATED);
    expect(headers.Signature).toMatch(
      /^keyId="62f02718-eeee-46e1-b5eb-e8fd6e799c2e",created=1599659223,algorithm="hs2019",headers="\(request-target\) host digest \(created\) authorization",signature="[A-Za-z0-9+/]+=*"$/,
    );
    expect(await verifySignature({ ...request, headers: { ...request.headers, ...headers } }, publicKey)).toEqual({
      keyId: '62f02718-eeee-46e1-b5eb-e8fd6e799c2e',
      created: CREATED,
    });
  });

  it('takes a PKCS#1 key with escaped newlines', async () => {
    const { pkcs8, publicKey } = await testKey();
    // A 2048-bit PKCS#8 key is a 26-byte wrapper around its PKCS#1 key.
    const pkcs1 = pem('RSA PRIVATE KEY', pkcs8.slice(26)).replace(/\n/g, '\\n');
    const request = tokenRequest();
    const headers = await pontoSignatureHeaders(request, 'cert', await importPontoSigningKey(pkcs1), CREATED);
    expect(await verifySignature({ ...request, headers: { ...request.headers, ...headers } }, publicKey)).toEqual({
      keyId: 'cert',
      created: CREATED,
    });
  });

  it('refuses an encrypted or unreadable key as an auth error', async () => {
    await expect(importPontoSigningKey('-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----')).rejects.toMatchObject({
      provider: 'ponto',
      kind: 'auth',
    });
    await expect(importPontoSigningKey('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----')).rejects.toMatchObject({ kind: 'auth' });
  });
});
