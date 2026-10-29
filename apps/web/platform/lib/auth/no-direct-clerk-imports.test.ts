/**
 * SEC-012 / P4 4.F1: only the auth facade imports Clerk. ESLint flags it too
 * (`no-restricted-imports` in eslint.config.js), but the shared config turns
 * every rule into a warning, so this test is what blocks CI. Test files may
 * still `vi.mock('@clerk/clerk-react')`: the facade's Clerk implementation
 * calls those hooks.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const PLATFORM = join(__dirname, '..', '..');
const ROOTS = ['app', 'components', 'contexts', 'hooks', 'lib', 'providers', 'src'];
const FACADE = join(PLATFORM, 'lib', 'auth') + sep;
const CLERK_IMPORT = /(?:from|import)\s*\(?\s*['"]@clerk\//;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') sources(path, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

describe('auth facade boundary', () => {
  it('has no @clerk/* import outside lib/auth', () => {
    const offenders = ROOTS.flatMap((root) => sources(join(PLATFORM, root)))
      .filter((file) => !file.startsWith(FACADE))
      .filter((file) => CLERK_IMPORT.test(readFileSync(file, 'utf8')))
      .map((file) => relative(PLATFORM, file));
    expect(offenders).toEqual([]);
  });
});
