// Checks the build (`pnpm build`, ADR FE-018) for code of the retired
// Cloudflare Worker build: Clerk (staff sign in with the install's OIDC
// provider), Neon's driver (Postgres is reached over TCP) and Cloudflare's
// runtime modules (the console runs on Node). None of them is a dependency
// any more; this fails the build if a new import brings one back in.
//
//   node scripts/check-node-build.mjs        after `vite build`

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
  console.error('[check-node-build] dist/ is empty: run `vite build` first');
  process.exit(1);
}
if (problems.length > 0) {
  console.error('[check-node-build] the build carries code of the Worker build:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`[check-node-build] ${checked} files, no Clerk, Neon driver or Cloudflare runtime modules`);
