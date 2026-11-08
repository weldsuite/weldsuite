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
 *   SOURCES   JSON array of deploy histories to try, in order. Two kinds:
 *               { "repo": "owner/name", "workflow": "deploy.yml",
 *                 "branch"?: "main", "event"?: "push" }
 *                 the head commit of the newest successful run of a
 *                 workflow (the public deploy.yml history, until 2026-11-08);
 *               { "repo": "owner/name", "environment": "test",
 *                 "task": "deploy:weldsuite" }
 *                 the newest deployment record with that task whose latest
 *                 status is `success`, with the deployed commit in
 *                 `payload.sha`: what the private deploy repo records after
 *                 each deploy (docs/plans/main-only-private-deploys.md).
 *             The first source whose commit is an ancestor of HEAD wins.
 *   BEFORE    fallback when no source has one (the push's `before`); a zero
 *             sha counts as missing
 *   GH_TOKEN  a token that can read those runs or deployments
 *
 * Writes `base=<sha or empty>` to GITHUB_OUTPUT. Empty means "no usable base":
 * the change detection then deploys everything it cannot rule out.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const FULL_SHA = /^[0-9a-f]{40}$/;
const RECORD_SCAN = 30;

function ghJson(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return out ? JSON.parse(out) : null;
}

function isAncestor(sha) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Head commit of the newest successful run (the old `--limit 1` lookup). */
function fromRuns(source) {
  const args = ['run', 'list', '--repo', source.repo, '--workflow', source.workflow, '--status', 'success'];
  if (source.branch) args.push('--branch', source.branch);
  if (source.event) args.push('--event', source.event);
  args.push('--limit', '1', '--json', 'headSha');
  return ghJson(args)?.[0]?.headSha ?? '';
}

/** Commit of the newest deployment record whose latest status is success. */
function fromDeployments(source) {
  const query = new URLSearchParams({
    environment: source.environment,
    task: source.task,
    per_page: String(RECORD_SCAN),
  });
  const deployments = ghJson(['api', `repos/${source.repo}/deployments?${query}`]) ?? [];
  for (const d of deployments) {
    const [latest] = ghJson(['api', `repos/${source.repo}/deployments/${d.id}/statuses?per_page=1`]) ?? [];
    if (latest?.state !== 'success') continue;
    const payload = typeof d.payload === 'string' ? JSON.parse(d.payload || '{}') : (d.payload ?? {});
    if (FULL_SHA.test(payload.sha ?? '')) return payload.sha;
  }
  return '';
}

function lastDeployed(source) {
  try {
    return source.workflow ? fromRuns(source) : fromDeployments(source);
  } catch (err) {
    console.log(`Could not read the deploy history of ${source.repo}: ${err.stderr || err.message}`);
    return '';
  }
}

const sources = JSON.parse(process.env.SOURCES || '[]');
const before = process.env.BEFORE ?? '';

let base = '';
const tried = [];
for (const source of sources) {
  const last = lastDeployed(source);
  const label = source.workflow
    ? `${source.repo} ${source.workflow}${source.branch ? ` (${source.branch})` : ''}`
    : `${source.repo} deployments (${source.environment})`;
  if (last && isAncestor(last)) {
    base = last;
    tried.push(`${label}: ${last}`);
    break;
  }
  tried.push(`${label}: ${last ? `${last} (not an ancestor of HEAD)` : 'none'}`);
}
if (!base && before && !/^0+$/.test(before)) base = before;

console.log(
  `Diff base: ${base || '<none>'} (last successful deploy: ${tried.join('; ') || 'no sources'}; push before: ${before || 'none'})`,
);

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `base=${base}\n`);
