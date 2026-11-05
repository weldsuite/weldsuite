#!/usr/bin/env node
// Writes a cluster's secrets file from ../secrets/examples/secrets.example.yaml
// with every value that isn't a provider's key generated: database passwords,
// DATABASE_ENCRYPTION_KEY (64 hex), the Zitadel masterkey (32 characters) and
// first admin password, the sign, storage and realtime secrets. Provider keys
// come from these environment variables when set, and stay CHANGE_ME otherwise:
//
//   FILES_S3_ACCESS_KEY_ID, FILES_S3_SECRET_ACCESS_KEY    the files bucket
//   BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY  the backup bucket
//   ZITADEL_SERVICE_TOKEN                                 the weldsuite service user's PAT
//   GHCR_USER, GHCR_TOKEN                                 pulling private images
//
//   node rust/deploy/flux/scripts/fill-secrets.mjs rust/deploy/flux/secrets/test/secrets.sops.yaml
//
// The file it writes is plaintext: fill in what it lists as left, then
// `sops --encrypt --in-place` it before anything else. It never overwrites.
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.argv[2];
if (!out) {
  console.error('usage: node fill-secrets.mjs <output file>');
  process.exit(2);
}
if (existsSync(out)) {
  console.error(`${out} already exists; not overwriting it`);
  process.exit(1);
}

const example = join(
  dirname(fileURLToPath(import.meta.url)),
  '../secrets/examples/secrets.example.yaml',
);

const hex = (bytes) => randomBytes(bytes).toString('hex');
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const alnum = (length) => Array.from({ length }, () => ALNUM[randomInt(ALNUM.length)]).join('');

// Bare CHANGE_ME values that a provider issues, by `<Secret>/<key>`.
const PROVIDED = {
  'weldsuite-env/S3_ACCESS_KEY_ID': 'FILES_S3_ACCESS_KEY_ID',
  'weldsuite-env/S3_SECRET_ACCESS_KEY': 'FILES_S3_SECRET_ACCESS_KEY',
  'postgres-backup-s3/ACCESS_KEY_ID': 'BACKUP_S3_ACCESS_KEY_ID',
  'postgres-backup-s3/ACCESS_SECRET_KEY': 'BACKUP_S3_SECRET_ACCESS_KEY',
  'weldsuite-env/ZITADEL_SERVICE_TOKEN': 'ZITADEL_SERVICE_TOKEN',
};

function bareValue(secret, key) {
  const variable = PROVIDED[`${secret}/${key}`];
  if (variable) return process.env[variable] || 'CHANGE_ME';
  // 32 bytes of hex: also the format DATABASE_ENCRYPTION_KEY needs (AES-256).
  return hex(32);
}

// Named placeholders stand for one value wherever they appear (a password and
// the connection URL that uses it), so each gets generated once.
const named = new Map();
function namedValue(token) {
  if (token === 'CHANGE_ME_EXACTLY_32_CHARACTERS_') return alnum(32);
  // Zitadel's password policy: upper, lower, digit and symbol.
  if (token === 'CHANGE_ME_Aa1!') return `${alnum(24)}Aa1!`;
  if (token === 'CHANGE_ME_BASE64_USER_COLON_TOKEN') {
    const { GHCR_USER, GHCR_TOKEN } = process.env;
    return GHCR_USER && GHCR_TOKEN
      ? Buffer.from(`${GHCR_USER}:${GHCR_TOKEN}`).toString('base64')
      : token;
  }
  if (!named.has(token)) named.set(token, hex(24));
  return named.get(token);
}

let secret = '';
let header = true;
const lines = [
  '# PLAINTEXT secrets written by rust/deploy/flux/scripts/fill-secrets.mjs.',
  '# Encrypt before anything else: sops --encrypt --in-place <this file>',
];
for (const line of readFileSync(example, 'utf8').split(/\r?\n/)) {
  // The example's own header explains the example; drop it.
  if (header) {
    if (line.startsWith('#') || line === '') continue;
    header = false;
  }
  const name = /^ {2}name: (\S+)$/.exec(line);
  if (name) secret = name[1];
  const bare = /^( {2}([A-Za-z0-9_.]+): )CHANGE_ME$/.exec(line);
  const filled = bare ? bare[1] + bareValue(secret, bare[2]) : line;
  lines.push(filled.replace(/CHANGE_ME_[A-Za-z0-9_]+!?/g, namedValue));
}

writeFileSync(out, `${lines.join('\n')}\n`, { mode: 0o600 });

secret = '';
let namespace = '';
const left = [];
for (const line of lines) {
  const name = /^ {2}name: (\S+)$/.exec(line);
  if (name) secret = name[1];
  const ns = /^ {2}namespace: (\S+)$/.exec(line);
  if (ns) namespace = ns[1];
  const entry = /^ {2}([A-Za-z0-9_.]+): .*CHANGE_ME/.exec(line);
  if (entry) left.push(`${namespace}/${secret}: ${entry[1]}`);
}

console.log(`wrote ${out} (plaintext)`);
if (left.length > 0) {
  console.log('still CHANGE_ME, fill these in by hand:');
  for (const entry of left) console.log(`  ${entry}`);
  console.log('(registry: delete that Secret instead when the images are public)');
}
console.log('Keep DATABASE_ENCRYPTION_KEY and the Zitadel masterkey in the password');
console.log('manager too, then: sops --encrypt --in-place ' + out);
