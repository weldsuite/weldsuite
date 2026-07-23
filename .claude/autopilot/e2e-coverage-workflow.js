export const meta = {
  name: 'e2e-coverage-audit',
  description: 'Audit Playwright coverage per platform module, implement the gaps, verify specs parse',
  phases: [
    { title: 'Audit', detail: 'one agent per module — enumerate routes, compare to existing specs, report gaps' },
    { title: 'Implement', detail: 'one agent per module — write missing smoke/interaction/CRUD/form specs' },
    { title: 'Verify', detail: 'playwright --list + type-check; fix parse errors in new specs' },
  ],
}

const PLATFORM = 'apps/web/platform'
const E2E = `${PLATFORM}/e2e`

// Every navigable module + cross-cutting surface that ships in the SPA.
// `prefix` = URL/dir base; `routesDir`/`appDir` = where to enumerate from.
const MODULES = [
  { key: 'weldcrm',      smoke: 'specs/smoke/weldcrm.smoke.spec.ts' },
  { key: 'welddesk',     smoke: 'specs/smoke/welddesk.smoke.spec.ts' },
  { key: 'weldflow',     smoke: 'specs/smoke/weldflow.smoke.spec.ts' },
  { key: 'weldmail',     smoke: 'specs/smoke/weldmail.smoke.spec.ts' },
  { key: 'weldcommerce', smoke: 'specs/smoke/weldcommerce.smoke.spec.ts' },
  { key: 'weldbooks',    smoke: 'specs/smoke/weldbooks.smoke.spec.ts' },
  { key: 'weldconnect',  smoke: 'specs/smoke/weldconnect.smoke.spec.ts' },
  { key: 'weldstash',    smoke: 'specs/smoke/weldstash.smoke.spec.ts' },
  { key: 'welddrive',    smoke: 'specs/smoke/welddrive.smoke.spec.ts' },
  { key: 'weldcalendar', smoke: 'specs/smoke/weldcalendar.smoke.spec.ts' },
  { key: 'weldmeet',     smoke: 'specs/smoke/weldmeet.smoke.spec.ts' },
  { key: 'weldhost',     smoke: 'specs/smoke/weldhost.smoke.spec.ts' },
  { key: 'weldcall',     smoke: 'specs/smoke/weldcall.smoke.spec.ts' },
  { key: 'weldchat',     smoke: 'specs/smoke/weldchat.smoke.spec.ts' },
  { key: 'settings',     smoke: 'specs/smoke/settings.smoke.spec.ts' },
]

const GAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    module: { type: 'string' },
    allRoutes: { type: 'array', items: { type: 'string' }, description: 'Every navigable URL the module serves, resolved from src/routes (index → /mod, $id → note as dynamic).' },
    smokeCoveredRoutes: { type: 'array', items: { type: 'string' } },
    uncoveredRoutes: { type: 'array', items: { type: 'string' }, description: 'Static routes that exist but are NOT in the smoke spec.' },
    dynamicRoutes: { type: 'array', items: { type: 'string' }, description: '$id/detail routes needing a seeded entity to visit.' },
    existingSpecFiles: { type: 'array', items: { type: 'string' } },
    hasInteractionSpec: { type: 'boolean' },
    hasCrudSpec: { type: 'boolean' },
    seedableEntities: { type: 'array', items: { type: 'string' }, description: 'Entities the module exposes via EntityGrid/quick-add that test-fixtures can seed (for CRUD specs).' },
    untestedCtas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { page: { type: 'string' }, cta: { type: 'string' }, hasTestId: { type: 'boolean' } },
        required: ['page', 'cta', 'hasTestId'],
      },
    },
    recommendedSpecs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', description: 'Path relative to apps/web/platform, e.g. e2e/specs/weldchat/interactions.spec.ts' },
          kind: { type: 'string', enum: ['smoke-additions', 'interaction', 'crud', 'form'] },
          rationale: { type: 'string' },
        },
        required: ['file', 'kind', 'rationale'],
      },
    },
    coverageSummary: { type: 'string' },
  },
  required: ['module', 'allRoutes', 'uncoveredRoutes', 'hasInteractionSpec', 'recommendedSpecs', 'coverageSummary'],
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    module: { type: 'string' },
    filesCreated: { type: 'array', items: { type: 'string' } },
    filesModified: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'number' },
    crossCuttingRecommendations: { type: 'array', items: { type: 'string' }, description: 'Shared page-object / fixture / data-testid changes NOT applied (left for the orchestrator).' },
    notes: { type: 'string' },
  },
  required: ['module', 'filesCreated', 'filesModified', 'testsAdded', 'notes'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    listExitOk: { type: 'boolean' },
    totalTestsDiscovered: { type: 'number' },
    parseErrors: { type: 'array', items: { type: 'string' } },
    typeErrors: { type: 'array', items: { type: 'string' } },
    fixesApplied: { type: 'array', items: { type: 'string' } },
    finalStatus: { type: 'string' },
  },
  required: ['listExitOk', 'parseErrors', 'finalStatus'],
}

