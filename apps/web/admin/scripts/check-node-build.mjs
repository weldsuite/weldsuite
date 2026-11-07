// Checks the Node build (`pnpm build:node`, ADR FE-018) for code that belongs
// to Global's Worker only: Clerk (staff on Kubernetes sign in with the
// install's Zitadel), Neon's driver (Postgres is reached over TCP there) and
// Cloudflare's runtime modules (there is no Workers runtime). The Vite aliases
// in vite.config.ts swap all three out; this fails the build if a new import
// brings one back in.
//
//   node scripts/check-node-build.mjs        after `vite build --mode node`

/* global process */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist', import.meta.url));

/** What may not appear in any file of the Node build, and why. */
const FORBIDDEN = [
  { pattern: /@clerk\//, why: 'a Clerk package' },
  { pattern: /__clerk_handshake|clerk\.accounts\.dev/, why: "Clerk's SDK" },
  { pattern: /@neondatabase\//, why: "Neon's driver" },
  { pattern: /(?:from\s*|import\s*\(\s*|require\(\s*)["']cloudflare:/, why: 'a Cloudflare runtime module' },
];

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.(?:m?js|css|html)$/.test(entry.name)) yield path;
  }
}

const problems = [];
let checked = 0;
for await (const file of files(dist)) {
  checked++;
  const text = await readFile(file, 'utf8');
  for (const { pattern, why } of FORBIDDEN) {
    if (pattern.test(text)) problems.push(`${relative(dist, file)}: ${why} (${pattern})`);
  }
}

if (checked === 0) {
  console.error('[check-node-build] dist/ is empty: run `vite build --mode node` first');
  process.exit(1);
}
if (problems.length > 0) {
  console.error('[check-node-build] the Node build carries Global-only code:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`[check-node-build] ${checked} files, no Clerk, Neon driver or Cloudflare runtime modules`);
