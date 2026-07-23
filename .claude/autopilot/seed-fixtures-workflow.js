export const meta = {
  name: 'seed-fixtures-impl',
  description: 'Implement app-api test-fixtures seed endpoints + client methods, then activate the gated CRUD specs',
  phases: [
    { title: 'Research', detail: 'one agent per entity group — resolve table, NOT-NULL cols, FK chains, marker column, return shape' },
    { title: 'Router', detail: 'single agent writes all /seed/* endpoints + /reset + delete switch in app-api' },
    { title: 'Client', detail: 'single agent writes all seed* methods + interfaces + SeedEntityType union in the e2e client' },
    { title: 'Activate', detail: 'per-module agents un-gate the fixme/skip specs to call the real seed methods' },
    { title: 'Verify', detail: 'app-api type-check + e2e type-check + playwright --list' },
  ],
}

const ROUTER = 'apps/workers/app-api/src/routes/_test-fixtures/index.ts'
const CLIENT = 'apps/web/platform/e2e/helpers/test-fixtures-client.ts'

// Entity groups to research. Closely-coupled entities (FK chains, same module)
// are grouped so one agent reasons about the whole chain.
const GROUPS = [
  { key: 'crm-opportunity', module: 'weldcrm', entities: ['opportunity'], seedMethods: ['seedOpportunity'] },
  { key: 'crm-activity',    module: 'weldcrm', entities: ['activity'],    seedMethods: ['seedActivity'] },
  { key: 'crm-sequence',    module: 'weldcrm', entities: ['sequence'],    seedMethods: ['seedSequence'] },
  { key: 'welddesk-ticket', module: 'welddesk', entities: ['ticket'],     seedMethods: ['seedTicket'] },
  { key: 'weldmeet-meeting', module: 'weldmeet', entities: ['meeting'],   seedMethods: ['seedMeeting'] },
  { key: 'weldhost-domain', module: 'weldhost', entities: ['domain'],     seedMethods: ['seedDomain'] },
  { key: 'weldmail',        module: 'weldmail', entities: ['mailAccount', 'mailLabel'], seedMethods: ['seedMailAccount', 'seedMailLabel'] },
  { key: 'weldcommerce',    module: 'weldcommerce', entities: ['product', 'order'], seedMethods: ['seedProduct', 'seedOrder'] },
  { key: 'weldconnect',     module: 'weldconnect', entities: ['workflow', 'webhook', 'execution'], seedMethods: ['seedWorkflow', 'seedWebhook', 'seedExecution'] },
  { key: 'weldstash',       module: 'weldstash', entities: ['weldstashProduct', 'weldstashSupplier', 'weldstashWarehouse'], seedMethods: ['seedWeldstashProduct', 'seedWeldstashSupplier', 'seedWeldstashWarehouse'] },
  { key: 'weldcalendar',    module: 'weldcalendar', entities: ['calendarEvent', 'bookingPage'], seedMethods: ['seedCalendarEvent', 'seedBookingPage'] },
  { key: 'weldcall',        module: 'weldcall', entities: ['voipCall'], seedMethods: ['seedVoipCall'] },
  { key: 'settings',        module: 'settings', entities: ['customFieldDefinition', 'objectTemplate', 'customerStatus'], seedMethods: ['seedCustomFieldDefinition', 'seedObjectTemplate', 'seedCustomerStatus'] },
]

