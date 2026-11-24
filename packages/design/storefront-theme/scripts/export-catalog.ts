/**
 * Writes what the backend needs of the theme (rust/modules/commerce/src/online_store):
 *
 * - rust/catalogs/storefront-sections.json: the section catalog drafts are
 *   validated against;
 * - rust/catalogs/storefront-default-site.json: the document a new online
 *   store starts from.
 *
 * Commit the output.
 *
 *   pnpm --filter @weldsuite/storefront-theme catalog:export
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogExport } from '../src/catalog';
import { defaultSiteDocument } from '../src/defaults';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogs = path.resolve(here, '../../../../rust/catalogs');
const files: [string, unknown][] = [
  ['storefront-sections.json', catalogExport()],
  ['storefront-default-site.json', defaultSiteDocument()],
];
for (const [name, value] of files) {
  const target = path.join(catalogs, name);
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), target)}`);
}
