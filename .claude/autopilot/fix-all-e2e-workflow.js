export const meta = {
  name: 'fix-all-e2e',
  description: 'Run every platform e2e spec serially, fix failures with code-only agents, re-verify',
  phases: [
    { title: 'Baseline', detail: 'serial — run each spec group, capture failing tests + errors (no parallel Playwright)' },
    { title: 'Fix', detail: 'parallel — one code-only agent per failing spec file, apply the fix playbook' },
    { title: 'Shared', detail: 'apply cross-cutting fixes (console-error ignores, shared component testids)' },
    { title: 'Verify', detail: 'serial — re-run the touched groups, report remaining failures' },
  ],
}

const PLATFORM = 'apps/web/platform'

// Spec groups (already-green top-level specs excluded: agents, appstore,
// breadcrumbs, command-palette, dashboard, navigation, header-toggles,
// drawers, redirects). Each unit is one `playwright test` target, run with
// --workers=1 for determinism + to avoid CRUD reset races within a group.
const GROUPS = [
  'e2e/specs/notifications-panel.spec.ts',
  'e2e/specs/visual.spec.ts',
  'e2e/specs/unauth',
  // smoke split so each run is bounded
  'e2e/specs/smoke/weldcrm.smoke.spec.ts e2e/specs/smoke/welddesk.smoke.spec.ts e2e/specs/smoke/weldflow.smoke.spec.ts',
  'e2e/specs/smoke/weldmail.smoke.spec.ts e2e/specs/smoke/weldcommerce.smoke.spec.ts e2e/specs/smoke/weldbooks.smoke.spec.ts',
  'e2e/specs/smoke/weldconnect.smoke.spec.ts e2e/specs/smoke/weldstash.smoke.spec.ts e2e/specs/smoke/welddrive.smoke.spec.ts',
  'e2e/specs/smoke/weldcalendar.smoke.spec.ts e2e/specs/smoke/weldmeet.smoke.spec.ts e2e/specs/smoke/weldhost.smoke.spec.ts',
  'e2e/specs/smoke/weldcall.smoke.spec.ts e2e/specs/smoke/weldchat.smoke.spec.ts e2e/specs/smoke/settings.smoke.spec.ts e2e/specs/smoke/system-pages.smoke.spec.ts',
  'e2e/specs/settings',
  'e2e/specs/weldcrm',
  'e2e/specs/welddesk',
  'e2e/specs/weldflow',
  'e2e/specs/weldmail',
  'e2e/specs/weldcommerce',
  'e2e/specs/weldconnect',
  'e2e/specs/weldstash',
  'e2e/specs/welddrive',
  'e2e/specs/weldcalendar',
  'e2e/specs/weldmeet',
  'e2e/specs/weldhost',
  'e2e/specs/weldcall',
  'e2e/specs/weldchat',
  'e2e/specs/weldbooks',
]

const FAILURES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    group: { type: 'string' },
    ranOk: { type: 'boolean' },
    summary: { type: 'string', description: 'e.g. "12 passed, 3 failed, 2 skipped"' },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          specFile: { type: 'string', description: 'path relative to apps/web/platform, e.g. e2e/specs/weldcrm/lists.spec.ts' },
          testTitle: { type: 'string' },
          errorExcerpt: { type: 'string', description: 'the key error line(s): locator/assertion + received value, console error text, or timeout' },
        },
        required: ['specFile', 'testTitle', 'errorExcerpt'],
      },
    },
  },
  required: ['group', 'ranOk', 'failures'],
}

