// A throwaway key and a session token signed with it, for the kind smoke
// test. Nothing here is a real credential.
//
//   node mint-token.mjs <out-dir> <user-id> <org-id>
//     A Clerk-shaped token: writes <out-dir>/public.pem (CLERK_JWT_KEY) and
//     <out-dir>/token.
//
//   node mint-token.mjs <out-dir> <user-id> <org-id> --oidc <issuer> <audience>
//     A Zitadel-shaped access token from <issuer>: writes
//     <out-dir>/openid-configuration and <out-dir>/jwks.json (what the
//     stand-in issuer serves, oidc-issuer.yaml) and <out-dir>/token.
import { generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const [outDir, userId, orgId, mode, issuer, audience] = process.argv.slice(2);
const oidc = mode === '--oidc';
if (!outDir || !userId || !orgId || (mode && !oidc) || (oidc && (!issuer || !audience))) {
  console.error('usage: node mint-token.mjs <out-dir> <user-id> <org-id> [--oidc <issuer> <audience>]');
  process.exit(2);
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const base64url = (value) => Buffer.from(value).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const kid = oidc ? 'smoke-oidc' : 'ins_smoke';
const header = { alg: 'RS256', typ: 'JWT', kid };
const times = { iat: now - 5, nbf: now - 5, exp: now + 3600 };
const payload = oidc
  ? {
      iss: issuer,
      sub: userId,
      aud: [audience],
      sid: 'V1_smoke',
      auth_time: now - 5,
      amr: ['pwd', 'mfa'],
      'urn:zitadel:iam:org:id': orgId,
      ...times,
    }
  : { sub: userId, sid: 'sess_smoke', o: { id: orgId, rol: 'member' }, fva: [0, 0], ...times };
const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
const signature = sign('sha256', Buffer.from(unsigned), privateKey).toString('base64url');

if (oidc) {
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  writeFileSync(path.join(outDir, 'jwks.json'), JSON.stringify({ keys: [jwk] }));
  writeFileSync(
    path.join(outDir, 'openid-configuration'),
    JSON.stringify({
      issuer,
      jwks_uri: `${issuer}/oauth/v2/keys`,
      id_token_signing_alg_values_supported: ['RS256'],
    }),
  );
} else {
  writeFileSync(path.join(outDir, 'public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
}
writeFileSync(path.join(outDir, 'token'), `${unsigned}.${signature}`);
