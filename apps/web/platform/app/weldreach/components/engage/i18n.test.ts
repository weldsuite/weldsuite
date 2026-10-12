/**
 * The engage pages build their text from `t('reachEngage.…')` keys, and a
 * wrong path fails at runtime, not at compile time. This checks that every key
 * the sources use exists in English, that Dutch has exactly the same keys, and
 * that both use the same `{placeholders}`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';

const WELDREACH_DIR = join(__dirname, '..', '..');
const SOURCE_DIRS = ['campaigns', 'prospects', 'inbox', join('components', 'engage')];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function usedKeys(): Map<string, string> {
  const used = new Map<string, string>();
  for (const dir of SOURCE_DIRS) {
    for (const file of sourceFiles(join(WELDREACH_DIR, dir))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/['"`](reachEngage\.[A-Za-z0-9_.]+)['"`]/g)) {
        const key = match[1];
        if (key && !used.has(key)) used.set(key, file);
      }
    }
  }
  return used;
}

/** Leaf paths of a nested translation object, with their text. */
function leaves(node: unknown, prefix: string, into: Map<string, string>): Map<string, string> {
  if (typeof node === 'string') {
    into.set(prefix, node);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) leaves(value, `${prefix}.${key}`, into);
  }
  return into;
}

const enLeaves = leaves(en.reachEngage, 'reachEngage', new Map());
const nlLeaves = leaves(nl.reachEngage, 'reachEngage', new Map());

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
}

describe('reachEngage translations', () => {
  it('has every key the pages use', () => {
    const used = usedKeys();
    // Guards the scan itself: finding nothing would make the check below pass for no reason.
    expect(used.size).toBeGreaterThan(100);
    const missing = [...used].filter(([key]) => !enLeaves.has(key)).map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });

  it('has the same keys in English and Dutch', () => {
    expect([...nlLeaves.keys()].sort()).toEqual([...enLeaves.keys()].sort());
  });

  it('uses the same placeholders in English and Dutch', () => {
    const mismatched = [...enLeaves]
      .filter(([key, text]) => placeholders(text).join() !== placeholders(nlLeaves.get(key) ?? '').join())
      .map(([key]) => key);
    expect(mismatched).toEqual([]);
  });

  it('leaves no translation empty', () => {
    const empty = [...enLeaves, ...nlLeaves].filter(([, text]) => text.trim() === '').map(([key]) => key);
    expect(empty).toEqual([]);
  });
});
