#!/usr/bin/env node
// Copy the compiled Storybook Tailwind/token CSS to a stable, PKG_DIR-bounded
// path for cfg.cssEntry.
//
// Why this is needed: @weldsuite/ui styles entirely via Tailwind v4 utilities +
// oklch token vars, which only exist in COMPILED form. The converter's
// storybook-CSS scrape reads <link> tags from iframe.html, but Storybook 8 + Vite
// inject the preview CSS via JS (no <link>), so the scrape finds nothing. The
// compiled CSS is emitted to sb-reference/assets/preview-<hash>.css (hash varies
// per build). This copies the largest such file to packages/design/ui/.ds-styles.css
// (cfg.cssEntry is bounded to PKG_DIR). The DS font is the system stack — the
// CSS has no url() assets — so a plain copy is complete.
//
// Run AFTER the storybook build, BEFORE the converter (the design-sync buildCmd does this).
import { existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const ASSETS = '.design-sync/sb-reference/assets';
const DEST = 'packages/design/ui/.ds-styles.css';

if (!existsSync(ASSETS)) {
  console.error(`cp-sb-css: ${ASSETS} not found — build the reference storybook first`);
  process.exit(1);
}
const candidates = readdirSync(ASSETS)
  .filter((f) => /^preview-.*\.css$/.test(f))
  .map((f) => ({ f, size: statSync(join(ASSETS, f)).size }))
  .sort((a, b) => b.size - a.size);
if (!candidates.length) {
  console.error(`cp-sb-css: no preview-*.css under ${ASSETS}`);
  process.exit(1);
}
const pick = candidates[0];
copyFileSync(join(ASSETS, pick.f), DEST);
console.error(`cp-sb-css: ${pick.f} (${(pick.size / 1024).toFixed(0)} KB) → ${DEST}`);
