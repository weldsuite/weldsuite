// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogExport, SECTION_CATALOG } from './catalog';
import { defaultSiteDocument, PAGE_TEMPLATES } from './defaults';
import { GROUP_NAMES, SECTION_ID, TEMPLATE_NAMES } from './types';

describe('section catalog', () => {
  it('matches the export the backend validates against', () => {
    const file = path.resolve(process.cwd(), '../../../rust/catalogs/storefront-sections.json');
    const committed = JSON.parse(readFileSync(file, 'utf8'));
    // Run `pnpm --filter @weldsuite/storefront-theme catalog:export` when this fails.
    expect(committed).toEqual(JSON.parse(JSON.stringify(catalogExport())));
  });

  it('gives every select a default among its options', () => {
    for (const [type, definition] of Object.entries(SECTION_CATALOG)) {
      const settings = [...definition.settings, ...Object.values(definition.blocks).flatMap((b) => b.settings)];
      for (const setting of settings) {
        if (setting.type === 'select') {
          expect(setting.options?.map((o) => o.value), `${type}.${setting.id}`).toContain(setting.default);
        }
      }
    }
  });

  it('starts new shops with every required section once', () => {
    const doc = defaultSiteDocument();
    for (const [type, definition] of Object.entries(SECTION_CATALOG)) {
      for (const list of definition.required) {
        const sections = (TEMPLATE_NAMES as readonly string[]).includes(list)
          ? doc.templates[list as (typeof TEMPLATE_NAMES)[number]]
          : doc.groups[list as (typeof GROUP_NAMES)[number]];
        expect(sections.filter((s) => s.type === type), `${type} in ${list}`).toHaveLength(1);
      }
    }
    const lists = [...Object.values(doc.templates), ...Object.values(doc.groups)];
    for (const list of lists) {
      for (const section of list) expect(section.id).toMatch(SECTION_ID);
    }
  });

  it('builds page templates from content sections only', () => {
    for (const template of PAGE_TEMPLATES) {
      for (const section of template.sections()) {
        expect(SECTION_CATALOG[section.type]?.where, `${template.id}: ${section.type}`).toContain('content');
      }
    }
  });
});
