#!/usr/bin/env node
// Fills a cluster's secret store with the values ../secrets/store.example.yaml
// lists, and checks the secrets layer (../secrets) against that list. The
// store is a KV version 2 store behind the HashiCorp Vault API: OpenBao
// (WeldSuite's clusters, rust/deploy/hetzner/secret-store) or Vault.
//
//   node rust/deploy/flux/scripts/seed-secrets.mjs --check
//
// needs no store: every value an ExternalSecret reads is listed in
// store.example.yaml, each listed one is read, and every template has a form
// this script understands (validate.sh runs it).
//
//   SECRET_STORE_URL=… SECRET_STORE_TOKEN=… \
//     node rust/deploy/flux/scripts/seed-secrets.mjs [--dry-run]
//
// writes every listed value the store lacks: generated, a provider's from its
// environment variable ($NAME in store.example.yaml), or CHANGE_ME while that
// variable is unset; a later run with the variable set replaces the
// CHANGE_ME. It never changes any other value. SECRET_STORE_URL is the
// cluster's (cluster-settings.yaml), SECRET_STORE_TOKEN a token that may
// write (not the cluster's read-only one), SECRET_STORE_MOUNT the KV mount
// (default secret).
//
//   SECRET_STORE_URL=… SECRET_STORE_TOKEN=… SOPS_AGE_KEY_FILE=~/<cluster>.agekey \
//     node rust/deploy/flux/scripts/seed-secrets.mjs --import <secrets.sops.yaml> [--dry-run]
//
// moves a cluster off SOPS: decrypts the file with sops (in memory, never to
// disk) and takes each value of its Secrets into the store, under the entry
// and property the ExternalSecrets read it from. It first renders every
// ExternalSecret whose Secret is in the file from what the store would then
// hold, and writes nothing unless each comes out as the file has it (keys an
// ExternalSecret adds are listed) and no value differs from one the store
// already has. A run without --import then adds what the file lacked.
//
// It prints names, never values. --dry-run reads the store and writes nothing.
import { execFileSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const layer = join(dirname(fileURLToPath(import.meta.url)), '..', 'secrets');
const PLACEHOLDER = 'CHANGE_ME';
// Values that can't be made again: a copy goes in the password manager too.
const KEEP = [
  'weldsuite/server DATABASE_ENCRYPTION_KEY',
  'weldsuite/server DATABASE_ENCRYPTION_KEY_V2',
  'weldsuite/server WELDREACH_WARMUP_KEY',
  'weldsuite/server AI_KEYS_ENCRYPTION_KEY',
  'weldsuite/zitadel MASTERKEY',
  'weldsuite/mta MTA_KEY',
  'weldsuite/weldid MASTER_KEY',
];

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  if (at >= 0) args.splice(at, 1);
  return at >= 0;
};
const check = flag('--check');
const dryRun = flag('--dry-run');
const importAt = args.indexOf('--import');
const importPath = importAt >= 0 ? args.splice(importAt, 2)[1] : undefined;
if (args.length > 0 || (importAt >= 0 && !importPath) || (check && (dryRun || importPath))) {
  console.error('usage: node seed-secrets.mjs --check');
  console.error('       node seed-secrets.mjs [--dry-run]');
  console.error('       node seed-secrets.mjs --import <secrets.sops.yaml> [--dry-run]');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// A small YAML reader: block mappings and sequences, one-line flow mappings
// and sequences, plain, quoted and block scalars, comments and `---`
// documents. Enough for the secrets layer, store.example.yaml and the Secrets
// sops writes; anything else fails with the line it is on. Scalars stay
// strings (no numbers or booleans); an empty value is null.

const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{}[\]:,][^:]*?)\s*:(?:[ ]+(.*))?$/;
const isItem = (text) => text === '-' || text.startsWith('- ');
const indentOf = (raw) => raw.length - raw.trimStart().length;

function parseYaml(text, file) {
  const docs = [[]];
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((raw, index) => {
      if (/^---(\s|$)/.test(raw)) docs.push([]);
      else if (!/^(\.\.\.(\s|$)|%)/.test(raw)) docs[docs.length - 1].push({ raw, no: index + 1 });
    });
  return docs.map((lines) => new Reader(lines, file).document()).filter((doc) => doc !== undefined);
}

