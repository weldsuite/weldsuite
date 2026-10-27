import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Record<string, string> {
  return Object.assign(
    {},
    ...Object.entries(tree).map(([key, value]) =>
      typeof value === 'string' ? { [`${prefix}${key}`]: value } : flatten(value, `${prefix}${key}.`),
    ),
  );
}

const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join(',');

describe.each([
  ['weldpanel', en.weldpanel as Tree, nl.weldpanel as Tree],
  ['navigation.moduleSidebar.weldpanel', en.navigation.moduleSidebar.weldpanel as Tree, nl.navigation.moduleSidebar.weldpanel as Tree],
])('%s strings', (_name, english, dutch) => {
  const a = flatten(english);
  const b = flatten(dutch);

  it('exist in both en and nl', () => {
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
  });

  it('are filled in, in both languages', () => {
    for (const [key, value] of [...Object.entries(a), ...Object.entries(b)]) expect([key, value.trim() !== '']).toEqual([key, true]);
  });

  it('use the same {placeholders} in both languages', () => {
    for (const key of Object.keys(a)) expect([key, placeholders(b[key] ?? '')]).toEqual([key, placeholders(a[key]!)]);
  });
});
