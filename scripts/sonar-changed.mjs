#!/usr/bin/env node
/**
 * Narrows a SonarQube Cloud scan to the files a branch changes, so a pull
 * request is analysed in minutes instead of scanning the whole monorepo (which
 * took 20+ minutes and ran out of memory, ADR OPS-010). CI runs it right
 * before the scanner (.github/workflows/sonarqube.yml).
 *
 *   pnpm sonar:changed              against origin/develop
 *   pnpm sonar:changed <base-ref>   against another branch or commit
 *
 * It writes .sonar-changed/sonar-project.properties: a copy of the committed
 * sonar-project.properties with three settings appended (later keys win):
 *   - sonar.inclusions / sonar.test.inclusions: the changed files, sorted into
 *     main and test files by the sonar.test.inclusions patterns. Files under
 *     sonar.exclusions are dropped here already.
 *   - sonar.typescript.tsconfigPaths: one generated tsconfig.sonar.json per
 *     workspace the branch touches, extending its tsconfig.json but listing
 *     only the changed files. TypeScript still follows their imports for type
 *     information, but never builds a program over a whole workspace.
 * The scanner reads it with -Dproject.settings=<that file>.
 *
 * Sonar reports a PR's issues on the lines it changes only, so skipping the
 * unchanged files loses nothing there. The one thing it narrows is duplication:
 * a changed block is compared with the other changed files, not the whole repo.
 *
 * In GitHub Actions it also sets the step outputs `files` (how many files the
 * scan covers; 0 means skip it) and `settings` (the properties file).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROPERTIES = 'sonar-project.properties';
const OUT_DIR = '.sonar-changed';
const GENERATED_TSCONFIG = 'tsconfig.sonar.json';
const TS_FILE = /\.(ts|tsx|mts|cts)$/;
// The CLI's scaffold template is a project of its own, not workspace code.
const NO_PROGRAM = [/^packages\/sdk\/cli\/templates\//];
// Matches nothing, for an inclusion list that has no files. An empty value
// would mean "no filter" and include the whole tree.
const NOTHING = '__no_changed_files__';

const git = (...args) =>
  execFileSync('git', ['-c', 'core.safecrlf=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });

const baseRef = process.argv[2] ?? 'origin/develop';
const mergeBase = git('merge-base', baseRef, 'HEAD').trim();

// ── sonar-project.properties ────────────────────────────────────────────────

function readProperties(text) {
  const props = new Map();
  let pending = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = pending + raw.trim();
    if (line.endsWith('\\')) {
      pending = line.slice(0, -1);
      continue;
    }
    pending = '';
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const at = line.search(/[=:]/);
    if (at > 0) props.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return props;
}

const list = value =>
  (value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

// Sonar's wildcard patterns: ** spans directories, * and ? stay inside one.
function wildcard(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 3;
    } else if (pattern.startsWith('**', i)) {
      re += '.*';
      i += 2;
    } else if (pattern[i] === '*') {
      re += '[^/]*';
      i++;
    } else if (pattern[i] === '?') {
      re += '[^/]';
      i++;
    } else {
      re += pattern[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

const matcher = patterns => {
  const regexes = patterns.map(wildcard);
  return file => regexes.some(re => re.test(file));
};

const underRoot = roots => file => roots.some(root => file === root || file.startsWith(`${root}/`));

const propertiesText = readFileSync(path.join(repo, PROPERTIES), 'utf8');
const props = readProperties(propertiesText);
const inSources = underRoot(list(props.get('sonar.sources')));
const inTests = underRoot(list(props.get('sonar.tests')));
const isExcluded = matcher(list(props.get('sonar.exclusions')));
const isTest = matcher(list(props.get('sonar.test.inclusions')));

// ── Changed files ───────────────────────────────────────────────────────────

// Added, copied, modified or renamed (new path) since the merge base. Compares
// the working tree, so uncommitted and untracked files count too.
function changedFiles() {
  const changed = new Set(
    git('diff', '--name-only', '-z', '-M', '--diff-filter=ACMR', mergeBase).split('\0').filter(Boolean),
  );
  for (const file of git('ls-files', '--others', '--exclude-standard', '-z').split('\0')) {
    if (file) changed.add(file);
  }
  return [...changed].filter(file => existsSync(path.join(repo, file))).sort();
}

const main = [];
const tests = [];
for (const file of changedFiles()) {
  if (isExcluded(file)) continue;
  if (isTest(file) && inTests(file)) tests.push(file);
  else if (!isTest(file) && inSources(file)) main.push(file);
}

// ── TypeScript programs ─────────────────────────────────────────────────────

// The nearest tsconfig.json above a file, never the repo root's: it has no
// "include" and would be a program over the entire monorepo.
function nearestTsconfigDir(file) {
  let dir = path.posix.dirname(file);
  while (dir !== '.' && dir !== '') {
    if (existsSync(path.join(repo, dir, 'tsconfig.json'))) return dir;
    dir = path.posix.dirname(dir);
  }
  return null;
}

function parseConfig(configPath) {
  const diagnostics = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    { noEmit: true },
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: d => diagnostics.push(d) },
  );
  diagnostics.push(...(parsed?.errors ?? []));
  return { parsed, diagnostics };
}

const byWorkspace = new Map();
for (const file of [...main, ...tests]) {
  if (!TS_FILE.test(file) || NO_PROGRAM.some(re => re.test(file))) continue;
  const dir = nearestTsconfigDir(file);
  if (!dir) continue;
  if (!byWorkspace.has(dir)) byWorkspace.set(dir, []);
  byWorkspace.get(dir).push(file);
}

const tsconfigs = [];
const warnings = [];
for (const [dir, files] of byWorkspace) {
  const generated = path.join(repo, dir, GENERATED_TSCONFIG);
  const config = {
    extends: './tsconfig.json',
    // composite would require every file of the workspace to be listed.
    compilerOptions: { composite: false, incremental: false },
    files: files.map(file => path.posix.relative(dir, file)),
    // "include" is inherited through "extends" unless overridden.
    include: [],
    // No "references": Sonar would build the referenced projects whole.
  };
  writeFileSync(
    generated,
    `// Generated by scripts/sonar-changed.mjs for the SonarQube scan. Do not edit or commit.\n${JSON.stringify(config, null, 2)}\n`,
  );
  const { parsed, diagnostics } = parseConfig(generated);
  const listed = new Set((parsed?.fileNames ?? []).map(f => path.relative(repo, f).split(path.sep).join('/')));
  const missing = files.filter(file => !listed.has(file));
  if (!parsed || diagnostics.length || missing.length) {
    const errors = diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ');
    const why = errors || missing.length + ' file(s) not in program';
    warnings.push(`${dir}: analysed without type information (${why})`);
    continue;
  }
  tsconfigs.push(`${dir}/${GENERATED_TSCONFIG}`);
}

// ── Output ──────────────────────────────────────────────────────────────────

// One value per line, with properties-file continuations.
const property = (key, values) => {
  const value = values.length ? '\\\n  ' + values.join(',\\\n  ') : NOTHING;
  return `${key}=${value}\n`;
};

const settings = `${OUT_DIR}/${PROPERTIES}`;
mkdirSync(path.join(repo, OUT_DIR), { recursive: true });
writeFileSync(
  path.join(repo, settings),
  `${propertiesText.trimEnd()}\n\n` +
    `# ── Generated by scripts/sonar-changed.mjs against ${baseRef} (${mergeBase.slice(0, 12)}) ──\n` +
    property('sonar.inclusions', main) +
    property('sonar.test.inclusions', tests) +
    // An empty path list would make Sonar look for every tsconfig.json itself.
    property('sonar.typescript.tsconfigPaths', tsconfigs),
);

const total = main.length + tests.length;
for (const warning of warnings) console.warn(`warning: ${warning}`);
console.log(
  `${total} changed file(s) to analyse against ${baseRef}: ${main.length} source, ${tests.length} test; ` +
    `${tsconfigs.length} TypeScript program(s).\nSettings: ${settings}`,
);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `files=${total}\nsettings=${settings}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const skipped = total ? '' : ' Nothing to analyse, scan skipped.';
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### SonarQube scope\n\n${main.length} source and ${tests.length} test file(s) changed; ` +
      `${tsconfigs.length} TypeScript program(s).${skipped}\n` +
      warnings.map(w => '\n- ' + w).join('') +
      '\n',
  );
}
