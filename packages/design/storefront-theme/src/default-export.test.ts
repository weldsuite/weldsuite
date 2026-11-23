// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSiteDocument } from './defaults';

describe('default site export', () => {
  it('matches the document the backend gives new online stores', () => {
    const file = path.resolve(process.cwd(), '../../../rust/catalogs/storefront-default-site.json');
    // Run `pnpm --filter @weldsuite/storefront-theme catalog:export` when this fails.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(defaultSiteDocument())));
  });
});