const PATTERN = `
The existing pattern (study ${ROUTER} and ${CLIENT} before doing anything — they hold the canonical examples for company/person/pipeline/lead/list/project/task):

ROUTER side (apps/workers/app-api/src/routes/_test-fixtures/index.ts):
- Every seeded row is stamped with the literal TEST_MARKER ('[E2E_TEST]') in a marker column so /reset can find+delete it. Existing markers: companies/people use \`internalNotes\`; pipelines/lists/projects/activities/tasks use \`description\`; leads use \`notes\`. Pick a real, nullable text column on the target table for the marker — verify it EXISTS in packages/core/db/src/schema. If the table has no obvious text column, use a metadata/JSONB field or the closest notes-like column; state which.
- Prefer reusing an existing service create function (e.g. createCompany from '../../services/companies', createDomain from '../../services/domains', workflow services) when one exists AND it accepts the marker field — pass internalNotes/description: TEST_MARKER through it. Otherwise do a direct \`db.insert(schema.X).values({ id: generateId('prefix'), ...NOT_NULL_cols, <markerCol>: TEST_MARKER, createdAt: now, updatedAt: now })\` then re-select the row. generateId is imported from '../../lib/id'. The codebase uses \`as unknown as typeof schema.X.$inferInsert\` to satisfy strict insert types where needed (see seed/list, seed/task).
- Each endpoint: a zod body schema (all fields .optional() with sensible defaults), zValidator('json', body), handler returns success(c, row, 201).
- FK chains: if the target row needs a foreign key (e.g. an order needs a customerId, an execution needs a workflowId, a ticket needs a contact/conversation), CREATE the parent inline first — stamped with TEST_MARKER — and use its id. Make the parent id overridable via the body. Add the parent table to /reset too if it isn't already.
- Extend the /reset handler with a counts.<entity> delete-by-marker block for every new table (including inline-created parents).
- Extend the delete '/entity/:type/:id' switch with a case for each new entity type.

CLIENT side (apps/web/platform/e2e/helpers/test-fixtures-client.ts):
- Add a Seeded<Entity> interface (matching the router's actual return shape — only the fields specs read).
- Add a seed<Entity> method to the testFixtures object mirroring seedCompany.
- Add the new type(s) to the SeedEntityType union.

All schema knowledge MUST come from reading packages/core/db/src/schema — do NOT guess column names or NOT-NULL constraints. Zod v3 only.
`

const SEEDSPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    group: { type: 'string' },
    module: { type: 'string' },
    entities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'lowerCamel entity name, e.g. opportunity' },
          seedMethod: { type: 'string' },
          routePath: { type: 'string', description: 'e.g. /seed/opportunity' },
          entityType: { type: 'string', description: 'token for the delete switch + SeedEntityType union' },
          schemaTable: { type: 'string', description: 'schema.<key> from packages/db, e.g. schema.crmOpportunities' },
          serviceFn: { type: 'string', description: 'import path + name of a reusable create service, or empty if none' },
          markerColumn: { type: 'string', description: 'nullable text column to stamp TEST_MARKER into' },
          idPrefix: { type: 'string', description: "generateId prefix, e.g. 'opp'" },
          requiredColumns: { type: 'array', items: { type: 'string' }, description: 'NOT-NULL columns without a default that the insert must set, with their types' },
          fkDependencies: { type: 'array', items: { type: 'string' }, description: 'FK columns + how to satisfy (parent to create inline, or accept id in body)' },
          returnInterface: { type: 'string', description: 'TS body of the Seeded<Entity> interface, e.g. "id: string; name: string;"' },
          insertSketch: { type: 'string', description: 'concrete code sketch of the zod body + handler insert/values for the router' },
          gatedSpecFiles: { type: 'array', items: { type: 'string' }, description: 'e2e/specs/** files that reference this seedMethod and must be activated (grep for it)' },
          feasibility: { type: 'string', enum: ['simple', 'fk-chain', 'complex'] },
          blockedReason: { type: 'string', description: 'why complex/blocked, empty if feasible' },
        },
        required: ['name', 'seedMethod', 'routePath', 'entityType', 'schemaTable', 'markerColumn', 'idPrefix', 'returnInterface', 'insertSketch', 'feasibility', 'gatedSpecFiles'],
      },
    },
  },
  required: ['group', 'module', 'entities'],
}

phase('Research')
const specs = await parallel(
  GROUPS.map((g) => () => agent(
    `Research how to implement test-fixtures seed endpoint(s) for the WeldSuite ${g.module} entit${g.entities.length > 1 ? 'ies' : 'y'}: ${g.entities.join(', ')} (seed methods: ${g.seedMethods.join(', ')}).

${PATTERN}

For EACH entity in this group, produce a precise SeedSpec by:
1. Finding the Drizzle table in packages/core/db/src/schema (give the exact \`schema.<key>\`).
2. Listing every NOT-NULL column without a default that an insert must provide (with type), and every FK column + how to satisfy it (create parent inline stamped with the marker, or accept an id in the body).
3. Choosing the marker column (a real nullable text column on that table — verify it exists).
4. Checking for a reusable create service in apps/workers/app-api/src/services that accepts a marker field.
5. Writing a concrete insertSketch (zod body + the values{} object or service call) the implementer can paste in, following the existing seed/* style exactly.
6. Defining the Seeded<Entity> return interface (only fields specs actually read).
7. Grepping apps/web/platform/e2e/specs for the seed method name to list the gatedSpecFiles that must be activated.
8. Rating feasibility: 'simple' (single insert), 'fk-chain' (needs 1+ parent rows created inline), or 'complex' (hard deps — multi-table, required external IDs, or no clean insert path) with a blockedReason.

Do NOT write any files. Return the structured SeedSpec for the whole group.`,
    { label: `research:${g.key}`, phase: 'Research', agentType: 'database', schema: SEEDSPEC_SCHEMA }
  ))
)