const PLAYBOOK = `
FIX PLAYBOOK — these are the failure classes seen this session and how to fix each. Diagnose from the error + by READING the spec file and the app component/route it targets. You CANNOT run Playwright (the suite is run serially elsewhere to avoid env races), so reason from code.

Decide per failure: is the TEST wrong, or the IMPLEMENTATION? "If the test is correct, fix the implementation." Never weaken a test just to make it pass.

1. testid "X" not found / element not visible:
   - The testid may live in DEAD code (a component never imported/rendered). Find the REAL rendered component (grep who imports/renders it) and put the testid there.
   - Or the test targets a route/page where that element doesn't render (e.g. the WeldAgent home '/' has its own header WITHOUT the command palette / module sidebar; module routes use AppHeader). Retarget the test to a route that actually renders the element (a module route like /weldcrm/companies).
   - Real rail testids: the universal icon rail is components/app-sidebar-client.tsx (carries data-testid="app-sidebar" + app-nav-<appCode>). The module sidebar app-sidebar-layout.tsx is conditional.

2. app-nav-<legacyKey> (helpdesk/crm/commerce/projects/task/host): use the BRANDED app code — app-nav-welddesk, app-nav-weldcrm, app-nav-weldcommerce, app-nav-weldflow, app-nav-weldconnect, app-nav-weldhost, app-nav-weldmail, app-nav-weldstash. (home + appstore stay as-is.)

3. Racy check: an instant \`locator.isVisible()\` right after page.goto false-negatives before first paint. Replace with \`await expect(locator).toBeVisible({ timeout: 10_000 })\`. Same for skip-guards that use isVisible().

4. toHaveURL / redirect mismatch: check the route file (src/routes/...). If it redirects, either set the spec's expectedUrl to the real target, or fix the redirect to preserve intent (e.g. /weldcrm/customers must redirect with search { filter: 'customers' }). If the page legitimately stays, fix the spec's expected regex.

5. consoleErrors fixture failure ("Unexpected console errors"):
   - If it's a genuinely malformed call (e.g. a doubled "/api/api/" path), fix the CALLER (a domain client path that hard-codes /api when the client already prepends it).
   - If it's background app-shell noise from services not running locally (presence, notifications, realtime websocket, integration probes, missing static asset 404/401/403), it belongs in e2e/helpers/console-errors.ts IGNORE_PATTERNS — but that's a SHARED file: do NOT edit it; return the exact regex(es) needed in crossCutting.
   - A React duplicate-key warning or "Cannot update a component while rendering a different component" is a REAL bug: fix the component (key by index; move setState into useEffect).

6. Heading/structure assumptions: if a test asserts an h1/h2 the page doesn't have (EntityList pages use breadcrumb + toolbar, no heading), assert the page's real defining element instead (its primary CTA / a stable testid).

7. Seed/CRUD specs: the test workspace IS provisioned now (apps installed, TEST_USER_ID has app assignments, TEST_FIXTURES_TOKEN live, 22 seed endpoints exist incl. company/person/lead/list/pipeline/project/task/opportunity/activity/sequence/ticket/meeting/domain/mailAccount/mailLabel/product/order/workflow/webhook/execution/weldstash-*/calendarEvent/bookingPage/voipCall/customFieldDefinition/objectTemplate/customerStatus). If a CRUD/form spec fails on a SELECTOR, read the actual component and fix the selector to match the real DOM. If it depends on a seed method that genuinely does NOT exist on the test-fixtures client, keep it gated (describe.fixme with a clear reason) rather than fabricating.

8. Preserve: workspaceId scoping, permission checks, Zod validation, no \`any\`/@ts-ignore, no console.log. Match the surrounding spec style. Keep edits MINIMAL and scoped to the failing spec file + (only if clearly the cause) the single module component/route it targets.

SHARED FILES — do NOT edit these directly (parallel agents would clobber each other); instead return precise instructions in crossCutting:
- e2e/helpers/console-errors.ts (IGNORE_PATTERNS)
- e2e/helpers/*, e2e/fixtures.ts, e2e/pages/*, playwright.config.ts, e2e/global-setup.ts, .env.test
- components/app-sidebar-client.tsx, components/breadcrumb-header.tsx, components/layout/app-header*.tsx (shared chrome)
- any packages/* file
`

phase('Baseline')
log(`Baseline: running ${GROUPS.length} spec groups serially (no parallel Playwright).`)
const baselines = []
for (const group of GROUPS) {
  const r = await agent(
    `Run a baseline of these platform e2e specs and report failures. Working dir: ${PLATFORM}.

Run EXACTLY: \`npx playwright test ${group} --project=chromium --workers=1 --reporter=line\`
(Use a 600000ms timeout. --workers=1 avoids CRUD-reset races. The suite auth + app provisioning happen automatically via global-setup/auth.setup; .env.test is configured.)

Parse the output. For EVERY failing test, capture: the spec file path (relative to ${PLATFORM}), the test title, and the key error excerpt (the locator/assertion + received value, the console-error text, or the timeout line). Skipped tests are NOT failures. If the run itself errors (can't start), set ranOk=false and explain in summary.

Do NOT fix anything. Return the structured failure list for this group.`,
    { label: `baseline:${group.split('/').slice(-1)[0].slice(0, 24)}`, phase: 'Baseline', agentType: 'frontend-platform', schema: FAILURES_SCHEMA }
  )
  if (r) baselines.push(r)
}

