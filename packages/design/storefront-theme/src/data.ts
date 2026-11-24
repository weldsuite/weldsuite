/**
 * The theme's data alone: the site document types, the section catalog, the
 * presets, fonts and page templates. No React and no SDK, so the platform's
 * editor (a different TypeScript setup) imports this entry,
 * `@weldsuite/storefront-theme/catalog`, rather than the package root.
 */
export * from './types';
export * from './catalog';
export * from './defaults';
