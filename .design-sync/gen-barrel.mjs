#!/usr/bin/env node
// design-sync barrel generator for @weldsuite/ui.
//
// @weldsuite/ui has NO build/dist and NO barrel — it exports TS source directly
// via subpath exports (./components/*). The design-sync storybook shape requires
// a real --entry (no synth fallback), so this script synthesizes one: it scans
// the Storybook stories for every `@weldsuite/ui/<sub>` specifier they import and
// emits a barrel that re-exports each resolved source module. The result backs
// window.WeldSuiteUI, scoped to exactly what the storied components need.
//
// Output (gitignored): packages/design/ui/.ds-entry.ts  — must live INSIDE packages/design/ui
// so the converter's PKG_DIR walk-up finds packages/design/ui/package.json.
//
// Run from the repo root (the design-sync buildCmd does this before each build).
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UI_ROOT = 'packages/design/ui';
const STORIES = 'apps/tools/storybook/src/stories';

// Excluded modules: workflow-canvas pulls @xyflow/react/dist/style.css into the
// JS bundle. That stray CSS makes the converter think _ds_bundle.css is the DS
// stylesheet and SUPPRESSES the storybook Tailwind/token CSS scrape (every
// preview then renders unstyled). It also fails to compile its preview on
// Windows (directory-import read error). Excluding it lets the scrape fire and
// drops a component that wouldn't render anyway. Mirror in cfg.titleMap (null).
const EXCLUDE = new Set(['@weldsuite/ui/components/workflow-canvas']);

const raw = execSync(`grep -rhoE "@weldsuite/ui/[a-zA-Z0-9/_-]+" ${STORIES}`, { encoding: 'utf8' });
const specs = [...new Set(raw.split('\n').map((s) => s.trim()).filter(Boolean))].filter((s) => !EXCLUDE.has(s)).sort();

const lines = [];
const missing = [];
for (const spec of specs) {
  const sub = spec.replace('@weldsuite/ui/', ''); // components/button | lib/utils
  const candidates = [`src/${sub}.tsx`, `src/${sub}.ts`, `src/${sub}/index.tsx`, `src/${sub}/index.ts`];
  const hit = candidates.find((c) => existsSync(join(UI_ROOT, c)));
  if (!hit) { missing.push(spec); continue; }
  lines.push(`export * from ${JSON.stringify('./' + hit.replace(/\.(tsx?|jsx?)$/, ''))};`);
}

const body = lines.join('\n') + '\n';
const header =
  '// AUTO-GENERATED design-sync barrel for @weldsuite/ui.\n' +
  '// Re-exports every story-imported module so the converter can build window.WeldSuiteUI.\n' +
  '// Regenerate via `node .design-sync/gen-barrel.mjs`; gitignored.\n';

// (1) esbuild bundle entry (cfg.entry) — builds window.WeldSuiteUI.
writeFileSync(join(UI_ROOT, '.ds-entry.ts'), header + body);

// (2) ts-morph type entry. @weldsuite/ui ships no .d.ts, so findTypesRoot()
// falls back to PKG_DIR and projectFor() reads `<pkg>/index.d.ts`. This barrel
// makes exportedNames() (the storybook public-export gate) and the per-component
// prop extraction follow `export *` into the real source .tsx files.
writeFileSync(join(UI_ROOT, 'index.d.ts'), header + body);

console.error(`gen-barrel: ${lines.length} re-exports → ${UI_ROOT}/.ds-entry.ts + ${UI_ROOT}/index.d.ts`);
if (missing.length) console.error('gen-barrel: UNRESOLVED:', missing.join(', '));