// Collect unique failing spec files with their aggregated errors.
const failingByFile = {}
for (const b of baselines) {
  for (const f of b.failures || []) {
    if (!failingByFile[f.specFile]) failingByFile[f.specFile] = []
    failingByFile[f.specFile].push(`• ${f.testTitle}\n  ${f.errorExcerpt}`)
  }
}
const failingFiles = Object.keys(failingByFile)
log(`Baseline done. ${failingFiles.length} spec files have failures: ${failingFiles.join(', ') || '(none — all green!)'}`)

let fixes = []
if (failingFiles.length > 0) {
  phase('Fix')
  fixes = (await parallel(
    failingFiles.map((specFile) => () => agent(
      `Fix the failing Playwright spec: ${specFile} (in ${PLATFORM}).

Failing tests + errors from the baseline run:
${failingByFile[specFile].join('\n')}

${PLAYBOOK}

Read the spec file and the app component(s)/route(s) it targets, decide test-vs-implementation per failure, and apply the MINIMAL correct fix. Edit only ${specFile} and — only when it is clearly the root cause — the single module component/route under app/ or src/routes/ that the spec targets. For shared files, return crossCutting instructions instead.

Return what you changed and any crossCutting items (exact file + change, e.g. a console-errors IGNORE_PATTERNS regex).`,
      { label: `fix:${specFile.split('/').slice(-1)[0]}`, phase: 'Fix', agentType: 'frontend-platform',
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            specFile: { type: 'string' },
            filesChanged: { type: 'array', items: { type: 'string' } },
            summary: { type: 'string' },
            crossCutting: { type: 'array', items: { type: 'string' }, description: 'exact shared-file changes NOT applied (file + precise edit)' },
            stillBlocked: { type: 'string', description: 'empty unless a failure needs data/infra that does not exist; explain' },
          },
          required: ['specFile', 'filesChanged', 'summary'],
        } }
    ))
  )).filter(Boolean)

  const crossCutting = fixes.flatMap((f) => f.crossCutting || [])
  if (crossCutting.length > 0) {
    phase('Shared')
    await agent(
      `Apply these cross-cutting shared-file changes collected from per-spec fix agents. De-duplicate and apply each precisely. Working dir: ${PLATFORM}.

${crossCutting.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Most will be additions to e2e/helpers/console-errors.ts IGNORE_PATTERNS (keep them SCOPED — match the specific noisy source, never a blanket /Failed to load resource/) or stable data-testid additions to shared chrome components. Apply only what is sound; skip anything that would mask a real bug (note skips). Keep TypeScript clean (no \`any\`). Return what you applied and skipped.`,
      { label: 'apply-shared', phase: 'Shared', agentType: 'frontend-platform',
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            applied: { type: 'array', items: { type: 'string' } },
            skipped: { type: 'array', items: { type: 'string' } },
            filesChanged: { type: 'array', items: { type: 'string' } },
          },
          required: ['applied', 'filesChanged'],
        } }
    )
  }

  phase('Verify')
  // Re-run only the groups that had failures, serially.
  const touchedGroups = GROUPS.filter((g) =>
    failingFiles.some((ff) => g.includes(ff) || ff.startsWith(g.split(' ')[0])),
  )
  const verifyResults = []
  for (const group of touchedGroups) {
    const r = await agent(
      `Re-run these platform e2e specs after fixes and report the result. Working dir: ${PLATFORM}.
Run: \`npx playwright test ${group} --project=chromium --workers=1 --reporter=line\` (600000ms timeout).
Parse output. Return the structured result (failures that REMAIN, same shape as baseline). Do NOT fix anything.`,
      { label: `verify:${group.split('/').slice(-1)[0].slice(0, 24)}`, phase: 'Verify', agentType: 'frontend-platform', schema: FAILURES_SCHEMA }
    )
    if (r) verifyResults.push(r)
  }
  const remaining = verifyResults.flatMap((v) => (v.failures || []).map((f) => `${f.specFile} :: ${f.testTitle}`))
  log(`Verify done. ${remaining.length} failures remain.`)

  return {
    baselineFailingFiles: failingFiles.length,
    fixes: fixes.map((f) => ({ specFile: f.specFile, summary: f.summary, stillBlocked: f.stillBlocked })),
    crossCuttingApplied: crossCutting.length,
    remainingFailures: remaining,
  }
}

return { baselineFailingFiles: 0, message: 'All baselined specs already green.' }
