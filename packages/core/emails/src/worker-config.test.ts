/**
 * Guard: most API workers alias `react` to an empty shim in wrangler.toml to
 * keep it out of their bundle. A worker that (directly or through another
 * @weldsuite package) bundles @weldsuite/emails must not, or every email it
 * renders fails at runtime while its tests, which use real react, still pass.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '../../../..');

function readJson(file: string): { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function weldsuiteDeps(pkg: ReturnType<typeof readJson>): string[] {
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => d.startsWith('@weldsuite/'));
}

/** package name → its @weldsuite/* dependencies, for every package under packages/. */
function packageGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const root = join(repo, 'packages');
  for (const group of readdirSync(root)) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir) || !readdirSync(groupDir, { withFileTypes: true }).length) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      const file = join(groupDir, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const pkg = readJson(file);
      if (pkg.name) graph.set(pkg.name, weldsuiteDeps(pkg));
    }
  }
  return graph;
}

function reachesEmails(name: string, graph: Map<string, string[]>, seen = new Set<string>()): boolean {
  if (name === '@weldsuite/emails') return true;
  if (seen.has(name)) return false;
  seen.add(name);
  return (graph.get(name) ?? []).some((dep) => reachesEmails(dep, graph, seen));
}

describe('workers that send system email', () => {
  it('do not alias react to an empty shim in wrangler.toml', () => {
    const graph = packageGraph();
    const workersDir = join(repo, 'apps', 'workers');
    const offenders: string[] = [];
    let checked = 0;

    for (const worker of readdirSync(workersDir)) {
      const pkgFile = join(workersDir, worker, 'package.json');
      const wrangler = join(workersDir, worker, 'wrangler.toml');
      if (!existsSync(pkgFile) || !existsSync(wrangler)) continue;
      if (!weldsuiteDeps(readJson(pkgFile)).some((dep) => reachesEmails(dep, graph))) continue;
      checked += 1;
      if (/^\s*"react"\s*=/m.test(readFileSync(wrangler, 'utf8'))) offenders.push(worker);
    }

    expect(checked).toBeGreaterThan(0);
    expect(offenders, `remove the "react" alias from these workers' wrangler.toml`).toEqual([]);
  });
});
