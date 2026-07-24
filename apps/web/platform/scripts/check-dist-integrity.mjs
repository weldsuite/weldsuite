// Post-build integrity guard for the platform SPA.
//
// Vite emits content-hashed chunks and wires their dependency graph through a
// `__vite__mapDeps` preload table plus dynamic `import()` specifiers. If the
// build (or a stale Turbo/Pages cache, or a partial upload) ever ships an entry
// that references a chunk hash that was never written to `dist/assets`, the
// browser requests a file that doesn't exist. On Cloudflare Pages the SPA
// fallback answers that 404 with `index.html` (MIME `text/html`), the dynamic
// import is rejected, and TanStack Router crashes reading `.component` off the
// undefined module — taking the whole app down with a white screen.
//
// That exact failure shipped once (entry referenced conversation-list-item /
// webhook / index chunks that weren't served). This guard makes such a `dist`
// fail the build instead of reaching production: it scans every emitted JS/CSS
// file + index.html, collects every `assets/<name>` reference, and asserts the
// target file exists on disk.
//
// Exit 0 = consistent. Exit 1 = dangling reference(s) — do NOT deploy.

/* global process */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const platformRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(platformRoot, 'dist');
const assetsDir = join(distDir, 'assets');

if (!existsSync(assetsDir)) {
  console.error(`[check-dist] ${assetsDir} not found — run \`vite build\` first.`);
  process.exit(1);
}

// Every asset file actually present on disk.
const present = new Set(readdirSync(assetsDir));

// Files to scan for references: index.html + everything under assets/.
const scanTargets = [];
if (existsSync(join(distDir, 'index.html'))) scanTargets.push(join(distDir, 'index.html'));
for (const f of readdirSync(assetsDir)) {
  if (f.endsWith('.js') || f.endsWith('.css') || f.endsWith('.html')) {
    scanTargets.push(join(assetsDir, f));
  }
}

// Matches `assets/<name>.js`, `/assets/<name>.css`, `./<name>.js` — the forms
// Vite uses in mapDeps tables, import specifiers, and HTML href/src attrs.
const refRe = /(?:\.?\/)?assets\/([A-Za-z0-9._-]+\.(?:js|css))|(?:^|["'(])\.\/([A-Za-z0-9._-]+\.(?:js|css))/g;

const missing = new Map(); // missing filename -> Set(referencing files)

for (const file of scanTargets) {
  const txt = readFileSync(file, 'utf8');
  let m;
  while ((m = refRe.exec(txt))) {
    const name = m[1] ?? m[2];
    if (!name) continue;
    if (!present.has(name)) {
      if (!missing.has(name)) missing.set(name, new Set());
      missing.get(name).add(file.slice(distDir.length + 1));
    }
  }
}

if (missing.size === 0) {
  console.log(`[check-dist] OK — ${present.size} assets, no dangling chunk references.`);
  process.exit(0);
}

console.error(`[check-dist] FAILED — ${missing.size} referenced chunk(s) are missing from dist/assets:`);
for (const [name, from] of missing) {
  console.error(`  • ${name}`);
  console.error(`      referenced by: ${[...from].slice(0, 6).join(', ')}`);
}
console.error('[check-dist] This dist would white-screen on load. Do NOT deploy it.');
console.error('[check-dist] Rebuild from a clean state (clear Turbo + Vite caches) and re-run.');
process.exit(1);
