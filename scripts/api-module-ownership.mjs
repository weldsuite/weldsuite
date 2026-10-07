#!/usr/bin/env node
/**
 * Which module owns each app-api source file (docs/plans/app-api-module-split.md).
 *
 *   pnpm api:ownership                  summary + files shared between modules
 *   pnpm api:ownership <module>         a module's files, what they import from
 *                                       outside the module, and who imports them
 *   pnpm api:ownership --core-shared    files core keeps that modules also use
 *
 * Ownership comes from the route mounts in app-api's src/index.ts (mapped to a
 * module by @weldsuite/api-modules) plus the relative-import graph (value
 * imports only; `import type` is ignored because it is not bundled). A file
 * reached by one module belongs to it; reached by several it is SHARED (it must
 * move to a package before those modules split); reached by core it stays core.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(repo, 'apps/workers/app-api/src').split(path.sep).join('/');
const { findModuleForPath } = await import(pathToFileURL(path.join(repo, 'packages/core/api-modules/src/index.ts')).href);

const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.ts'))
  .map((f) => path.join(src, f).replaceAll('\\', '/'));
const fileSet = new Set(files);

function resolveImport(from, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec).replaceAll('\\', '/');
  for (const c of [base, `${base}.ts`, `${base}/index.ts`]) if (fileSet.has(c)) return c;
  return null;
}

const imports = new Map();
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  const deps = new Set();
  // Value imports only: `import type` / `export type` and `import('x').Type`
  // type expressions do not end up in the bundle.
  for (const m of s.matchAll(/^\s*(import|export)\s+(type\s+)?(?:[^;'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
    if (m[2]) continue;
    const r = resolveImport(f, m[3]);
    if (r) deps.add(r);
  }
  for (const m of s.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)(\.[A-Z])?/g)) {
    if (m[2]) continue;
    const r = resolveImport(f, m[1]);
    if (r) deps.add(r);
  }
  imports.set(f, deps);
}

// Seeds: route dirs mounted in index.ts.
const index = readFileSync(path.join(src, 'index.ts'), 'utf8');
const importVar = new Map(); // var -> file
for (const m of index.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.\/[^']+)'/g)) {
  const file = resolveImport(path.join(src, 'index.ts').replaceAll('\\', '/'), m[2]);
  for (const v of m[1].split(',').map((x) => x.trim().split(' as ').pop().trim())) if (file) importVar.set(v, file);
}
const seeds = new Map(); // file -> module
for (const m of index.matchAll(/app\.route\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)) {
  const file = importVar.get(m[2]);
  if (!file) continue;
  const mod = m[1] === '/' ? 'core' : findModuleForPath(m[1]).id;
  const dir = path.dirname(file);
  // every file in the route's folder belongs to that module
  if (dir !== src && dir !== src + '/routes') for (const f of files) if (f.startsWith(dir + '/')) seeds.set(f, seeds.get(f) && seeds.get(f) !== mod ? 'MULTI' : mod);
  seeds.set(file, mod);
}
// Non-HTTP entrypoints assigned by hand.
const manual = {
  'cron/digest-sweep.ts': 'flow',
  'cron/weldagent-routines.ts': 'agent',
  'cron/calendar-replan.ts': 'calendar',
  'cron/domain-auto-renew.ts': 'host',
  'queue/search-index-consumer.ts': 'core',
  'queue/entity-agents-consumer.ts': 'agent',
  'workflows/welddata-enrich.ts': 'data',
  'workflows/send-scheduled-email.ts': 'mail',
  'workflows/execute-sequence.ts': 'crm',
  'workflows/trash-cleanup.ts': 'core',
  'workflows/transcribe-recording.ts': 'meet',
  'workflows/unpin-expired-message.ts': 'chat',
  'workflows/deferred-notification-email.ts': 'core',
  'workflows/weldagent-job.ts': 'agent',
  'workflows/send-digest.ts': 'flow',
  'workflows/import-tasks.ts': 'flow',
};
for (const [rel, mod] of Object.entries(manual)) {
  const f = path.join(src, rel).replaceAll('\\', '/');
  if (fileSet.has(f)) seeds.set(f, mod);
}

// Propagate: which modules reach each file.
const reachers = new Map();
for (const [seed, mod] of seeds) {
  const stack = [seed];
  const seen = new Set();
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!reachers.has(f)) reachers.set(f, new Set());
    reachers.get(f).add(mod);
    for (const d of imports.get(f) ?? []) stack.push(d);
  }
}

const rel = (f) => path.relative(src, f).replaceAll('\\', '/');
const owner = new Map();
for (const f of files) {
  if (f.endsWith('/index.ts') && path.dirname(f) === src) continue;
  const r = reachers.get(f);
  const seedMod = seeds.get(f);
  if (seedMod) owner.set(f, seedMod);
  else if (!r || r.size === 0) owner.set(f, 'UNREACHED');
  else if (r.size === 1) owner.set(f, [...r][0]);
  else if (r.has('core')) owner.set(f, 'core'); // core must keep anything it reaches
  else owner.set(f, 'SHARED:' + [...r].sort((a, b) => a.localeCompare(b)).join('+'));
}

// A test file belongs to whoever owns the file it tests (x.test.ts → x.ts,
// x.integration.test.ts → x.ts); otherwise to whoever owns what it imports.
for (const [f, o] of owner) {
  if (o !== 'UNREACHED' || !f.endsWith('.test.ts')) continue;
  const subject = f.replace(/(.[a-z-]+)?.test.ts$/, '.ts');
  const viaSubject = owner.get(subject);
  if (viaSubject && viaSubject !== 'UNREACHED') {
    owner.set(f, viaSubject);
    continue;
  }
  const owners = new Set([...(imports.get(f) ?? [])].map((d) => owner.get(d)).filter((x) => x && x !== 'UNREACHED' && x !== 'core'));
  if (owners.size === 1) owner.set(f, [...owners][0]);
}

const target = process.argv[2];
if (target === '--core-shared') {
  // handled below
} else if (!target) {
  const counts = {};
  for (const o of owner.values()) counts[o.startsWith('SHARED') ? 'SHARED' : o] = (counts[o.startsWith('SHARED') ? 'SHARED' : o] ?? 0) + 1;
  console.log(counts);
  const shared = [...owner].filter(([, o]) => o.startsWith('SHARED')).map(([f, o]) => `${rel(f)}  ${o}`).sort((a, b) => a.localeCompare(b));
  console.log('\nSHARED (reached by >1 non-core module):\n' + shared.join('\n'));
  // core files importing module-owned files (core -> module edges)
  const edges = [];
  for (const [f, o] of owner) {
    if (o !== 'core') continue;
    for (const d of imports.get(f) ?? []) {
      const od = owner.get(d);
      if (od && od !== 'core' && !od.startsWith('SHARED')) edges.push(`${rel(f)} -> ${rel(d)} (${od})`);
    }
  }
  console.log('\nCORE -> MODULE edges:\n' + edges.sort((a, b) => a.localeCompare(b)).join('\n'));
} else if (target !== '--core-shared') {
  const mine = [...owner].filter(([, o]) => o === target).map(([f]) => f);
  console.log(`# ${target}: ${mine.length} files`);
  console.log(mine.map(rel).sort((a, b) => a.localeCompare(b)).join('\n'));
  console.log(`\n# ${target} -> outside imports`);
  const out = new Set();
  for (const f of mine) for (const d of imports.get(f) ?? []) if (owner.get(d) !== target) out.add(`${rel(d)} [${owner.get(d)}]  <- ${rel(f)}`);
  console.log([...out].sort((a, b) => a.localeCompare(b)).join('\n'));
  console.log(`\n# inbound: other files importing ${target} files`);
  const inb = new Set();
  for (const [f, deps] of imports) {
    if (owner.get(f) === target) continue;
    for (const d of deps) if (owner.get(d) === target) inb.add(`${rel(f)} [${owner.get(f)}] -> ${rel(d)}`);
  }
  console.log([...inb].sort((a, b) => a.localeCompare(b)).join('\n'));
}

if (process.argv[2] === '--core-shared') {
  const rows = [];
  for (const [f, o] of owner) {
    if (o !== 'core') continue;
    const r = [...(reachers.get(f) ?? [])].filter((m) => m !== 'core');
    if (r.length) rows.push(`${rel(f)}  <- ${r.sort((a, b) => a.localeCompare(b)).join(',')}`);
  }
  console.log(rows.sort((a, b) => a.localeCompare(b)).join('\n'));
  console.log('\nMULTI seeds:', [...seeds].filter(([, m]) => m === 'MULTI').map(([f]) => rel(f)));
  console.log('\nUNREACHED non-test:', [...owner].filter(([f, o]) => o === 'UNREACHED' && !f.endsWith('.test.ts') && !f.includes('/test/')).map(([f]) => rel(f)));
}
