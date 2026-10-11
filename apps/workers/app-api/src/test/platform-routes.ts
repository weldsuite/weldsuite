/**
 * The platform SPA's navigable paths, read from its generated TanStack Router
 * tree, for tests that pin the URLs app-api hands to the platform (search
 * results, drive files).
 *
 * Splat routes are left out: `/welddesk/$` matches anything and redirects to
 * the inbox, so a link that only lands there has lost its record.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const routeTreeFile = path.resolve(here, '../../../../web/platform/src/routeTree.gen.ts');

let routes: string[][] | undefined;

function segments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

function platformRoutes(): string[][] {
  if (routes) return routes;
  const source = fs.readFileSync(routeTreeFile, 'utf8');
  const start = source.indexOf('export interface FileRoutesByTo {');
  if (start < 0) throw new Error(`FileRoutesByTo not found in ${routeTreeFile}`);
  const block = source.slice(start, source.indexOf('\n}', start));
  routes = block
    .split('\n')
    .map((line) => /^ {2}'([^']+)':/.exec(line)?.[1])
    .filter((route): route is string => route !== undefined)
    .map(segments)
    .filter((route) => !route.includes('$'));
  return routes;
}

/** Whether `url` (a path, optionally with a query) lands on a platform route. */
export function isPlatformRoute(url: string): boolean {
  const target = segments(new URL(url, 'https://platform.test').pathname);
  return platformRoutes().some(
    (route) =>
      route.length === target.length &&
      route.every((segment, i) => segment === target[i] || segment.startsWith('$')),
  );
}
