#!/usr/bin/env node
/**
 * `pnpm --filter weldpass-extension zip`: the store build (`vite build
 * --mode store`, run by the script before this) zipped for the Chrome Web
 * Store and Edge Add-ons, at `release/weldpass-extension-<version>.zip`.
 * (Not `pack`: that is a pnpm command of its own, which makes a tarball.)
 *
 * It refuses a build that isn't the store build: one with a `key` (the store
 * rejects it), with another default server than WeldSuite EU, with source
 * maps, or with a version other than package.json's. Nobody uploads it
 * automatically; a person does (store/README.md).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const EU_HOSTS = ['https://app.weldsuite.eu/*', 'https://auth.weldsuite.eu/*'];
// A fixed date keeps the zip byte-for-byte the same for the same build.
const MTIME = new Date('2026-01-01T00:00:00Z');

function fail(message) {
  console.error(`zip: ${message}`);
  process.exit(1);
}

function files(dir, prefix = '') {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    return statSync(full).isDirectory() ? files(full, rel) : [rel];
  });
}

const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
let manifest;
try {
  manifest = JSON.parse(readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
} catch {
  fail('no dist/manifest.json: run `vite build --mode store` first (the zip script does).');
}

if ('key' in manifest) fail('the manifest has a `key`: this is not a store build (vite build --mode store).');
if (manifest.version !== version) fail(`manifest version ${manifest.version} is not package.json's ${version}.`);
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(EU_HOSTS)) {
  fail(`the store build serves WeldSuite EU only; host_permissions are ${JSON.stringify(manifest.host_permissions)}. Unset VITE_DEFAULT_SERVER / VITE_DEFAULT_ISSUER.`);
}

const entries = files(dist).sort();
if (entries.some((file) => file.endsWith('.map'))) fail('source maps in dist/: the store build ships none.');
for (const required of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'menu.html', 'prompt.html', 'settings.html']) {
  if (!entries.includes(required)) fail(`dist/ has no ${required}.`);
}

const zip = zipSync(
  Object.fromEntries(entries.map((file) => [file, [readFileSync(path.join(dist, file)), { mtime: MTIME, level: 9 }]])),
);
const outDir = path.join(root, 'release');
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `weldpass-extension-${version}.zip`);
writeFileSync(out, zip);

const sha256 = createHash('sha256').update(zip).digest('hex');
console.log(`zip: ${path.relative(root, out)} (${(zip.length / 1024).toFixed(0)} KB, ${entries.length} files)`);
console.log(`zip: sha256 ${sha256}`);
console.log(`zip: permissions ${manifest.permissions.join(', ')}; hosts ${manifest.host_permissions.join(', ')}`);
