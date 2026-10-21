// @vitest-environment node
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SLUG_REGEX,
  isReservedWorkspaceSlug,
  workspaceSlugSchema,
} from '@weldsuite/app-api-client/schemas/workspace-slug';

/**
 * A workspace slug sits at the root of platform URLs (`/{slug}/weldcrm/…`), so
 * no workspace may use a word the platform itself has at the root. This test
 * reads the route folder and `public/`, so a new module or static folder
 * can't ship without being reserved.
 */

const ROUTES_DIR = fileURLToPath(new URL('../src/routes', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

/** First URL segments of the file routes. Pathless groups (`_layout`, `(group)`) are looked through. */
function topLevelRouteSegments(dir: string): string[] {
  const segments: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.isDirectory() ? entry.name : entry.name.replace(/\.(tsx?|jsx?)$/, '');
    if (name.startsWith('_') || name.startsWith('(')) {
      if (entry.isDirectory()) segments.push(...topLevelRouteSegments(`${dir}/${entry.name}`));
      continue; // __root, pathless layout files
    }
    if (name === 'index' || name.startsWith('$')) continue;
    segments.push(name.split('.')[0]);
  }
  return segments;
}

/** Only names a slug could take: `w9`, `favicon.ico` and the like never can. */
const couldBeASlug = (name: string) => SLUG_REGEX.test(name);

describe('reserved workspace slugs', () => {
  it('reserves every top-level platform route', () => {
    const segments = topLevelRouteSegments(ROUTES_DIR).filter(couldBeASlug);
    expect(segments.length).toBeGreaterThan(20);
    expect(segments.filter((s) => !isReservedWorkspaceSlug(s))).toEqual([]);
  });

  it('reserves every entry at the root of public/', () => {
    const names = readdirSync(PUBLIC_DIR).filter(couldBeASlug);
    expect(names.filter((n) => !isReservedWorkspaceSlug(n))).toEqual([]);
  });

  it('accepts other slugs, including ones that start with weld', () => {
    for (const slug of ['acme', 'weldon', 'weld-masters', 'settings-team']) {
      expect(workspaceSlugSchema.safeParse(slug).success).toBe(true);
    }
  });

  it('rejects reserved names and bad formats', () => {
    for (const slug of ['settings', 'weldcrm', 'call-room', 'assets', 'www', 'Acme', 'ab', 'acme-']) {
      expect(workspaceSlugSchema.safeParse(slug).success).toBe(false);
    }
  });
});
