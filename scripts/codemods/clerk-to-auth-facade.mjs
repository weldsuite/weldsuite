#!/usr/bin/env node
/**
 * Codemod (P4 work package 4.F1, ADR SEC-012): move the platform's imports
 * off `@clerk/clerk-react`, `@clerk/clerk-react/errors` and `@clerk/types`
 * onto the auth facade.
 *
 *   - provider-neutral symbols (`useAuth`, `useUser`, `useOrganization`,
 *     `useOrganizationList`) → `@/lib/auth`
 *   - Clerk-only symbols (`useSignIn`, `useSignUp`, `useSession`,
 *     `useReverification`, `useClerk`, the error guards, resource types)
 *     → `@/lib/auth/clerk`
 *   - `const { signOut } = useClerk()` → `const { signOut } = useAuth()`
 *     (sign-out is part of the facade; Clerk's `useAuth().signOut` is the
 *     same call)
 *
 * Test mocks (`vi.mock('@clerk/clerk-react', …)`) are left alone on purpose:
 * the facade's Clerk implementation calls those hooks, so the mocks keep
 * driving the components through the facade.
 *
 * Usage: node scripts/codemods/clerk-to-auth-facade.mjs [--dry-run] [root]
 * (root defaults to apps/web/platform). Idempotent; prints the files changed.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const root = resolve(args.find((a) => !a.startsWith('--')) ?? 'apps/web/platform');

const FACADE = '@/lib/auth';
const CLERK_ONLY = '@/lib/auth/clerk';
const SOURCES = new Set(['@clerk/clerk-react', '@clerk/clerk-react/errors', '@clerk/types']);
const FACADE_SYMBOLS = new Set(['useAuth', 'useUser', 'useOrganization', 'useOrganizationList']);
const CLERK_ONLY_SYMBOLS = new Set([
  'useClerk',
  'useSignIn',
  'useSignUp',
  'useSession',
  'useReverification',
  'isClerkAPIResponseError',
  'isClerkRuntimeError',
  'isReverificationCancelledError',
  'PasskeyResource',
  'TOTPResource',
  'SessionWithActivitiesResource',
]);
// Never rewritten: the facade itself, Playwright (uses @clerk/testing), the entry (hand-edited).
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo', 'e2e']);
const SKIP_PREFIXES = [join(root, 'lib', 'auth') + sep];

// Marks where a rewritten import goes while the file is being edited.
const PLACEHOLDER = '@@clerk-facade-import@@';
const IMPORT_RE = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\3;?/g;

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !SKIP_PREFIXES.some((p) => path.startsWith(p))) out.push(path);
  }
  return out;
}

/** `a, type B, c as d` → [{ name, local, type }]. */
function parseSpecifiers(list, allType) {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => {
      const type = allType || raw.startsWith('type ');
      const body = raw.replace(/^type\s+/, '');
      const [name, local] = body.replace(/\s+/g, ' ').split(' as ').map((x) => x.trim());
      return { name, local: local ?? name, type };
    });
}

function formatSpecifier(s) {
  const alias = s.local === s.name ? '' : ' as ' + s.local;
  return (s.type ? 'type ' : '') + s.name + alias;
}

function formatImport(specs, source, quote, semi) {
  const allType = specs.every((s) => s.type);
  const parts = specs.map((s) => (allType ? { ...s, type: false } : s)).map(formatSpecifier);
  return `import ${allType ? 'type ' : ''}{ ${parts.join(', ')} } from ${quote}${source}${quote}${semi ? ';' : ''}`;
}

function transform(text) {
  const moved = { [FACADE]: [], [CLERK_ONLY]: [] };
  let quote = "'";
  let semi = true;
  let firstAt = -1;
  let out = text.replace(IMPORT_RE, (match, typeKw, list, q, source, offset) => {
    if (!SOURCES.has(source)) return match;
    quote = q;
    semi = match.trimEnd().endsWith(';');
    if (firstAt < 0) firstAt = offset;
    for (const spec of parseSpecifiers(list, Boolean(typeKw))) {
      if (FACADE_SYMBOLS.has(spec.name)) moved[FACADE].push(spec);
      else if (CLERK_ONLY_SYMBOLS.has(spec.name)) moved[CLERK_ONLY].push(spec);
      else throw new Error(`no facade route for ${spec.name} from ${source}`);
    }
    return PLACEHOLDER;
  });
  if (firstAt < 0) return text;

  // `const { signOut } = useClerk()` is the facade's sign-out.
  const clerkSpec = moved[CLERK_ONLY].find((s) => s.name === 'useClerk');
  if (clerkSpec) {
    const signOutOnly = new RegExp(`\\{\\s*signOut\\s*\\}\\s*=\\s*${clerkSpec.local}\\(\\)`, 'g');
    const anyUse = new RegExp(`\\b${clerkSpec.local}\\(`, 'g');
    const total = (out.match(anyUse) ?? []).length;
    const signOuts = (out.match(signOutOnly) ?? []).length;
    if (signOuts > 0) {
      let authSpec = moved[FACADE].find((s) => s.name === 'useAuth');
      if (!authSpec) {
        authSpec = { name: 'useAuth', local: 'useAuth', type: false };
        moved[FACADE].push(authSpec);
      }
      out = out.replace(signOutOnly, `{ signOut } = ${authSpec.local}()`);
      if (signOuts === total) moved[CLERK_ONLY] = moved[CLERK_ONLY].filter((s) => s !== clerkSpec);
    }
  }

  // Merge with imports of the facade the file already has.
  out = out.replace(IMPORT_RE, (match, typeKw, list, _q, source) => {
    if (source !== FACADE && source !== CLERK_ONLY) return match;
    moved[source].unshift(...parseSpecifiers(list, Boolean(typeKw)));
    return PLACEHOLDER;
  });

  const lines = [];
  for (const source of [FACADE, CLERK_ONLY]) {
    const seen = new Set();
    const specs = moved[source].filter((s) => {
      const key = `${s.name}|${s.local}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (specs.length) lines.push(formatImport(specs, source, quote, semi));
  }
  // The first placeholder becomes the new imports; the others disappear with their line.
  let first = true;
  out = out.replace(/@@clerk-facade-import@@(\r?\n)?/g, (_m, nl = '') => {
    if (!first) return '';
    first = false;
    return lines.join(nl || '\n') + nl;
  });
  return out;
}

const changed = [];
for (const file of walk(root, [])) {
  const text = readFileSync(file, 'utf8');
  if (!/@clerk\/(clerk-react|types)/.test(text)) continue;
  const next = transform(text);
  if (next !== text) {
    changed.push(relative(root, file));
    if (!dryRun) writeFileSync(file, next);
  }
}
for (const file of changed) console.log(file);
console.log(`${dryRun ? 'would change' : 'changed'} ${changed.length} files`);
