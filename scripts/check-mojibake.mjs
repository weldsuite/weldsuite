#!/usr/bin/env node
/**
 * Fails when a tracked source file contains mojibake: UTF-8 text that was once
 * read as Windows-1252 and saved again, so an em dash became "a-circumflex,
 * euro sign, right double quote" (TASK-690 shipped that to the WeldDrive size
 * column).
 *
 *   pnpm check:mojibake
 *
 * The patterns are written as \u escapes so this file does not match itself.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.html', '.css', '.yml', '.yaml', '.toml',
]);

// Files that hold mojibake on purpose (e.g. a fixture for a charset decoder).
const ALLOWED = new Set([]);

// What a UTF-8 lead byte looks like after a Windows-1252 round trip:
//   E2 80 xx  dashes, curly quotes, ellipsis, bullets
//   E2 86 xx  arrows
//   E2 82 AC  euro sign
//   C3 A0-BF  accented lowercase letters
//   C2 A0-BF  non-breaking space, middle dot, copyright, degree, ...
const MOJIBAKE = /â€|â†|â‚¬|Ã[ -¿]|Â[ -¿]/;

const files = execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  .split('\0')
  .filter((f) => f && EXTENSIONS.has(path.extname(f)) && !ALLOWED.has(f));

const hits = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(path.join(repo, file), 'utf8');
  } catch {
    continue; // tracked but deleted in the working tree
  }
  if (!MOJIBAKE.test(text)) continue;
  text.split('\n').forEach((line, i) => {
    if (MOJIBAKE.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
}

if (hits.length > 0) {
  console.error(`Mojibake found in ${hits.length} line(s):\n`);
  for (const hit of hits) console.error(`  ${hit}`);
  console.error('\nRe-type the garbled characters and save the file as UTF-8.');
  process.exit(1);
}

console.log(`No mojibake in ${files.length} files.`);
