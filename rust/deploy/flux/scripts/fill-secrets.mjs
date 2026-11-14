#!/usr/bin/env node
// Writes a cluster's secrets file from ../secrets/examples/secrets.example.yaml
// with every value that isn't a provider's key generated: database passwords,
// DATABASE_ENCRYPTION_KEY (64 hex), the Zitadel masterkey (32 characters) and
// first admin password, the sign, storage and realtime secrets, the MTA's key
// (base64 of 32 bytes) and passwords. Provider keys
// come from these environment variables when set, and stay CHANGE_ME otherwise:
//
//   FILES_S3_ACCESS_KEY_ID, FILES_S3_SECRET_ACCESS_KEY    the files bucket
//   BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY  the backup bucket
//   ZITADEL_SERVICE_TOKEN                                 the weldsuite service user's PAT
//   ADMIN_OIDC_CLIENT_ID, ADMIN_OIDC_CLIENT_SECRET        the admin console's Zitadel app
//   MISTRAL_API_KEY                                       WeldSuite's Mistral key (AI, embeddings)
//   GHCR_USER, GHCR_TOKEN                                 pulling private images
//   MARKETING_GHCR_USER, MARKETING_GHCR_TOKEN             the marketing site's chart and image
//   ALERT_CRITICAL_URL, ALERT_WARNING_URL                 where alerts go (alerting-receivers)
//   ALERT_HEARTBEAT_URL, ALERT_TOKEN                      the heartbeat check, the receivers' token
//   GRAFANA_OIDC_CLIENT_ID, GRAFANA_OIDC_CLIENT_SECRET    Grafana's Zitadel app
//   LOGS_S3_ACCESS_KEY_ID, LOGS_S3_SECRET_ACCESS_KEY      the logs bucket (Loki)
//
// A new cluster (its secrets folder, next to its cluster folder: in a copy of
// this repository rust/deploy/flux/secrets/<cluster>, in WeldSuite's deploy
// repository eu/secrets/<cluster>):
//
//   node rust/deploy/flux/scripts/fill-secrets.mjs rust/deploy/flux/secrets/<cluster>/secrets.sops.yaml
//
// The file it writes is plaintext: fill in what it lists as left, then
// `sops --encrypt --in-place` it before anything else. It never overwrites.
//
// A running cluster, once the examples gained Secrets or keys:
//
//   SOPS_AGE_KEY_FILE=~/<cluster>.agekey \
//     node rust/deploy/flux/scripts/fill-secrets.mjs --update rust/deploy/flux/secrets/<cluster>/secrets.sops.yaml
//
// decrypts the file with sops (in memory, never to disk), adds the Secrets and
// keys the examples have and it lacks, and encrypts it again in place. Values
// it already holds stay; a placeholder that also appears in one of them (the
// Valkey password in livekit-env's REDIS_PASSWORD) takes that value. Whatever
// would stay CHANGE_ME is left out and listed. It prints names, never values.
// `--only <namespace>/<name>,…` limits it to those Secrets (add Grafana's
// without touching the server's environment):
//
//   GRAFANA_OIDC_CLIENT_ID=… GRAFANA_OIDC_CLIENT_SECRET=… SOPS_AGE_KEY_FILE=… \
//     node rust/deploy/flux/scripts/fill-secrets.mjs --update \
//     --only monitoring/grafana-oidc,monitoring/grafana-admin <encrypted secrets file>
import { execFileSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? new Set((args.splice(onlyAt, 2)[1] ?? '').split(',').filter(Boolean)) : null;
const update = args[0] === '--update';
const out = args[update ? 1 : 0];
if (!out) {
  console.error('usage: node fill-secrets.mjs <output file>');
  console.error('       node fill-secrets.mjs --update [--only <ns>/<name>,…] <encrypted secrets file>');
  process.exit(2);
}
if (update ? !existsSync(out) : existsSync(out)) {
  console.error(update ? `${out} does not exist` : `${out} already exists; not overwriting it`);
  process.exit(1);
}

// rust/deploy/flux: the examples. sops finds .sops.yaml from its working
// directory up, so it runs in the secrets file's own folder (the deploy
// repository keeps its .sops.yaml at its root).
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
  'weldsuite-env/MISTRAL_API_KEY': 'MISTRAL_API_KEY',
  'alerting-receivers/critical-url': 'ALERT_CRITICAL_URL',
  'alerting-receivers/warning-url': 'ALERT_WARNING_URL',
  'alerting-receivers/heartbeat-url': 'ALERT_HEARTBEAT_URL',
  'alerting-receivers/token': 'ALERT_TOKEN',
  'grafana-oidc/GF_AUTH_GENERIC_OAUTH_CLIENT_ID': 'GRAFANA_OIDC_CLIENT_ID',
  'grafana-oidc/GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET': 'GRAFANA_OIDC_CLIENT_SECRET',
  'loki-s3/access-key-id': 'LOGS_S3_ACCESS_KEY_ID',
  'loki-s3/secret-access-key': 'LOGS_S3_SECRET_ACCESS_KEY',
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
  // The MTA's MTA_KEY: base64 of 32 random bytes.
  else if (token === 'CHANGE_ME_BASE64_32_BYTES') value = randomBytes(32).toString('base64');
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
    const bare = /^( {2}([A-Za-z0-9_.-]+): )CHANGE_ME$/.exec(line);
    const value = bare ? bareValue(secret, bare[2]) : '';
    const filled = bare ? bare[1] + (value === 'CHANGE_ME' ? value : JSON.stringify(value)) : line;
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
    const entry = /^ {2}([A-Za-z0-9_.-]+): .*CHANGE_ME/.exec(line);
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
// `stringData:` (or base64 under `data:`), or a block scalar (`key: |`, a
// certificate) whose more-indented lines that follow belong to it.
function parseSecrets(text) {
  const docs = [];
  let doc = null;
  let block = '';
  // The indent of the key whose block scalar the lines below belong to; -1: none.
  let scalarIndent = -1;
  const lines = text.split(/\r?\n/);
  const start = (index) => {
    doc = { start: index, end: index, name: '', namespace: '', values: new Map(), dataEnd: -1, indent: '  ' };
    docs.push(doc);
    block = '';
    scalarIndent = -1;
  };
  start(0);
  lines.forEach((line, index) => {
    if (line === '---') {
      doc.end = index;
      start(index + 1);
      return;
    }
    doc.end = index + 1;
    if (scalarIndent >= 0) {
      // Still the block scalar: blank, or indented past its key. New keys go
      // after it, never inside it.
      if (line.trim() === '' || /^ */.exec(line)[0].length > scalarIndent) {
        if (block === 'stringData') doc.dataEnd = index + 1;
        return;
      }
      scalarIndent = -1;
    }
    const top = /^([A-Za-z]+):/.exec(line);
    if (top) {
      block = top[1];
      return;
    }
    // New keys go after the block's last line: a multi-line value (a PEM
    // key under `|`) included, or they would land inside it.
    if (block === 'stringData' && /^\s+\S/.test(line)) doc.dataEnd = index + 1;
    const entry = /^( +)([A-Za-z0-9_.-]+): ?(.*)$/.exec(line);
    if (!entry) return;
    const [, indent, key, raw] = entry;
    if (/^[|>]/.test(raw)) scalarIndent = indent.length;
    if (block === 'metadata' && key === 'name') doc.name = scalar(raw);
    if (block === 'metadata' && key === 'namespace') doc.namespace = scalar(raw);
    if (block === 'stringData' || block === 'data') {
      // Deeper than the keys: a line of a multi-line value, not a key.
      if (doc.keyIndent !== undefined && indent.length > doc.keyIndent) return;
      doc.keyIndent = indent.length;
      let value = /^[|>]/.test(raw) ? undefined : scalar(raw);
      if (value !== undefined && block === 'data') value = Buffer.from(value, 'base64').toString();
      doc.values.set(key, value);
      if (block === 'stringData') doc.indent = indent;
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
        cwd: dirname(path),
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
    if (only && !only.has(want.id)) continue;
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
