/**
 * Sonar's JavaScript/TypeScript rules, run as plain ESLint over the whole
 * monorepo. This replaced the SonarQube Cloud scan, which built a TypeScript
 * program per workspace and ran out of memory on the CI runner.
 *
 *   pnpm lint:sonar [paths…]   every finding in the given paths (default: all)
 *   pnpm lint:sonar:new        only the findings your branch adds; what CI runs
 *                              (scripts/lint-sonar-new.mjs)
 *
 * Separate from the per-workspace `pnpm lint`: most workers and packages have
 * no ESLint setup at all, and Sonar always covered the whole tree. Rules run
 * without type information, so the handful that need it stay silent.
 */
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

const CODE = '{js,jsx,mjs,cjs,ts,tsx,mts,cts}';
const SOURCES = [`apps/**/*.${CODE}`, `packages/**/*.${CODE}`, `scripts/**/*.${CODE}`];
const TESTS = [`**/*.{test,spec}.${CODE}`, `**/__tests__/**/*.${CODE}`, `**/e2e/**/*.${CODE}`];

// Sonar runs these rules (scope "Tests") on test files only, and every other
// rule on non-test files only. The plugin does not export a rule's scope, so
// this list is copied from its rule metadata (eslint-plugin-sonarjs 4.2.2).
const TEST_RULES = new Set([
  'assertions-in-test-cases',
  'assertions-in-tests',
  'async-test-assertions',
  'chai-determinate-assertion',
  'composite-assertions',
  'disabled-timeout',
  'explicit-test-skip',
  'hooks-before-test-cases',
  'inverted-assertion-arguments',
  'no-code-after-done',
  'no-debug-commands-in-ui-tests',
  'no-duplicate-parameterized-test-case',
  'no-duplicate-test-title',
  'no-empty-parameterized-test-dataset',
  'no-empty-test-file',
  'no-empty-test-title',
  'no-exclusive-tests',
  'no-fixed-wait-in-tests',
  'no-forced-browser-interaction',
  'no-incompatible-assertion-types',
  'no-incomplete-assertions',
  'no-interpolation-in-inline-snapshots',
  'no-mixed-completion-style',
  'no-networkidle-wait',
  'no-same-argument-assert',
  'no-skipped-tests',
  'no-trivial-assertions',
  'parameterized-tests',
  'prefer-cypress-should',
  'prefer-specific-assertions',
  'stable-tests',
  'synchronous-exception-assertions',
  'synchronous-suite-callback',
  'test-check-exception',
  'testing-library-prefer-query-by-disappearance',
  'testing-library-query-assertion',
  'vitest-mock-at-module-scope',
].map(rule => `sonarjs/${rule}`));

const recommended = Object.entries(sonarjs.configs.recommended.rules);
const mainRules = Object.fromEntries(recommended.filter(([rule]) => !TEST_RULES.has(rule)));
const testRules = Object.fromEntries(recommended.filter(([rule]) => TEST_RULES.has(rule)));

// The code carries eslint-disable comments for rules of the workspace configs.
// This config does not run those plugins, but ESLint reports a directive that
// names a rule it has no definition for, so give each namespace a stand-in
// whose every rule does nothing.
const noopRule = { meta: { schema: false }, create: () => ({}) };
const standIn = { rules: new Proxy({}, { get: () => noopRule }) };
const DIRECTIVE_NAMESPACES = ['@next/next', '@typescript-eslint', 'react-hooks'];

