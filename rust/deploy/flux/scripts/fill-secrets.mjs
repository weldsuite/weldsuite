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
//   ADMIN_OIDC_CLIENT_ID, ADMIN_OIDC_CLIENT_SECRET        the admin console's Zitadel app
//   GHCR_USER, GHCR_TOKEN                                 pulling private images
//   MARKETING_GHCR_USER, MARKETING_GHCR_TOKEN             the marketing site's chart and image
//
// A new cluster:
//
//   node rust/deploy/flux/scripts/fill-secrets.mjs rust/deploy/flux/secrets/test/secrets.sops.yaml
//
// The file it writes is plaintext: fill in what it lists as left, then
// `sops --encrypt --in-place` it before anything else. It never overwrites.
//
// A running cluster, once the examples gained Secrets or keys:
//
//   SOPS_AGE_KEY_FILE=~/weldsuite-eu-test.agekey \
//     node rust/deploy/flux/scripts/fill-secrets.mjs --update rust/deploy/flux/secrets/test/secrets.sops.yaml
//
// decrypts the file with sops (in memory, never to disk), adds the Secrets and
// keys the examples have and it lacks, and encrypts it again in place. Values
// it already holds stay; a placeholder that also appears in one of them (the
// Valkey password in livekit-env's REDIS_PASSWORD) takes that value. Whatever
// would stay CHANGE_ME is left out and listed. It prints names, never values.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const update = process.argv[2] === '--update';
const out = process.argv[update ? 3 : 2];
if (!out) {
  console.error('usage: node fill-secrets.mjs <output file>');
  console.error('       node fill-secrets.mjs --update <encrypted secrets file>');
  process.exit(2);
}
if (update ? !existsSync(out) : existsSync(out)) {
  console.error(update ? `${out} does not exist` : `${out} already exists; not overwriting it`);
  process.exit(1);
}

// rust/deploy/flux: the examples, and .sops.yaml, which sops finds from its
// working directory.
const flux = join(dirname(fileURLToPath(import.meta.url)), '..');
const example = join(flux, 'secrets/examples/secrets.example.yaml');

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
  'weldsuite-env/ADMIN_OIDC_CLIENT_ID': 'ADMIN_OIDC_CLIENT_ID',
  'weldsuite-env/ADMIN_OIDC_CLIENT_SECRET': 'ADMIN_OIDC_CLIENT_SECRET',
};

function bareValue(secret, key) {
  const variable = PROVIDED[`${secret}/${key}`];
  if (variable) return process.env[variable] || 'CHANGE_ME';
  // 32 bytes of hex: also the format DATABASE_ENCRYPTION_KEY needs (AES-256).
  return hex(32);
}

// Registry logins (base64 of user:token) by placeholder, from these variables.
const LOGINS = {
  CHANGE_ME_BASE64_USER_COLON_TOKEN: ['GHCR_USER', 'GHCR_TOKEN'],
  CHANGE_ME_BASE64_MARKETING_USER_COLON_TOKEN: ['MARKETING_GHCR_USER', 'MARKETING_GHCR_TOKEN'],
};

// Named placeholders stand for one value wherever they appear (a password and
// the connection URL that uses it), so each gets generated once. --update
// fills this first with the values the existing file holds.
const PLACEHOLDER = /CHANGE_ME_[A-Za-z0-9_]+!?/g;
const named = new Map();
function namedValue(token) {
  if (named.has(token)) return named.get(token);
  let value;
  if (token === 'CHANGE_ME_EXACTLY_32_CHARACTERS_') value = alnum(32);
  // Zitadel's password policy: upper, lower, digit and symbol.
  else if (token === 'CHANGE_ME_Aa1!') value = `${alnum(24)}Aa1!`;
  else if (LOGINS[token]) {
    const [user, secret] = LOGINS[token].map((name) => process.env[name]);
    if (!user || !secret) return token;
    value = Buffer.from(`${user}:${secret}`).toString('base64');
  } else value = hex(24);
  named.set(token, value);
  return value;
}

