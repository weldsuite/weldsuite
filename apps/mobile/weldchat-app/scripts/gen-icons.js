/**
 * @deprecated Use `scripts/generate-assets.mjs` instead (same pattern as
 * WeldBooks / WeldAgent). This script produced the old pale-blue launcher
 * tiles; the shared asset set is now white store icons + transparent
 * splash/logo/adaptive marks from the platform SVG.
 *
 *   node scripts/generate-assets.mjs assets/images
 */
console.error(
  'gen-icons.js is retired. Run:\n  node scripts/generate-assets.mjs assets/images\n',
);
process.exit(1);
