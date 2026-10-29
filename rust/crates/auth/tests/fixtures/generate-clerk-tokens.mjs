#!/usr/bin/env node
/**
 * Writes clerk-tokens.json: a public key (PEM and JWKS) and session tokens
 * shaped like Clerk's, for the weldsuite-auth tests.
 *
 *   node rust/crates/auth/tests/fixtures/generate-clerk-tokens.mjs
 *
 * The private key lives only in memory while this runs, so the fixture holds
 * nothing secret. Every run makes a new key: rerun it and commit the JSON
 * whenever a case is added. Times are fixed around NOW; the tests pass NOW to
 * the verifier instead of reading the clock.
 */
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NOW = 1_800_000_000;
const KID = 'ins_test_key';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

function rs256(payload, { key = privateKey, header = {} } = {}) {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: KID, ...header });
  const body = b64(payload);
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${signature}`;
}

const base = {
  sub: 'user_2abc',
  sid: 'sess_2abc',
  azp: 'https://app.weldsuite.org',
  iat: NOW - 60,
  nbf: NOW - 60,
  exp: NOW + 3600,
  v: 2,
  o: { id: 'org_2abc', rol: 'admin' },
  fva: [3, 7],
};

const without = (key) => Object.fromEntries(Object.entries(base).filter(([k]) => k !== key));

const hsHead = b64({ alg: 'HS256', typ: 'JWT', kid: KID });
const hsBody = b64(base);
const hs256 = `${hsHead}.${hsBody}.${createHmac('sha256', publicKeyPem).update(`${hsHead}.${hsBody}`).digest('base64url')}`;

const tokens = {
  valid: rs256(base),
  orgIdClaim: rs256({ ...without('o'), org_id: 'org_legacy' }),
  noOrg: rs256(without('o')),
  noAzp: rs256(without('azp')),
  extensionAzp: rs256({ ...base, azp: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }),
  foreignAzp: rs256({ ...base, azp: 'https://evil.example' }),
  emptyAzp: rs256({ ...base, azp: '' }),
  numericAzp: rs256({ ...base, azp: 42 }),
  noSub: rs256(without('sub')),
  emptySub: rs256({ ...base, sub: '' }),
  noSid: rs256(without('sid')),
  noFva: rs256(without('fva')),
  noSecondFactor: rs256({ ...base, fva: [3, -1] }),
  staleSecondFactor: rs256({ ...base, fva: [3, 25] }),
  malformedFva: rs256({ ...base, fva: [3, 'x'] }),
  expired: rs256({ ...base, exp: NOW - 10 }),
  expiredWithinSkew: rs256({ ...base, exp: NOW - 3 }),
  noExp: rs256(without('exp')),
  notYetValid: rs256({ ...base, nbf: NOW + 60 }),
  issuedInFuture: rs256({ ...base, iat: NOW + 60 }),
  wrongTyp: rs256(base, { header: { typ: 'at+jwt' } }),
  otherKey: rs256(base, { key: other.privateKey }),
  unknownKid: rs256(base, { header: { kid: 'ins_other' } }),
  hs256WithPublicKey: hs256,
  algNone: `${b64({ alg: 'none', typ: 'JWT' })}.${b64(base)}.`,
  malformed: 'not-a-jwt',
};

const fixture = { now: NOW, kid: KID, publicKeyPem, jwks: { keys: [jwk] }, tokens };
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'clerk-tokens.json');
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Wrote ${out}`);
