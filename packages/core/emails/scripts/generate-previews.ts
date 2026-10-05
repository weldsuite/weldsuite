/**
 * Writes `emails/<template>/<preview>.<locale>.tsx` for every preview of every
 * registered template, for the React Email preview server. Run by `pnpm dev`;
 * the output is git-ignored.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMAIL_LOCALES } from '../src/i18n';
import { templates } from '../src/templates';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'emails');
rmSync(root, { recursive: true, force: true });

let count = 0;
for (const [id, template] of Object.entries(templates)) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  for (const preview of Object.keys(template.previews)) {
    for (const locale of EMAIL_LOCALES) {
      writeFileSync(
        join(dir, `${preview}.${locale}.tsx`),
        `import { previewEmail } from '../../src/preview';\n\nexport default previewEmail('${id}', '${preview}', '${locale}');\n`,
      );
      count += 1;
    }
  }
}
console.log(`Wrote ${count} previews to ${root}`);
