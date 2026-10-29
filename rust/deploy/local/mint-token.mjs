// The local stack's session key and tokens (README.md). Nothing here is a real
// credential: the key only exists on this machine, under .local/ (git-ignored).
//
//   node mint-token.mjs [days]
//
// - .local/keys/private.pem and .local/keys/jwks.json: an RSA key pair, made on
//   the first run and kept, so tokens stay valid across restarts. The server
//   reads jwks.json (CLERK_JWKS_FILE in compose.yaml).
// - .local/weldsuite-local.postman_environment.json: baseUrl, and Clerk-shaped
//   session tokens for the seeded admin and member (seed/tenant.sql), valid for
//   [days] (default 30). Import it into Postman next to the collection.
// - .local/admin-token.txt and .local/member-token.txt: the same two tokens.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const keys = path.join(here, '.local', 'keys');
const privatePath = path.join(keys, 'private.pem');
const days = Number(process.argv[2] ?? 30);
if (!Number.isFinite(days) || days <= 0) {
  console.error('usage: node mint-token.mjs [days]');
  process.exit(2);
}

const KID = 'weldsuite-local';
const ORG = 'org_local';

mkdirSync(keys, { recursive: true });
if (!existsSync(privatePath)) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
}
const privateKey = createPrivateKey(readFileSync(privatePath));
const jwk = { ...createPublicKey(privateKey).export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
writeFileSync(path.join(keys, 'jwks.json'), JSON.stringify({ keys: [jwk] }, null, 2));

const now = Math.floor(Date.now() / 1000);
const exp = now + Math.round(days * 86400);
function token(userId, role) {
  const header = { alg: 'RS256', typ: 'JWT', kid: KID };
  const payload = { sub: userId, sid: `sess_${userId}`, o: { id: ORG, rol: role }, fva: [0, 0], iat: now, nbf: now - 5, exp };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode(header)}.${encode(payload)}`;
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}

const admin = token('user_admin', 'admin');
const member = token('user_member', 'member');
const environment = {
  name: 'WeldSuite local',
  values: [
    { key: 'baseUrl', value: 'http://localhost:8080', type: 'default', enabled: true },
    { key: 'token', value: admin, type: 'secret', enabled: true },
    { key: 'adminToken', value: admin, type: 'secret', enabled: true },
    { key: 'memberToken', value: member, type: 'secret', enabled: true },
  ],
  _postman_variable_scope: 'environment',
};
const envPath = path.join(here, '.local', 'weldsuite-local.postman_environment.json');
writeFileSync(envPath, JSON.stringify(environment, null, 2));
// The same tokens as plain text, to paste into Postman's Bearer Token field.
const adminPath = path.join(here, '.local', 'admin-token.txt');
const memberPath = path.join(here, '.local', 'member-token.txt');
writeFileSync(adminPath, admin);
writeFileSync(memberPath, member);

console.log(`key:         ${path.join(keys, 'jwks.json')} (the server reads this)`);
console.log(`environment: ${envPath}`);
console.log(`admin token: ${adminPath}`);
console.log(`member token: ${memberPath}`);
console.log(`valid until ${new Date(exp * 1000).toISOString()}`);
