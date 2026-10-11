#!/usr/bin/env node
/**
 * Reports the Sonar-rule findings (eslint.sonar.config.mjs) that a branch adds,
 * the way Sonar's "new code" quality gate did. CI runs it on every pull request
 * (.github/workflows/sonarjs.yml).
 *
 *   pnpm lint:sonar:new              against origin/develop
 *   pnpm lint:sonar:new <base-ref>   against another branch or commit
 *
 * Every changed file is linted twice: as it is now, and as it was at the merge
 * base. A finding counts as new unless the base version had the same one: same
 * rule, same message, same source line text. Matching on the line's text rather
 * than its number keeps findings that only moved from showing up as new, and a
 * finding on a line you edited counts as yours. A file the branch adds has no
 * base version, so all of its findings are new.
 *
 * Exits 1 when there are new findings. In GitHub Actions each one also becomes
 * an annotation on the PR diff and a row in the job summary.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE_FILE = /^(apps|packages|scripts)\/.+\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/;

// core.safecrlf=false: keep Windows checkouts from printing a line-ending
// warning for every changed file.
const git = (...args) =>
  execFileSync('git', ['-c', 'core.safecrlf=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });

const baseRef = process.argv[2] ?? 'origin/develop';
const mergeBase = git('merge-base', baseRef, 'HEAD').trim();

// Changed files, mapped to their path at the merge base (null when added).
// Compares the working tree, so uncommitted and untracked files count too.
function changedFiles() {
  const changed = new Map();
  const fields = git('diff', '--name-status', '-z', '-M', '--diff-filter=ACMR', mergeBase).split('\0');
  for (let i = 0; i < fields.length - 1; ) {
    const status = fields[i++];
    // Renames and copies list the old path first. A copy is new code.
    const from = /^[RC]/.test(status) ? fields[i++] : null;
    const file = fields[i++];
    if (status.startsWith('R')) changed.set(file, from);
    else changed.set(file, status === 'M' ? file : null);
  }
  for (const file of git('ls-files', '--others', '--exclude-standard', '-z').split('\0')) {
    if (file) changed.set(file, null);
  }
  return new Map([...changed].filter(([file]) => CODE_FILE.test(file)));
}

const findingKey = (message, lines) =>
  `${message.ruleId}\0${message.message}\0${(lines[message.line - 1] ?? '').trim()}`;

const eslint = new ESLint({ cwd: repo, overrideConfigFile: 'eslint.sonar.config.mjs' });

const files = [];
for (const [file, basePath] of changedFiles()) {
  if (!(await eslint.isPathIgnored(file))) files.push({ file, basePath });
}
if (files.length === 0) {
  console.log(`No changed JavaScript or TypeScript files to check against ${baseRef}.`);
  process.exit(0);
}

const results = new Map(
  (await eslint.lintFiles(files.map(f => f.file))).map(r => [
    path.relative(repo, r.filePath).split(path.sep).join('/'),
    r,
  ]),
);
const findings = [];
let carried = 0;

for (const { file, basePath } of files) {
  const result = results.get(file);
  if (!result?.messages.length) continue;

  const baseCounts = new Map();
  if (basePath) {
    const baseText = git('show', `${mergeBase}:${basePath}`);
    const [baseResult] = await eslint.lintText(baseText, { filePath: path.join(repo, file) });
    const baseLines = baseText.split('\n');
    for (const message of baseResult.messages) {
      const key = findingKey(message, baseLines);
      baseCounts.set(key, (baseCounts.get(key) ?? 0) + 1);
    }
  }

  const lines = readFileSync(path.join(repo, file), 'utf8').split('\n');
  for (const message of result.messages) {
    const key = findingKey(message, lines);
    const inBase = baseCounts.get(key) ?? 0;
    if (inBase > 0 && !message.fatal) {
      baseCounts.set(key, inBase - 1);
      carried++;
    } else {
      findings.push({ file, ...message });
    }
  }
}

const rule = f => f.ruleId ?? 'parse error';
for (const f of findings) console.log(`${f.file}:${f.line}:${f.column}  ${f.message}  ${rule(f)}`);
console.log(
  `\n${files.length} changed file(s) checked against ${baseRef}: ` +
    `${findings.length} new finding(s), ${carried} already there before (not reported).`,
);

if (process.env.GITHUB_ACTIONS) {
  const data = s => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const prop = s => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  for (const f of findings) {
    const end = f.endLine ? `,endLine=${f.endLine},endColumn=${f.endColumn}` : '';
    console.log(
      `::error file=${prop(f.file)},line=${f.line},col=${f.column}${end},title=${prop(rule(f))}::${data(f.message)}`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY && findings.length) {
    const cell = s => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const rows = findings.map(f => `| \`${f.file}:${f.line}\` | ${cell(f.message)} | \`${rule(f)}\` |`);
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### ${findings.length} new Sonar finding(s)\n\n| Where | Finding | Rule |\n|---|---|---|\n${rows.join('\n')}\n`,
    );
  }
}

process.exit(findings.length ? 1 : 0);
