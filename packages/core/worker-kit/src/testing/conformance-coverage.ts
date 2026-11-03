/**
 * Which routes a conformance suite must reach: `coverage` in
 * rust/conformance/suites.json, the route prefixes of the route groups the
 * suite owns.
 *
 * A ported module must reach every route of its suites (the runner fails a
 * suite on an unreached route), and a suite's routes are the inventory its
 * test files record: every route of every router they mount. A test file
 * that mounts another group's router only to set up its data (WeldBooks'
 * tests create their accounting entity through `POST /api/accounting-entities`)
 * would make that group's whole router this suite's to reach. A suite that
 * lists `coverage` records only the routes under those prefixes; the other
 * routers' requests are still sent to both backends and compared, and their
 * routes are their own suite's to reach. A cross-area suite lists none: each
 * group it touches has a suite of its own.
 *
 * A test file in no suite, or in a suite without `coverage`, records every
 * route it mounts (the `--coverage` report of a worker's tests included).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

interface SuiteCoverage {
  workspace: string;
  tests: string[];
  coverage?: string[];
}

let suites: SuiteCoverage[] | null | undefined;

function loadSuites(): SuiteCoverage[] | null {
  if (suites !== undefined) return suites;
  try {
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const file = path.resolve(here, '../../../../../rust/conformance/suites.json');
    suites = (JSON.parse(readFileSync(file, 'utf8')) as { suites: SuiteCoverage[] }).suites;
  } catch {
    suites = null;
  }
  return suites;
}

/**
 * The route prefixes the suites of a test file must reach, or null when they
 * must reach every route it mounts.
 */
export function coveragePrefixes(file: string | undefined): string[] | null {
  const all = loadSuites();
  if (!file || !all) return null;
  const normalized = file.replaceAll('\\', '/');
  const own = all.filter((s) => s.tests.some((t) => normalized.endsWith(`${s.workspace}/${t}`)));
  if (own.length === 0 || own.some((s) => !s.coverage)) return null;
  return own.flatMap((s) => s.coverage ?? []);
}

/** Whether a route pattern is under one of the prefixes (whole path segments). */
export function inCoverage(route: string, prefixes: readonly string[] | null): boolean {
  return prefixes === null || prefixes.some((p) => route === p || route.startsWith(`${p}/`));
}