const groups = specs.filter(Boolean)
const allEntities = groups.flatMap((g) => g.entities.map((e) => ({ ...e, module: g.module })))
const buildable = allEntities.filter((e) => e.feasibility !== 'complex')
const deferred = allEntities.filter((e) => e.feasibility === 'complex')
log(`Research done: ${allEntities.length} entities — ${buildable.length} buildable, ${deferred.length} deferred (complex).`)

phase('Router')
const routerResult = await agent(
  `Implement the test-fixtures seed endpoints in ${ROUTER}.

${PATTERN}

Add an endpoint for each of these researched entities (skip any marked feasibility 'complex' — list them as skipped):
${JSON.stringify(buildable, null, 2)}

Rules:
- Append new zod body schemas + POST handlers in the "Seed endpoints" section, keeping the existing ones intact.
- Use each entity's insertSketch as the basis, but VERIFY column names against packages/core/db/src/schema as you go — the sketch is a guide, not gospel. Fix any mismatch.
- For fk-chain entities, create the parent row(s) inline (stamped with TEST_MARKER), make the parent id overridable via the body, and ensure the parent table is covered by /reset.
- Extend the /reset handler: add a \`counts.<entity> = (await db.delete(schema.X).where(like(schema.X.<markerCol>, marker)).returning(...)).length\` block for every new table (including inline parents not already covered).
- Extend the delete '/entity/:type/:id' switch with a case per new entityType.
- The file must compile: \`pnpm --filter <app-api pkg> type-check\` (tsc --noEmit) from apps/workers/app-api. Run it and fix type errors in THIS file before returning. Pre-existing errors elsewhere are not yours to fix — only ensure _test-fixtures/index.ts is clean.

Return the list of endpoints added, reset blocks added, delete cases added, anything skipped (+reason), and the exact return shape each endpoint produces (the client agent needs these).`,
  { label: 'router', phase: 'Router', agentType: 'general-purpose',
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        endpointsAdded: { type: 'array', items: { type: 'string' } },
        returnShapes: { type: 'array', items: { type: 'string' }, description: 'per endpoint: "seedX -> { id, name, ... }"' },
        resetEntriesAdded: { type: 'array', items: { type: 'string' } },
        deleteCasesAdded: { type: 'array', items: { type: 'string' } },
        skipped: { type: 'array', items: { type: 'string' } },
        typeCheckOk: { type: 'boolean' },
        notes: { type: 'string' },
      },
      required: ['endpointsAdded', 'returnShapes', 'typeCheckOk', 'notes'],
    } }
)

phase('Client')
const clientResult = await agent(
  `Implement the matching client methods in ${CLIENT}.

${PATTERN}

The router now exposes these endpoints with these return shapes:
${JSON.stringify(routerResult.returnShapes, null, 2)}

Endpoints added: ${JSON.stringify(routerResult.endpointsAdded)}

For each, add to ${CLIENT}: a Seeded<Entity> interface (matching the router's return shape), a seed<Entity> method on the testFixtures object (mirroring seedCompany exactly), and the new entityType token in the SeedEntityType union. Keep all existing exports intact. Zod/TS strict — no \`any\`.

Then run the platform e2e type-check (tsc --noEmit -p apps/web/platform/tsconfig.json) and confirm this file is clean. Return what you added.`,
  { label: 'client', phase: 'Client', agentType: 'frontend-platform',
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        methodsAdded: { type: 'array', items: { type: 'string' } },
        interfacesAdded: { type: 'array', items: { type: 'string' } },
        unionTokensAdded: { type: 'array', items: { type: 'string' } },
        typeCheckOk: { type: 'boolean' },
        notes: { type: 'string' },
      },
      required: ['methodsAdded', 'interfacesAdded', 'notes'],
    } }
)