// " (set A and B)" for a value still holding a login's placeholder.
function loginHint(value) {
  const logins = (value.match(PLACEHOLDER) ?? []).filter((token) => LOGINS[token]);
  return logins.map((token) => ` (set ${LOGINS[token].join(' and ')})`).join('');
}

// A value as the example writes it, generated.
function fill(secret, key, template) {
  if (template === 'CHANGE_ME') return bareValue(secret, key);
  return template.replace(PLACEHOLDER, namedValue);
}

function writeNew(out) {
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
    lines.push(filled.replace(PLACEHOLDER, namedValue));
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
    if (entry) left.push(`${namespace}/${secret}: ${entry[1]}${loginHint(line)}`);
  }

  console.log(`wrote ${out} (plaintext)`);
  if (left.length > 0) {
    console.log('still CHANGE_ME, fill these in by hand:');
    for (const entry of left) console.log(`  ${entry}`);
    console.log('(registry: delete that Secret instead when the images are public;');
    console.log(' marketing/ghcr: delete it on a cluster without the marketing site)');
  }
  console.log('Keep DATABASE_ENCRYPTION_KEY and the Zitadel masterkey in the password');
  console.log('manager too, then: sops --encrypt --in-place ' + out);
}

// The Secrets of a YAML stream as the examples and sops write them: one
// Secret per document, its values one plain or quoted scalar per line under
// `stringData:` (or base64 under `data:`).
function parseSecrets(text) {
  const docs = [];
  let doc = null;
  let block = '';
  const lines = text.split(/\r?\n/);
  const start = (index) => {
    doc = { start: index, end: index, name: '', namespace: '', values: new Map(), dataEnd: -1, indent: '  ' };
    docs.push(doc);
    block = '';
  };
  start(0);
  lines.forEach((line, index) => {
    if (line === '---') {
      doc.end = index;
      start(index + 1);
      return;
    }
    doc.end = index + 1;
    const top = /^([A-Za-z]+):/.exec(line);
    if (top) {
      block = top[1];
      return;
    }
    const entry = /^( +)([A-Za-z0-9_.-]+): ?(.*)$/.exec(line);
    if (!entry) return;
    const [, indent, key, raw] = entry;
    if (block === 'metadata' && key === 'name') doc.name = scalar(raw);
    if (block === 'metadata' && key === 'namespace') doc.namespace = scalar(raw);
    if (block === 'stringData' || block === 'data') {
      let value = /^[|>]/.test(raw) ? undefined : scalar(raw);
      if (value !== undefined && block === 'data') value = Buffer.from(value, 'base64').toString();
      doc.values.set(key, value);
      if (block === 'stringData') {
        doc.dataEnd = index + 1;
        doc.indent = indent;
      }
    }
  });
  for (const d of docs) d.id = `${d.namespace}/${d.name}`;
  return { lines, docs: docs.filter((d) => d.name) };
}