const CONVENTIONS = `
Repo conventions you MUST follow (study the existing files before writing):
- Working dir base is ${PLATFORM}. Specs live under ${E2E}.
- Import the extended test from the right relative depth: \`import { test, expect } from '../../fixtures'\` (specs are at e2e/specs/<module>/x.spec.ts).
- Smoke specs use \`smokeRoute(page, { path })\` from '../../helpers/smoke' and a \`for (const path of routes)\` loop. To add coverage, ADD the missing static routes to the existing \`routes\` array — keep it sorted, keep the describe block. Use \`expectedUrl\` regex only when the route redirects.
- Do NOT add $id/detail/new-with-required-data routes to smoke unless they render standalone without a seeded entity. Note them as dynamicRoutes instead.
- Interaction specs: navigate to a sub-page, assert primary CTA visible / triggers navigation. Prefer stable selectors in this order: getByTestId('page-header-action-<slug>') or other documented testids, then getByRole('button'/'link', { name: /.../i }). Avoid CSS class selectors.
- CRUD specs: gate with \`test.skip(!isTestFixturesConfigured(), ...)\` in beforeAll, \`api.reset()\` in afterEach, use EntityGridPage. Copy the shape of e2e/specs/weldcrm/companies-crud.spec.ts EXACTLY.
- The auto-applied consoleErrors fixture fails on unexpected console.error — don't add redundant error listeners.
- DO NOT edit shared files: e2e/fixtures.ts, e2e/helpers/*, e2e/pages/*, playwright.config.ts. If you need a shared helper or a new data-testid in shared chrome, return it in crossCuttingRecommendations instead of editing.
- You MAY add a data-testid to a component inside app/<module>/** if a CTA you're testing has no stable selector — but only within your own module's components, and prefer role/text selectors first.
- Every new spec must be runnable headless without network mocks: assert structural things (route loads, sidebar present, CTA visible/navigates), not data that requires a populated DB — except seed-gated CRUD specs.
- No console.log, no \`any\`, no @ts-ignore. TypeScript strict.
`