phase('Activate')
// One activation agent per module that had at least one buildable entity with gated specs.
const activatable = groups
  .map((g) => ({
    module: g.module,
    methods: g.entities.filter((e) => e.feasibility !== 'complex').map((e) => e.seedMethod),
    specFiles: [...new Set(g.entities.filter((e) => e.feasibility !== 'complex').flatMap((e) => e.gatedSpecFiles || []))],
  }))
  .filter((a) => a.specFiles.length > 0 && a.methods.length > 0)

const activations = await parallel(
  activatable.map((a) => () => agent(
    `The following test-fixtures seed methods now EXIST on the e2e client (apps/web/platform/e2e/helpers/test-fixtures-client.ts): ${a.methods.join(', ')}.

Activate the previously-gated CRUD/detail specs for the ${a.module} module that depend on them. Spec files to update: ${JSON.stringify(a.specFiles)}.

For each spec file:
- If it uses \`test.describe.fixme(...)\`, change it back to \`test.describe(...)\` and ensure a \`test.beforeAll(() => { test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set'); })\` gate is present (import isTestFixturesConfigured from '../../helpers/test-fixtures-client'). This is the canonical pattern — see e2e/specs/weldcrm/companies-crud.spec.ts.
- Replace any \`(api as unknown as X).seedY(...)\` casts, \`typeof seedFn\` existence guards, optional-chaining \`seedY?.(...)\`, or commented-out \`// const x = await api.seedY(...)\` stubs with direct typed calls \`await api.seedY({...})\` now that the method is real and typed.
- Remove now-dead local fixture interfaces / casts / \`test.skip(true, '... not yet implemented')\` lines that the real method makes unnecessary.
- Do NOT loosen selectors or assertions. Keep the test bodies as the original author wrote them — only the seeding/gating plumbing changes.
- Keep specs that depend on a seed method that is NOT in the available list above gated as they were.

Run tsc --noEmit -p apps/web/platform/tsconfig.json and confirm the files you touched are type-clean. Return per-file: tests activated, anything left gated (+reason).`,
    { label: `activate:${a.module}`, phase: 'Activate', agentType: 'frontend-platform',
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          module: { type: 'string' },
          filesUpdated: { type: 'array', items: { type: 'string' } },
          testsActivated: { type: 'number' },
          stillGated: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
        },
        required: ['module', 'filesUpdated', 'testsActivated', 'notes'],
      } }
  ))
)

phase('Verify')
const verify = await agent(
  `Verify the test-fixtures seed work compiles and the e2e suite still discovers cleanly.

Run, from the repo root or the right app dir, and report each:
1. app-api type-check: \`pnpm --filter ./apps/workers/app-api type-check\` (or \`cd apps/workers/app-api && npx tsc --noEmit\`). The _test-fixtures router edits must compile against the real Drizzle schema. If there are NEW errors in apps/workers/app-api/src/routes/_test-fixtures/index.ts, fix them (wrong column name, missing NOT-NULL field, bad insert type). Distinguish new errors from pre-existing ones elsewhere.
2. platform e2e type-check: \`cd apps/web/platform && npx tsc --noEmit\` — filter to e2e/ errors and fix any in the test-fixtures client or the activated specs.
3. \`cd apps/web/platform && npx playwright test --list\` — confirm it still lists with zero parse errors; report the total test count.

You CANNOT run the seed endpoints against a live DB here (no test workspace/token), so runtime correctness of the inserts is NOT verifiable — only type-correctness and spec discovery. Note this honestly.

Return type-check + list results, any fixes you applied, and a one-line finalStatus.`,
  { label: 'verify', phase: 'Verify', agentType: 'general-purpose',
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        appApiTypeCheckOk: { type: 'boolean' },
        e2eTypeCheckOk: { type: 'boolean' },
        listOk: { type: 'boolean' },
        totalTestsDiscovered: { type: 'number' },
        newErrors: { type: 'array', items: { type: 'string' } },
        fixesApplied: { type: 'array', items: { type: 'string' } },
        finalStatus: { type: 'string' },
      },
      required: ['appApiTypeCheckOk', 'e2eTypeCheckOk', 'listOk', 'finalStatus'],
    } }
)

return {
  entitiesResearched: allEntities.length,
  buildable: buildable.map((e) => e.seedMethod),
  deferred: deferred.map((e) => ({ method: e.seedMethod, reason: e.blockedReason })),
  router: routerResult,
  client: clientResult,
  activations: activations.filter(Boolean),
  verify,
}