// undefined for a value it can't read; that key then counts as present but
// teaches no placeholder.
function scalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function updateFile(file) {
  const sops = (args, input) => {
    try {
      return execFileSync('sops', args, {
        cwd: flux,
        input,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'],
      });
    } catch {
      // sops wrote why on stderr (most often: no age key, SOPS_AGE_KEY_FILE).
      console.error(`sops ${args[0]} failed; nothing written`);
      process.exit(1);
    }
  };
  const path = resolve(file);
  const current = parseSecrets(sops(['decrypt', path]));
  const wanted = parseSecrets(readFileSync(example, 'utf8'));

  // Placeholders the file already has a value for: match each example value
  // with placeholders against the file's value for the same key.
  for (const want of wanted.docs) {
    const have = current.docs.find((d) => d.id === want.id);
    if (!have) continue;
    for (const [key, template] of want.values) {
      const value = have.values.get(key);
      const tokens = template?.match(PLACEHOLDER);
      if (!tokens || value === undefined) continue;
      const pattern = escape(template).replace(/CHANGE_ME_[A-Za-z0-9_]+!?/g, '(.+?)');
      const match = new RegExp(`^${pattern}$`).exec(value);
      if (!match) continue;
      tokens.forEach((token, i) => {
        if (!named.has(token)) named.set(token, match[i + 1]);
      });
    }
  }

  const added = [];
  const left = [];
  const generated = [];
  const inserts = new Map(); // line index -> lines to insert before it
  const appended = [];
  for (const want of wanted.docs) {
    const have = current.docs.find((d) => d.id === want.id);
    const fresh = [];
    for (const [key, template] of want.values) {
      if (have?.values.has(key)) continue;
      const value = fill(want.name, key, template ?? '');
      if (value.includes('CHANGE_ME')) left.push(`${want.id}: ${key}${loginHint(value)}`);
      else fresh.push([key, value, (template ?? '').includes('CHANGE_ME')]);
    }
    if (fresh.length === 0) continue;
    if (have && have.dataEnd < 0) {
      left.push(`${want.id}: ${fresh.map(([k]) => k).join(', ')} (no stringData block to add them to)`);
      continue;
    }
    // A Secret the file lacks comes in only whole: every key filled.
    if (!have && fresh.length < want.values.size) continue;
    // The secret ones (generated or taken from the file), not the example's
    // plain values such as LIVEKIT_API_KEY: weldsuite.
    for (const [key, value, secret] of fresh) {
      if (secret) generated.push(value);
      added.push(`${want.id}: ${key}${have ? '' : ' (new Secret)'}`);
    }
    if (have) {
      const lines = fresh.map(([key, value]) => `${have.indent}${key}: ${JSON.stringify(value)}`);
      inserts.set(have.dataEnd, [...(inserts.get(have.dataEnd) ?? []), ...lines]);
    } else {
      // The example's document, its values replaced.
      let block = '';
      const values = new Map(fresh);
      const doc = wanted.lines.slice(want.start, want.end).map((line) => {
        const top = /^([A-Za-z]+):/.exec(line);
        if (top) block = top[1];
        const entry = /^( +)([A-Za-z0-9_.-]+): /.exec(line);
        if (entry && block === 'stringData' && values.has(entry[2])) {
          return `${entry[1]}${entry[2]}: ${JSON.stringify(values.get(entry[2]))}`;
        }
        return line;
      });
      while (doc.length && doc[doc.length - 1] === '') doc.pop();
      appended.push(doc);
    }
  }

  for (const entry of left) console.log(`left out, still CHANGE_ME: ${entry}`);
  if (left.some((e) => e.includes('/registry:'))) {
    console.log('(registry: not needed while the images are public)');
  }
  if (added.length === 0) {
    console.log(`${file}: nothing to add`);
    return;
  }

  const lines = [];
  current.lines.forEach((line, index) => {
    lines.push(...(inserts.get(index) ?? []), line);
  });
  lines.push(...(inserts.get(current.lines.length) ?? []));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const doc of appended) lines.push('---', ...doc);
  const plaintext = `${lines.join('\n')}\n`;

  const encrypted = sops(
    ['encrypt', '--filename-override', path, '--input-type', 'yaml', '--output-type', 'yaml'],
    plaintext,
  );
  // Refuse to write anything that still shows a value in clear.
  if (!encrypted.includes('ENC[') || generated.some((value) => encrypted.includes(value))) {
    console.error('sops did not encrypt the new values; nothing written');
    process.exit(1);
  }
  writeFileSync(path, encrypted);
  console.log(`${file}: added, encrypted again`);
  for (const entry of added) console.log(`  ${entry}`);
}

if (update) updateFile(out);
else writeNew(out);
