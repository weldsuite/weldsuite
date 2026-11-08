#!/usr/bin/env node
/**
 * Picks the diff base for a deploy: the commit the last SUCCESSFUL deploy of
 * the same environment shipped. Not the push's `before`: concurrency keeps
 * only the newest pending run (older ones are cancelled) and a failed run
 * deploys nothing, so diffing against `before` would drop those pushes'
 * workers for good.
 *
 * Run from a checkout of this repo with full history (fetch-depth: 0) at the
 * commit being deployed.
 *
 * Env:
 *   SOURCES   JSON array of run histories to try, in order. Each one:
 *               { "repo": "owner/name", "workflow": "deploy.yml",
 *                 "branch"?: "develop", "event"?: "push",
 *                 "sha"?: "head" | "title", "exclude"?: "(plan only)" }
 *             `sha: "head"` (default) takes the run's head commit, for runs
 *             of this repo. `sha: "title"` takes the first 40-character sha
 *             in the run's title, for the private deploy repo, whose runs
 *             name the public commit they deployed (`run-name`). Runs whose
 *             title contains `exclude` are skipped.
 *             The newest successful run of the first source whose commit is
 *             an ancestor of HEAD wins.
 *   BEFORE    fallback when no source has one (the push's `before`); a zero
 *             sha counts as missing
 *   GH_TOKEN  a token that can list those runs (actions: read)
 *
 * Writes `base=<sha or empty>` to GITHUB_OUTPUT. Empty means "no usable base":
 * the change detection then deploys everything it cannot rule out.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const SHA_RE = /\b[0-9a-f]{40}\b/;
const TITLE_SCAN = 30;

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function isAncestor(sha) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The commit the newest successful run of `source` deployed, or "". */
function lastDeployed(source) {
  const mode = source.sha ?? 'head';
  const args = ['run', 'list', '--repo', source.repo, '--workflow', source.workflow, '--status', 'success'];
  if (source.branch) args.push('--branch', source.branch);
  if (source.event) args.push('--event', source.event);
  // Head mode keeps the old `--limit 1`: only the newest success counts.
  args.push('--limit', mode === 'head' ? '1' : String(TITLE_SCAN), '--json', 'headSha,displayTitle');
  let runs;
  try {
    runs = JSON.parse(run('gh', args) || '[]');
  } catch (err) {
    console.log(`Could not list runs of ${source.repo} ${source.workflow}: ${err.stderr || err.message}`);
    return '';
  }
  for (const r of runs) {
    if (mode === 'head') return r.headSha ?? '';
    if (source.exclude && (r.displayTitle ?? '').includes(source.exclude)) continue;
    const match = (r.displayTitle ?? '').match(SHA_RE);
    if (match) return match[0];
  }
  return '';
}

const sources = JSON.parse(process.env.SOURCES || '[]');
const before = process.env.BEFORE ?? '';

let base = '';
const tried = [];
for (const source of sources) {
  const last = lastDeployed(source);
  const label = `${source.repo} ${source.workflow}${source.branch ? ` (${source.branch})` : ''}`;
  if (last && isAncestor(last)) {
    base = last;
    tried.push(`${label}: ${last}`);
    break;
  }
  tried.push(`${label}: ${last ? `${last} (not an ancestor of HEAD)` : 'none'}`);
}
if (!base && before && !/^0+$/.test(before)) base = before;

console.log(`Diff base: ${base || '<none>'} (last successful deploy: ${tried.join('; ') || 'no sources'}; push before: ${before || 'none'})`);

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `base=${base}\n`);