phase('Audit')
const results = await pipeline(
  MODULES,
  // Stage 1 — audit one module
  (m) => agent(
    `You are auditing Playwright E2E coverage for the WeldSuite platform module "${m.key}".

Working from ${PLATFORM}:
1. Enumerate EVERY navigable route the module serves by reading src/routes/${m.key}/** (resolve TanStack file routes: index.tsx → /${m.key}, foo/index.tsx → /${m.key}/foo, $id → dynamic). Also check src/routes/${m.key}.tsx if present.
2. Read the existing smoke spec at ${m.smoke} (if it exists) and extract its covered \`routes\` array.
3. Read existing interaction/CRUD/form specs at e2e/specs/${m.key}/** (list them).
4. Skim app/${m.key}/** page components to find primary CTAs (New/Create/Add buttons, form submits) and whether they carry a stable data-testid. Identify entities exposed via EntityGrid/quick-add that test-fixtures could seed.
5. Compute uncoveredRoutes = static routes that exist but are missing from the smoke array. List dynamicRoutes separately.
6. Recommend the minimal set of NEW or UPDATED spec files to reach full coverage: smoke-additions (uncovered static routes), an interaction spec if none exists, CRUD specs for seedable entities, form specs for forms with stable id selectors.

Be precise — paths must be real. Do not write any files in this step. Return the structured report.`,
    { label: `audit:${m.key}`, phase: 'Audit', agentType: 'frontend-platform', schema: GAP_SCHEMA }
  ),
  // Stage 2 — implement the gaps for that module (runs as soon as its audit completes)
  (gap, m) => {
    if (!gap) return null
    const hasWork =
      (gap.uncoveredRoutes && gap.uncoveredRoutes.length) ||
      (gap.recommendedSpecs && gap.recommendedSpecs.length) ||
      !gap.hasInteractionSpec
    if (!hasWork) return { module: m.key, filesCreated: [], filesModified: [], testsAdded: 0, notes: 'Already fully covered — no gaps.' }
    return agent(
      `Implement the missing Playwright coverage for the WeldSuite platform module "${m.key}".

Here is the coverage gap report from the audit:
${JSON.stringify(gap, null, 2)}

${CONVENTIONS}

Tasks:
1. For uncoveredRoutes: add them to the \`routes\` array in ${m.smoke} (create the smoke spec following the weldcrm.smoke.spec.ts shape if it doesn't exist). Only add routes that render standalone.
2. If hasInteractionSpec is false, create e2e/specs/${m.key}/interactions.spec.ts covering each sub-page's primary CTA (visible / navigates), modeled on an existing module's interactions.spec.ts.
3. Implement the recommendedSpecs that are sound (crud/form) where a seedable entity or stable-id form exists. Skip a recommendation if it can't be done with a stable selector — note why in \`notes\`.
4. Verify each file you write imports from the correct relative path and uses the shared \`test\`/\`expect\` from '../../fixtures'.

Write the files. Return exactly what you created/modified, the count of test cases added, and any cross-cutting recommendations you deliberately did NOT apply.`,
      { label: `impl:${m.key}`, phase: 'Implement', agentType: 'frontend-platform', schema: IMPL_SCHEMA }
    )
  }
)

const impls = results.filter(Boolean)
const created = impls.flatMap((r) => r.filesCreated || [])
const modified = impls.flatMap((r) => r.filesModified || [])
const totalAdded = impls.reduce((n, r) => n + (r.testsAdded || 0), 0)
log(`Implemented across ${impls.length} modules: +${totalAdded} test cases, ${created.length} new files, ${modified.length} modified.`)

phase('Verify')
const verify = await agent(
  `Verify the newly-written Playwright specs in ${PLATFORM} are valid and discoverable.

New files: ${JSON.stringify(created)}
Modified files: ${JSON.stringify(modified)}

Steps (run from ${PLATFORM}):
1. Run \`pnpm exec playwright test --list\` and capture the result. This confirms all specs parse and are discovered without needing a running server. Record the total test count and exit status.
2. If --list reports parse/TypeScript errors in any of the new/modified files above, OPEN those files and fix the errors (wrong import depth, missing import, type mistakes, bad selectors that don't compile). Re-run --list until it's clean OR you hit an error you can't safely fix (record it).
3. Do NOT try to actually execute the tests (no dev server / no Clerk creds here) — --list only.
4. Optionally run a quick \`pnpm exec tsc --noEmit -p tsconfig.json\` scoped sanity check only if --list passes but you suspect type issues; skip if noisy with pre-existing unrelated errors.

Report listExitOk, totalTestsDiscovered, any remaining parseErrors/typeErrors, the fixes you applied, and a one-line finalStatus.`,
  { label: 'verify', phase: 'Verify', agentType: 'frontend-platform', schema: VERIFY_SCHEMA }
)

return {
  modulesAudited: results.length,
  implemented: impls,
  testsAdded: totalAdded,
  filesCreated: created,
  filesModified: modified,
  verify,
  crossCutting: impls.flatMap((r) => r.crossCuttingRecommendations || []),
}