// Reviewed, intentional findings, carried over from the SonarQube Cloud
// cleanup (2026-10). Each entry turns ONE rule off for the files listed, for
// the reason given; the rule stays on everywhere else. When a file is
// refactored so the pattern goes away, drop it from its list. (Exceptions for
// Sonar rules this plugin does not have were not carried over.)
const REVIEWED = [
  {
    rule: 'sonarjs/todo-tag',
    reason: 'TODOs that record real missing work (unbuilt endpoints, product decisions); tracked, not dead comments.',
    files: [
      'apps/mobile/weldcrm-app/app/(tabs)/customers.tsx',
      'apps/mobile/weldcrm-app/app/customer/[id].tsx',
      'apps/web/platform/app/settings/integrations/[id]/integration-detail-client.tsx',
      'apps/web/platform/app/weldcrm/task-dialog.tsx',
      'apps/web/platform/app/welddesk/changelog/[id]/changelog-editor-client.tsx',
      'apps/web/platform/app/welddesk/help/server-help-articles-data-table.tsx',
      'apps/web/platform/app/welddesk/inbox/all/[conversationId]/conversation-detail-client.tsx',
      'apps/web/platform/app/welddesk/knowledge/[id]/article-viewer.tsx',
      'apps/web/platform/app/weldflow/hooks/use-projects-sidebar-items.tsx',
      'apps/web/platform/app/weldflow/project/[projectId]/layout.tsx',
      'apps/web/platform/app/weldmail/hooks/use-mail-sidebar-items.tsx',
      'apps/web/platform/app/weldmail/inbox/inbox-client.tsx',
      'apps/web/platform/components/objects/task/task-panel.tsx',
      'apps/web/platform/hooks/queries/use-app-settings-queries.ts',
      'apps/workers/crm-api/src/routes/leads/index.ts',
      'apps/workers/mail-api/src/services/mail/accounts.ts',
      'packages/core/db/src/lib/admin.ts',
      'packages/core/db/src/lib/auth.ts',
      'packages/core/db/src/lib/tenant.ts',
      'packages/domains/crm/src/workflows/execute-sequence.ts',
      'packages/domains/crm/src/workflows/execute-workflow/action-handlers.ts',
    ],
  },
  {
    rule: 'sonarjs/no-os-command-from-path',
    reason: 'Dev/CI scripts that intentionally resolve tools from PATH.',
    files: [
      'apps/web/docs/scripts/capture-screenshots-all.mjs',
      'scripts/dev-api.mjs',
      'scripts/lint-sonar-new.mjs',
      'scripts/rust-conformance.ts',
      'packages/sdk/cli/src/commands/dev.ts',
    ],
  },
  {
    rule: 'sonarjs/redundant-type-aliases',
    reason: 'Documented any/driver-type aliases that are part of a public API.',
    files: [
      'apps/mobile/weldmail-app/components/EmailDetailPanel.tsx',
      'packages/core/credits/src/gateway-costs.ts',
      'packages/core/credits/src/index.ts',
    ],
  },
  {
    rule: 'sonarjs/no-clear-text-protocols',
    reason: 'XML/XBRL namespace and scheme URIs in Digipoort, XAF, BTW and ICP documents, not network requests.',
    files: [
      'apps/workers/books-api/src/services/accounting-digipoort.ts',
      'apps/workers/books-api/src/services/accounting-icp-xml.ts',
      'apps/workers/books-api/src/services/accounting-xaf.ts',
      'packages/domains/books/src/accounting-vat-xml.ts',
      'packages/domains/books/src/jurisdictions/nl/taxonomy.ts',
    ],
  },
  {
    rule: 'sonarjs/no-small-switch',
    reason: 'Single-provider switch kept on purpose as the explicit seam for further gateway providers.',
    files: ['packages/core/ai/src/config.ts'],
  },
  {
    rule: 'sonarjs/no-hardcoded-ip',
    reason: 'Dotted chart-of-accounts codes such as 1.1.4.10 (Brazilian plano de contas), not IP addresses.',
    files: ['packages/domains/books/src/jurisdictions/br/chart-of-accounts.ts'],
  },
  {
    rule: 'sonarjs/hashing',
    reason:
      "MD5 used as an HTTP ETag/content checksum in the in-memory R2 test fake, matching real R2's own (also MD5-based) etag format — not a password, token or any other sensitive use.",
    files: ['packages/core/worker-kit/src/testing/r2.ts'],
  },
  {
    rule: 'sonarjs/redundant-type-aliases',
    reason:
      "`FolderKey` (object-derived folder/thread-label keys) is open-ended — system keys plus any lower-cased user label — so there is no narrower literal union to give it; the alias is documented self-description, not a safety boundary.",
    files: ['packages/domains/mail/src/store/model.ts', 'packages/domains/mail/src/store/types.ts'],
  },
];

// Paths are literal file names; brackets and parentheses in route folders
// ([id], (tabs)) would otherwise be read as glob syntax.
const literal = file => file.replace(/[[\]()*?{}!+@]/g, '\\$&');

export default [
  {
    ignores: [
      // Only apps/, packages/ and scripts/ are analysed, as under Sonar.
      '*',
      '!apps/',
      '!packages/',
      '!scripts/',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/.wrangler/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/*.min.js',
      '**/*.gen.ts',
      '**/public/**',
      '**/.tanstack/**',
      'packages/core/db/drizzle/**',
      'graphify-out/**',
      '**/ios/**',
      '**/android/**',
    ],
  },
  {
    files: SOURCES,
    plugins: {
      sonarjs,
      ...Object.fromEntries(DIRECTIVE_NAMESPACES.map(namespace => [namespace, standIn])),
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    // The stand-ins never report, so every directive naming one would read
    // as unused.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    settings: { react: { version: '19' } },
  },
  { files: SOURCES, ignores: TESTS, rules: mainRules },
  { files: TESTS, rules: testRules },
  // Locale files: S2068 keys on property names containing "password", which
  // there are UI labels (passwordLabel: 'Wachtwoord'), never credentials. The
  // shared mobile login copy is the same kind of catalog.
  {
    files: ['**/locales/**', 'packages/design/mobile-ui/src/constants/login-copy.ts'],
    rules: { 'sonarjs/no-hardcoded-passwords': 'off' },
  },
  ...REVIEWED.map(({ rule, files }) => ({ files: files.map(literal), rules: { [rule]: 'off' } })),
];