class Reader {
  constructor(lines, file) {
    this.lines = lines;
    this.file = file;
    this.i = 0;
  }

  fail(message, at = this.i) {
    const no = this.lines[Math.min(at, this.lines.length - 1)]?.no;
    throw new Error(`${this.file}${no ? `:${no}` : ''}: ${message}`);
  }

  // The next line with content, as { indent, text }; blank and comment lines
  // are passed over.
  next() {
    for (; this.i < this.lines.length; this.i++) {
      const { raw } = this.lines[this.i];
      if (/^\s*(#.*)?$/.test(raw)) continue;
      if (/^ *\t/.test(raw)) this.fail('a tab in the indentation');
      const indent = indentOf(raw);
      return { indent, text: raw.slice(indent) };
    }
    return null;
  }

  document() {
    const first = this.next();
    if (!first) return undefined;
    const value = this.node(first.indent);
    if (this.next()) this.fail('more than one value at the top');
    return value;
  }

  node(indent) {
    return isItem(this.next().text) ? this.sequence(indent) : this.mapping(indent);
  }

  mapping(indent) {
    const map = {};
    for (let line = this.next(); line && line.indent === indent && !isItem(line.text); line = this.next()) {
      const match = KEY.exec(line.text);
      if (!match) this.fail('expected `key: value`');
      const key = scalarKey(match[1]);
      if (Object.hasOwn(map, key)) this.fail(`${key} twice`);
      this.i++;
      map[key] = this.value(match[2] ?? '', indent);
    }
    const after = this.next();
    if (after && after.indent > indent) this.fail('indented deeper than the keys before it');
    return map;
  }

  sequence(indent) {
    const list = [];
    for (let line = this.next(); line && line.indent === indent && isItem(line.text); line = this.next()) {
      const rest = line.text.slice(1);
      const content = rest.trimStart();
      if (KEY.test(content) && !/^["'{[]/.test(content)) {
        // `- key: value` starts a mapping on the dash's line: read that line
        // as if the dash were a space.
        const at = indent + 1 + (rest.length - content.length);
        this.lines[this.i] = { ...this.lines[this.i], raw: ' '.repeat(at) + content };
        list.push(this.mapping(at));
      } else {
        this.i++;
        list.push(this.value(rest, indent));
      }
    }
    return list;
  }

  // The value after `key:` or `-` (rest), its parent at indent; this.i is the
  // line after.
  value(rest, indent) {
    const text = rest.trim();
    if (text === '' || text.startsWith('#')) {
      const line = this.next();
      if (line && (line.indent > indent || (line.indent === indent && isItem(line.text)))) {
        return this.node(line.indent);
      }
      return null;
    }
    if (/^[|>]/.test(text)) return this.block(text, indent);
    if (/^[{[]/.test(text)) return this.flowLine(text);
    if (/^["']/.test(text)) return this.quoted(text);
    return this.plain(text, indent);
  }

  plain(text, indent) {
    let value = text.replace(/\s+#.*$/, '');
    let blanks = 0;
    while (this.i < this.lines.length) {
      const { raw } = this.lines[this.i];
      if (raw.trim() === '') {
        blanks++;
        this.i++;
        continue;
      }
      if (indentOf(raw) <= indent || raw.trimStart().startsWith('#')) break;
      value += blanks > 0 ? '\n'.repeat(blanks) : ' ';
      value += raw.trim().replace(/\s+#.*$/, '');
      blanks = 0;
      this.i++;
    }
    return value;
  }

  quoted(text) {
    const quote = text[0];
    let src = text.slice(1);
    let raw = '';
    for (;;) {
      const end = closingQuote(src, quote);
      if (end >= 0) {
        raw += src.slice(0, end);
        const tail = src.slice(end + 1);
        if (tail.trim() !== '' && !/^\s+#/.test(tail)) this.fail('text after a quoted value', this.i - 1);
        break;
      }
      // The value goes on: the line break folds into a space, or into one
      // newline per blank line; in double quotes `\` at the end removes it.
      const line = src.replace(/[ \t]+$/, '');
      let blanks = 0;
      while (this.i < this.lines.length && this.lines[this.i].raw.trim() === '') {
        blanks++;
        this.i++;
      }
      if (this.i >= this.lines.length) this.fail('a quoted value without its closing quote');
      const escaped = quote === '"' && /(^|[^\\])(\\\\)*\\$/.test(line);
      raw += escaped ? line.slice(0, -1) + '\n'.repeat(blanks) : line + (blanks > 0 ? '\n'.repeat(blanks) : ' ');
      src = this.lines[this.i].raw.trimStart();
      this.i++;
    }
    return quote === "'" ? raw.replaceAll("''", "'") : unescapeDouble(raw);
  }

  block(header, indent) {
    const match = /^([|>])([+-]?)([1-9]?)([+-]?)\s*(#.*)?$/.exec(header);
    if (!match) this.fail('a block scalar header this reader does not know', this.i - 1);
    const chomp = match[2] || match[4];
    let width = match[3] ? indent + Number(match[3]) : 0;
    const body = [];
    while (this.i < this.lines.length) {
      const { raw } = this.lines[this.i];
      if (raw.trim() === '') {
        body.push('');
        this.i++;
        continue;
      }
      const at = indentOf(raw);
      if (!width) {
        if (at <= indent) break;
        width = at;
      }
      if (at < width) break;
      body.push(raw.slice(width));
      this.i++;
    }
    let end = body.length;
    while (end > 0 && body[end - 1] === '') end--;
    const content = body.slice(0, end);
    const text = match[1] === '>' ? fold(content) : content.join('\n');
    if (chomp === '-' || content.length === 0) return chomp === '+' ? '\n'.repeat(body.length) : text;
    return chomp === '+' ? `${text}\n${'\n'.repeat(body.length - end)}` : `${text}\n`;
  }

  flowLine(text) {
    const at = this.i - 1;
    const cursor = { s: text, k: 0 };
    let value;
    try {
      value = flowValue(cursor);
    } catch (error) {
      this.fail(error.message, at);
    }
    const tail = text.slice(cursor.k);
    if (tail.trim() !== '' && !/^\s+#/.test(tail)) this.fail('text after a flow collection', at);
    return value;
  }
}

function scalarKey(text) {
  if (text.startsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  if (text.startsWith('"')) return unescapeDouble(text.slice(1, -1));
  return text.trim();
}

function closingQuote(src, quote) {
  for (let k = 0; k < src.length; k++) {
    if (quote === '"' && src[k] === '\\') k++;
    else if (src[k] === quote) {
      if (quote === "'" && src[k + 1] === "'") k++;
      else return k;
    }
  }
  return -1;
}

const ESCAPES = {
  0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ',
};

function unescapeDouble(raw) {
  return raw.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[\s\S])/g, (_, code) => {
    if (code.length > 1) return String.fromCodePoint(Number.parseInt(code.slice(1), 16));
    if (Object.hasOwn(ESCAPES, code)) return ESCAPES[code];
    throw new Error(`the escape \\${code}`);
  });
}

// Folded block scalars: lines join with a space, a blank line is a newline,
// more-indented lines keep their breaks.
function fold(lines) {
  return lines.reduce((out, line, k) => {
    if (k === 0) return line;
    const before = lines[k - 1];
    if (line === '') return `${out}\n`;
    if (before === '') return out + line;
    if (/^\s/.test(line) || /^\s/.test(before)) return `${out}\n${line}`;
    return `${out} ${line}`;
  }, '');
}

function flowValue(cursor) {
  skipSpaces(cursor);
  const open = cursor.s[cursor.k];
  if (open !== '{' && open !== '[') return flowScalar(cursor, false);
  const close = open === '{' ? '}' : ']';
  const out = open === '{' ? {} : [];
  cursor.k++;
  for (;;) {
    skipSpaces(cursor);
    if (cursor.s[cursor.k] === close) {
      cursor.k++;
      return out;
    }
    if (open === '{') {
      const key = flowScalar(cursor, true);
      skipSpaces(cursor);
      if (cursor.s[cursor.k] !== ':') throw new Error('expected `:` in a flow mapping');
      cursor.k++;
      out[key] = flowValue(cursor);
    } else out.push(flowValue(cursor));
    skipSpaces(cursor);
    const next = cursor.s[cursor.k++];
    if (next === close) return out;
    if (next !== ',') throw new Error(`expected \`,\` or \`${close}\` in a flow collection`);
  }
}

function flowScalar(cursor, key) {
  skipSpaces(cursor);
  const quote = cursor.s[cursor.k];
  if (quote === '"' || quote === "'") {
    const end = closingQuote(cursor.s.slice(cursor.k + 1), quote);
    if (end < 0) throw new Error('a quoted value without its closing quote');
    const raw = cursor.s.slice(cursor.k + 1, cursor.k + 1 + end);
    cursor.k += end + 2;
    return quote === "'" ? raw.replaceAll("''", "'") : unescapeDouble(raw);
  }
  const stops = key ? ',:]}' : ',]}';
  let end = cursor.k;
  while (end < cursor.s.length && !stops.includes(cursor.s[end])) end++;
  const value = cursor.s.slice(cursor.k, end).trim();
  cursor.k = end;
  return value === '' ? null : value;
}

function skipSpaces(cursor) {
  while (cursor.s[cursor.k] === ' ') cursor.k++;
}

// ---------------------------------------------------------------------------
// The secrets layer: its ExternalSecrets, and the templates they use.

function yamlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    const skip = entry.name === 'kustomization.yaml' || entry.name === 'store.example.yaml';
    return entry.name.endsWith('.yaml') && !skip ? [path] : [];
  });
}

// Each ExternalSecret as { where, component, id, type, merge, template, data,
// extract, problems }. merge: the Secret holds what it reads as well as what
// its templates make (no template, or mergePolicy Merge).
function loadExternalSecrets() {
  const list = [];
  for (const file of yamlFiles(layer)) {
    const where = relative(layer, file).replaceAll('\\', '/');
    for (const doc of parseYaml(readFileSync(file, 'utf8'), where)) {
      if (doc?.kind !== 'ExternalSecret') continue;
      const spec = doc.spec ?? {};
      const target = spec.target ?? {};
      const template = target.template ?? null;
      const problems = [];
      const es = {
        where,
        component: where.includes('/') ? where.split('/')[0] : '',
        id: `${doc.metadata?.namespace}/${target.name ?? doc.metadata?.name}`,
        type: template?.type ?? 'Opaque',
        merge: !template || template.mergePolicy === 'Merge',
        template: [],
        data: (spec.data ?? []).map((d) => ({ secretKey: d?.secretKey, key: d?.remoteRef?.key, property: d?.remoteRef?.property })),
        extract: (spec.dataFrom ?? []).map((d) => d?.extract?.key),
        problems,
      };
      const store = spec.secretStoreRef ?? {};
      if (store.kind !== 'ClusterSecretStore' || store.name !== 'weldsuite') {
        problems.push('reads from a store other than ClusterSecretStore weldsuite');
      }
      if (template?.templateFrom) problems.push('has templateFrom, which this script does not render');
      if (template?.mergePolicy && !['Merge', 'Replace'].includes(template.mergePolicy)) {
        problems.push(`has mergePolicy ${template.mergePolicy}`);
      }
      for (const d of es.data) {
        if (!d.secretKey || !d.key || !d.property) problems.push('has a data entry without secretKey, key and property');
      }
      if (es.extract.some((key) => !key)) problems.push('has a dataFrom entry other than extract');
      if (es.extract.length > 1) problems.push('extracts more than one entry');
      if (es.extract.length > 0 && !es.merge) problems.push('extracts an entry whose values its template drops');
      const readable = new Set(es.data.map((d) => d.secretKey));
      for (const [key, text] of Object.entries(template?.data ?? {})) {
        try {
          const parts = parseTemplate(String(text ?? ''));
          for (const name of templateNames(parts)) {
            if (!readable.has(name)) problems.push(`${key}: its template reads ${name}, which no data entry reads`);
          }
          es.template.push({ key, parts });
        } catch (error) {
          problems.push(`${key}: ${error.message}`);
        }
      }
      list.push(es);
    }
  }
  return list;
}

// The template forms the secrets layer uses, and all this script renders:
//   {{ .NAME }}                            the value read as NAME
//   {{ printf "%s:%s" .A .B | b64enc }}    a registry login, base64 of A:B
function parseTemplate(text) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(/\{\{-?\s*(.*?)\s*-?\}\}/g)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    const name = /^\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(match[1]);
    const login = /^printf\s+"%s:%s"\s+\.([A-Za-z_]\w*)\s+\.([A-Za-z_]\w*)\s*\|\s*b64enc$/.exec(match[1]);
    if (name) parts.push({ name: name[1] });
    else if (login) parts.push({ login: [login[1], login[2]] });
    else throw new Error(`the template action {{ ${match[1]} }}, which this script does not render`);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

const templateNames = (parts) => parts.flatMap((p) => (p.name ? [p.name] : p.login ?? []));

function renderTemplate(parts, values) {
  return parts
    .map((p) => {
      if (p.text !== undefined) return p.text;
      if (p.name) return values[p.name];
      return Buffer.from(`${values[p.login[0]]}:${values[p.login[1]]}`).toString('base64');
    })
    .join('');
}

// The values a rendered template was made from, or null when it doesn't
// have the template's form.
function readTemplate(parts, value) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = parts
    .map((p) => (p.text !== undefined ? escape(p.text) : p.name ? '([\\s\\S]*?)' : '([A-Za-z0-9+/]*={0,2})'))
    .join('');
  const match = new RegExp(`^${pattern}$`).exec(value);
  if (!match) return null;
  const found = {};
  const put = (name, text) => {
    if (Object.hasOwn(found, name) && found[name] !== text) throw new Error('one name, two values');
    found[name] = text;
  };
  let group = 1;
  try {
    for (const p of parts) {
      if (p.text !== undefined) continue;
      const text = match[group++];
      if (p.name) put(p.name, text);
      else {
        const login = Buffer.from(text, 'base64').toString();
        const colon = login.indexOf(':');
        if (colon < 0) return null;
        put(p.login[0], login.slice(0, colon));
        put(p.login[1], login.slice(colon + 1));
      }
    }
  } catch {
    return null;
  }
  return renderTemplate(parts, found) === value ? found : null;
}

// The Secret an ExternalSecret makes from the store's values (a Map of entry
// to its properties), the way External Secrets Operator makes it.
function renderSecret(es, store) {
  const read = (key, property) => {
    const value = store.get(key)?.[property];
    if (value === undefined) throw new Error(`the store has no ${key} ${property}`);
    return value;
  };
  const values = {};
  for (const d of es.data) values[d.secretKey] = read(d.key, d.property);
  const out = {};
  if (es.merge) {
    for (const key of es.extract) {
      if (!store.has(key)) throw new Error(`the store has no ${key}`);
      Object.assign(out, store.get(key));
    }
    Object.assign(out, values);
  }
  for (const t of es.template) out[t.key] = renderTemplate(t.parts, values);
  return out;
}

// ---------------------------------------------------------------------------
// store.example.yaml, and the values it says how to make.

function readExample() {
  const where = 'store.example.yaml';
  const [example] = parseYaml(readFileSync(join(layer, where), 'utf8'), where);
  for (const [entry, properties] of Object.entries(example ?? {})) {
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
      throw new Error(`${where}: ${entry} is not a mapping of properties`);
    }
    for (const [property, how] of Object.entries(properties)) {
      if (typeof how !== 'string' || !(how.startsWith('$') || Object.hasOwn(MAKE, how))) {
        throw new Error(`${where}: ${entry} ${property}: ${how} is not a placeholder this script knows`);
      }
    }
  }
  return example ?? {};
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const alnum = (length) => Array.from({ length }, () => ALNUM[randomInt(ALNUM.length)]).join('');
const MAKE = {
  CHANGE_ME: () => randomBytes(32).toString('hex'),
  CHANGE_ME_EXACTLY_32_CHARACTERS_: () => alnum(32),
  CHANGE_ME_BASE64_32_BYTES: () => randomBytes(32).toString('base64'),
  // Zitadel's password policy: upper, lower, digit and symbol.
  'CHANGE_ME_Aa1!': () => `${alnum(24)}Aa1!`,
  // A P-256 private key as PKCS#8 PEM (the server's key for WeldID's admin
  // API, private_key_jwt).
  CHANGE_ME_ES256_PRIVATE_KEY: () =>
    generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
};
// What a made value's owner needs besides it, printed once it is made.
const AFTER = {
  'weldsuite/weldid CLIENT_KEY': (pem) => {
    const { x, y } = createPublicKey(pem).export({ format: 'jwk' });
    return [
      "the server's WeldID admin API key, public half, for the cluster's settings (WeldID only):",
      `  WELDID_BACKEND_KEY_X: ${x}`,
      `  WELDID_BACKEND_KEY_Y: ${y}`,
    ];
  },
};

// ---------------------------------------------------------------------------
// The store: KV version 2 over the Vault HTTP API.

function openStore() {
  const url = process.env.SECRET_STORE_URL?.replace(/\/+$/, '');
  const token = process.env.SECRET_STORE_TOKEN;
  const mount = process.env.SECRET_STORE_MOUNT || 'secret';
  if (!url || !token) {
    throw new Error(
      'set SECRET_STORE_URL (the cluster\'s, from cluster-settings.yaml) and SECRET_STORE_TOKEN (a token that may write)',
    );
  }
  const at = (path) => `${url}/v1/${mount}/data/${path.split('/').map(encodeURIComponent).join('/')}`;
  const request = (method, path, body) =>
    fetch(at(path), {
      method,
      headers: { 'X-Vault-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  const failure = async (what, response) =>
    new Error(`${what}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  return {
    // { data, version } of the entry's newest version; null when it has none.
    // A deleted newest version reads as empty, with its number for the next
    // write's check-and-set.
    async read(path) {
      const response = await request('GET', path);
      const body = await response.json().catch(() => null);
      if (response.status === 404) {
        const version = body?.data?.metadata?.version;
        return version ? { data: {}, version } : null;
      }
      if (!response.ok) throw new Error(`reading ${path}: HTTP ${response.status}`);
      return { data: body?.data?.data ?? {}, version: body?.data?.metadata?.version ?? 0 };
    },
    // A new version holding all of data, only if the newest is still `version`
    // (0: only if there is none).
    async write(path, data, version) {
      const response = await request('POST', path, { options: { cas: version }, data });
      if (!response.ok) throw await failure(`writing ${path}`, response);
    },
  };
}

async function readStore(store, entries) {
  const current = new Map();
  for (const entry of entries) current.set(entry, await store.read(entry));
  return current;
}

// ---------------------------------------------------------------------------

function runCheck() {
  const example = readExample();
  const list = loadExternalSecrets();
  const problems = [];
  const read = new Set();
  const ids = new Map();
  for (const es of list) {
    for (const problem of es.problems) problems.push(`${es.where} ${es.id}: ${problem}`);
    if (ids.has(es.id)) problems.push(`${es.where} and ${ids.get(es.id)} both write ${es.id}`);
    ids.set(es.id, es.where);
    for (const d of es.data) {
      if (!Object.hasOwn(example[d.key] ?? {}, d.property)) {
        problems.push(`${es.where} ${es.id}: reads ${d.key} ${d.property}, which store.example.yaml does not list`);
      }
      read.add(`${d.key} ${d.property}`);
    }
    for (const key of es.extract.filter(Boolean)) {
      if (!Object.hasOwn(example, key)) problems.push(`${es.where} ${es.id}: extracts ${key}, which store.example.yaml does not list`);
      for (const property of Object.keys(example[key] ?? {})) read.add(`${key} ${property}`);
    }
  }
  for (const [entry, properties] of Object.entries(example)) {
    for (const property of Object.keys(properties)) {
      if (!read.has(`${entry} ${property}`)) problems.push(`store.example.yaml: no ExternalSecret reads ${entry} ${property}`);
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL ${problem}`);
    process.exit(1);
  }
  const values = Object.values(example).reduce((sum, properties) => sum + Object.keys(properties).length, 0);
  console.log(`secrets layer: ${list.length} ExternalSecrets, ${values} values in ${Object.keys(example).length} store entries: ok`);
}

// Which components read an entry: '' is the layer itself.
function readers(list, entry) {
  return new Set(list.filter((es) => es.data.some((d) => d.key === entry) || es.extract.includes(entry)).map((es) => es.component));
}

async function runSeed() {
  const example = readExample();
  const list = loadExternalSecrets();
  const store = openStore();
  const current = await readStore(store, Object.keys(example));
  const waiting = [];
  const keep = [];
  const after = [];
  let wrote = 0;
  for (const [entry, properties] of Object.entries(example)) {
    const before = current.get(entry);
    const data = { ...(before?.data ?? {}) };
    const added = [];
    for (const [property, how] of Object.entries(properties)) {
      const have = data[property];
      if (have !== undefined && have !== PLACEHOLDER) continue;
      let value;
      if (how.startsWith('$')) {
        value = process.env[how.slice(1)] || PLACEHOLDER;
        if (value === PLACEHOLDER) {
          const only = [...readers(list, entry)];
          const hint = only.includes('')
            ? ''
            : `; only the ${only.join(' and ')} component${only.length > 1 ? 's read' : ' reads'} it`;
          waiting.push(`${entry} ${property} (set ${how.slice(1)}${hint})`);
        }
      } else {
        value = MAKE[how]();
        if (KEEP.includes(`${entry} ${property}`)) keep.push(`${entry} ${property}`);
        after.push(...(AFTER[`${entry} ${property}`]?.(value) ?? []));
      }
      if (value === have) continue;
      data[property] = value;
      added.push(value === PLACEHOLDER ? `${property} (CHANGE_ME)` : property);
    }
    if (added.length === 0) continue;
    if (!dryRun) await store.write(entry, data, before?.version ?? 0);
    wrote++;
    console.log(`${entry}: ${dryRun ? 'would add' : 'added'} ${added.join(', ')}`);
  }
  if (wrote === 0) console.log('the store holds every value store.example.yaml lists');
  if (waiting.length > 0) {
    console.log('still CHANGE_ME (run again with the variable set, or set the value in the store):');
    for (const line of waiting) console.log(`  ${line}`);
  }
  if (keep.length > 0) {
    console.log(`made just now and impossible to make again, copy them to the password manager too: ${keep.join(', ')}`);
  }
  if (!dryRun) for (const line of after) console.log(line);
}

// The Secrets of a file sops encrypted (or a plain one), as a Map of
// namespace/name to { type, values }.
function readSecrets(path) {
  const text = readFileSync(path, 'utf8');
  let plain = text;
  if (/^sops:/m.test(text)) {
    try {
      plain = execFileSync('sops', ['decrypt', path], {
        cwd: dirname(path),
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'inherit'],
      });
    } catch {
      // sops wrote why on stderr (most often: no age key, SOPS_AGE_KEY_FILE).
      throw new Error(`sops could not decrypt ${path}; nothing written`);
    }
  } else console.log(`${path} is not encrypted with sops; reading it as it is`);
  const secrets = new Map();
  for (const doc of parseYaml(plain, path)) {
    if (doc?.kind !== 'Secret') continue;
    const values = {};
    for (const [key, value] of Object.entries(doc.stringData ?? {})) values[key] = value ?? '';
    for (const [key, value] of Object.entries(doc.data ?? {})) values[key] = Buffer.from(value ?? '', 'base64').toString();
    secrets.set(`${doc.metadata?.namespace}/${doc.metadata?.name}`, { type: doc.type ?? 'Opaque', values });
  }
  return secrets;
}

async function runImport(path) {
  const secrets = readSecrets(resolve(path));
  const list = loadExternalSecrets();
  const broken = list.flatMap((es) => es.problems.map((p) => `${es.where} ${es.id}: ${p}`));
  if (broken.length > 0) throw new Error(`the secrets layer has problems (--check):\n  ${broken.join('\n  ')}`);
  const mine = list.filter((es) => secrets.has(es.id));
  const problems = [];

  // Every value of the file, by the store entry and property it goes to.
  const found = new Map();
  const take = (key, property, value, from) => {
    const at = `${key} ${property}`;
    const had = found.get(at);
    if (!had) found.set(at, { key, property, value, from });
    else if (had.value !== value) problems.push(`${at}: ${from} and ${had.from} hold different values`);
  };
  for (const es of mine) {
    const { values } = secrets.get(es.id);
    const byKey = new Map(es.data.map((d) => [d.secretKey, d]));
    for (const t of es.template) {
      if (!Object.hasOwn(values, t.key)) continue;
      const read = readTemplate(t.parts, values[t.key]);
      if (!read) {
        problems.push(`${es.id} ${t.key}: not of the form its template in ${es.where} makes`);
        continue;
      }
      for (const [name, value] of Object.entries(read)) {
        const d = byKey.get(name);
        take(d.key, d.property, value, `${es.id} ${t.key}`);
      }
    }
    if (!es.merge) continue;
    for (const [key, value] of Object.entries(values)) {
      if (es.template.some((t) => t.key === key)) continue;
      const d = byKey.get(key);
      if (d) take(d.key, d.property, value, `${es.id} ${key}`);
      else if (es.extract.length === 1) take(es.extract[0], key, value, `${es.id} ${key}`);
    }
  }

  // Merged with what the store holds: a value there already must agree.
  const example = readExample();
  const store = openStore();
  const entries = new Set([
    ...Object.keys(example),
    ...[...found.values()].map((f) => f.key),
    ...mine.flatMap((es) => [...es.data.map((d) => d.key), ...es.extract]),
  ]);
  const current = await readStore(store, entries);
  const values = new Map([...entries].map((entry) => [entry, { ...(current.get(entry)?.data ?? {}) }]));
  const writes = new Map();
  for (const f of found.values()) {
    const entry = values.get(f.key);
    const have = entry[f.property];
    if (have === f.value) continue;
    if (have !== undefined && have !== PLACEHOLDER) {
      problems.push(`${f.key} ${f.property}: the store already holds a different value than ${f.from}`);
      continue;
    }
    entry[f.property] = f.value;
    writes.set(f.key, [...(writes.get(f.key) ?? []), f.property]);
  }
  for (const [entry, data] of values) {
    if (Object.keys(data).length === 0 && !current.get(entry)) values.delete(entry);
  }

  // Each Secret of the file, made again the way ESO will make it.
  const added = [];
  for (const es of mine) {
    const secret = secrets.get(es.id);
    let made;
    try {
      made = renderSecret(es, values);
    } catch (error) {
      problems.push(`${es.id}: ${error.message}`);
      continue;
    }
    if (es.type !== secret.type) problems.push(`${es.id}: type ${secret.type} in the file, ${es.type} from ${es.where}`);
    for (const [key, value] of Object.entries(secret.values)) {
      if (!Object.hasOwn(made, key)) problems.push(`${es.id} ${key}: in the file, but ${es.where} does not write it`);
      else if (made[key] !== value) problems.push(`${es.id} ${key}: ${es.where} would write a different value`);
    }
    const more = Object.keys(made).filter((key) => !Object.hasOwn(secret.values, key));
    if (more.length > 0) added.push(`${es.id}: ${more.join(', ')}`);
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL ${problem}`);
    throw new Error('nothing written');
  }
  const unmanaged = [...secrets.keys()].filter((id) => !list.some((es) => es.id === id));
  console.log(`every Secret in ${path} that an ExternalSecret writes comes out as the file has it (${mine.length})`);
  if (added.length > 0) {
    console.log('keys the ExternalSecrets add to them:');
    for (const line of added) console.log(`  ${line}`);
  }
  if (unmanaged.length > 0) {
    console.log(`no ExternalSecret writes these; they stay in the cluster as they are, unmanaged: ${unmanaged.join(', ')}`);
  }
  for (const [entry, properties] of writes) {
    if (!dryRun) await store.write(entry, values.get(entry), current.get(entry)?.version ?? 0);
    console.log(`${entry}: ${dryRun ? 'would take' : 'took'} ${properties.join(', ')}`);
  }
  if (writes.size === 0) console.log('the store already holds every value of the file');
  const lacking = Object.entries(example).flatMap(([entry, properties]) =>
    Object.keys(properties)
      .filter((property) => values.get(entry)?.[property] === undefined)
      .map((property) => `${entry} ${property}`),
  );
  if (lacking.length > 0) {
    console.log(`not in the store yet (a run without --import adds them): ${lacking.join(', ')}`);
  }
}

try {
  if (check) runCheck();
  else if (importPath) await runImport(importPath);
  else await runSeed();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
