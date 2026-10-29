// A throwaway RSA key and a Clerk-shaped session token signed with it, for the
// kind smoke test: the public key goes into the chart as CLERK_JWT_KEY, the
// token into the requests. Nothing here is a real credential.
//
//   node mint-token.mjs <out-dir> <user-id> <org-id>
//
// Writes <out-dir>/public.pem and <out-dir>/token.
import { generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const [outDir, userId, orgId] = process.argv.slice(2);
if (!outDir || !userId || !orgId) {
  console.error('usage: node mint-token.mjs <out-dir> <user-id> <org-id>');
  process.exit(2);
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const base64url = (value) => Buffer.from(value).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = { alg: 'RS256', typ: 'JWT', kid: 'ins_smoke' };
const payload = {
  sub: userId,
  sid: 'sess_smoke',
  o: { id: orgId, rol: 'member' },
  fva: [0, 0],
  iat: now - 5,
  nbf: now - 5,
  exp: now + 3600,
};
const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
const signature = sign('sha256', Buffer.from(unsigned), privateKey).toString('base64url');

writeFileSync(path.join(outDir, 'public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
writeFileSync(path.join(outDir, 'token'), `${unsigned}.${signature}`);
