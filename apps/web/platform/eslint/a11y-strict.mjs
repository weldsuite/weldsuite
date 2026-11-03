import a11yPlugin from './a11y-plugin.mjs';

/**
 * Folders whose accessibility pass is done (TASK-1184, one PR per module).
 * They get the weldsuite-a11y rules and jsx-a11y's component mapping, and
 * eslint/a11y-strict.test.ts fails on any finding in them. Add a module here
 * in the PR that cleans it up.
 */
export const A11Y_STRICT_FOLDERS = ['app/weldmail'];

/** Rule ids that count as accessibility findings in a strict folder. */
export const A11Y_RULE_PREFIXES = ['jsx-a11y/', 'weldsuite-a11y/'];

/** The ESLint config block for the strict folders. */
export const a11yStrictConfig = {
  files: A11Y_STRICT_FOLDERS.map((folder) => `${folder}/**/*.{ts,tsx}`),
  plugins: { 'weldsuite-a11y': a11yPlugin },
  settings: {
    // Lets jsx-a11y's click/keyboard rules see our table rows and cards.
    'jsx-a11y': {
      components: { TableRow: 'tr', TableCell: 'td', Card: 'div', CardContent: 'div' },
    },
  },
  rules: {
    'weldsuite-a11y/icon-button-has-name': 'error',
    'weldsuite-a11y/field-has-name': 'error',
    'weldsuite-a11y/outline-none-has-focus-style': 'error',
    'weldsuite-a11y/dialog-has-title': 'error',
  },
};
