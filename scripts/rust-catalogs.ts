/**
 * Export the TypeScript catalogs the Rust backend shares with the frontends
 * to JSON under rust/catalogs/ (ADR API-014). `rust/crates/catalogs` and the
 * modules read the JSON at build time, so the TypeScript files the platform
 * and the mobile apps also use stay the one source of truth.
 *
 * The catalogs only the backend used are Rust's own since the TypeScript
 * backend was deleted (ADR OPS-025): api-modules.json, record-chat.json,
 * core-platform-prefixes.json, first-party-origins.json, connectors.json,
 * odata.json, and weldconnect.json's actionTypes, triggerTypes, entityEvents
 * and integrations. Edit those in the JSON; this script leaves them alone.
 *
 * Also writes the parity cases the Rust permissions engine is tested against
 * (./rust-permission-cases.ts), so a behaviour change in
 * @weldsuite/permissions fails the same CI check until the port follows.
 *
 *   pnpm rust:catalogs           write the files
 *   pnpm rust:catalogs --check   exit 1 when a file is missing or stale (CI)
 *
 * Imports the catalog source files directly, not the package entry points,
 * so no package build is needed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENTITY_EVENTS } from '../packages/core/entity-events/src/events/index';
import { listWebhookEvents } from '../packages/core/entity-events/src/webhook-events';
import { FLAGS } from '../packages/core/feature-flags/src/flags';
import {
  EMPLOYEE_MEMBER_PERMISSIONS,
  PERMISSION_CATALOG_OBJECTS,
  SYSTEM_ROLES,
} from '../packages/core/permissions/src/catalog';
import { APP_CODE_ALIASES, PERMISSION_APPS } from '../packages/core/permissions/src/apps';
import {
  BUILT_IN_WORKFLOW_TEMPLATES,
  resolveBuiltInTemplate,
  type BuiltInTemplateCatalog,
} from '../packages/clients/app-api-client/src/schemas/weldconnect-templates';
import { weldconnectTemplates as enTemplateStrings } from '../packages/core/i18n/src/locales/en/weldconnect-templates';
import { weldconnectTemplates as nlTemplateStrings } from '../packages/core/i18n/src/locales/nl/weldconnect-templates';
import { STARTER_TEMPLATES } from '../packages/core/forms-engine/src/templates';
import { formDefinitionSchema } from '../packages/core/forms-engine/src/definition';
import {
  MAX_SHEET_DATA_COLUMNS,
  MAX_SHEET_DATA_FILTERS,
  MAX_SHEET_DATA_ROWS,
  SHEET_DATA_FILTER_OPS,
  SHEET_DATA_FILTER_OPS_BY_TYPE,
  SHEET_DATA_OBJECT_KEYS,
  SHEET_DATA_OBJECTS,
} from '../packages/clients/app-api-client/src/schemas/sheet-data';
import {
  AI_CAPABILITIES,
  AI_FEATURES,
  AI_MODELS,
  AI_PROVIDERS,
  AI_TASKS,
  COMPAT_CAPABILITIES,
  PROVIDER_TASKS,
  TASK_NEEDS,
} from '../packages/core/ai/src/catalog';
import {
  CREDITS_PER_USD,
  DEFAULT_PRICE,
  MODEL_PRICES,
  PROVIDER_MARKUP,
  WORKERS_AI_FALLBACK_PRICE,
} from '../packages/core/ai/src/billing-rates';
import { buildPermissionCases } from './rust-permission-cases';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rustDir = path.join(repo, 'rust');

/** JSON with object keys sorted, so a reordering in TypeScript is not a diff. */
function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** WeldConnect's pickers and providers, kept in the JSON by hand (see the top). */
const WELDCONNECT_RUST_OWNED = ['actionTypes', 'triggerTypes', 'entityEvents', 'integrations'] as const;

/**
 * WeldConnect's code catalogs: the built-in workflow templates resolved in
 * each locale and the webhook event picker, from TypeScript; the editor's
 * pickers (`/api/workflow-dashboard/{action-types,trigger-types,entity-events}`)
 * and the providers as the JSON already has them.
 */
function weldconnectCatalog(): unknown {
  const current = JSON.parse(readFileSync(path.join(rustDir, 'catalogs/weldconnect.json'), 'utf8')) as Record<string, unknown>;
  const strings: Record<string, BuiltInTemplateCatalog> = { en: enTemplateStrings, nl: nlTemplateStrings };
  const templates = Object.fromEntries(
    Object.entries(strings).map(([locale, catalog]) => [
      locale,
      BUILT_IN_WORKFLOW_TEMPLATES.map((definition) => resolveBuiltInTemplate(definition, catalog, strings.en)),
    ]),
  );
  return {
    ...Object.fromEntries(WELDCONNECT_RUST_OWNED.map((key) => [key, current[key]])),
    templates,
    // The outbound webhook event picker (`GET /api/external-webhooks/events`), in catalog order.
    webhookEvents: listWebhookEvents(),
  };
}

/**
 * WeldSheets' connected tables (`@weldsuite/app-api-client/schemas/sheet-data`):
 * the objects a sheet can list, in order, with the permission each needs and
 * its fields' types, and the filter operators per type, for the definition
 * checks of `/api/sheets/:id/data-sources`.
 */
function sheetDataCatalog(): unknown {
  return {
    objectKeys: SHEET_DATA_OBJECT_KEYS,
    objects: Object.fromEntries(
      SHEET_DATA_OBJECT_KEYS.map((key) => [
        key,
        { permission: SHEET_DATA_OBJECTS[key].permission, fields: SHEET_DATA_OBJECTS[key].fields.map(({ key: k, type }) => ({ key: k, type })) },
      ]),
    ),
    filterOps: SHEET_DATA_FILTER_OPS,
    filterOpsByType: SHEET_DATA_FILTER_OPS_BY_TYPE,
    maxRows: MAX_SHEET_DATA_ROWS,
    maxColumns: MAX_SHEET_DATA_COLUMNS,
    maxFilters: MAX_SHEET_DATA_FILTERS,
  };
}

/**
 * WeldForms' starter templates (`STARTER_TEMPLATES` of `@weldsuite/forms-engine`),
 * in gallery order, each definition as `formDefinitionSchema.parse` returns it:
 * what forms-api stores when a member creates a form from a template.
 */
function formsTemplatesCatalog(): unknown {
  return STARTER_TEMPLATES.map((template) => ({
    id: template.id,
    category: template.category,
    name: template.name,
    description: template.description,
    definition: formDefinitionSchema.parse(template.definition),
  }));
}

/**
 * The AI catalog of the Kubernetes editions (`@weldsuite/ai`'s `catalog.ts`,
 * ADR AI-012) with the shared rate table (`billing-rates.ts`, AI-006), for
 * `rust/crates/ai`. `tasks` is `recommended`'s task list, in its order.
 */
function aiCatalog(): unknown {
  return {
    tasks: AI_TASKS,
    capabilities: AI_CAPABILITIES,
    providers: AI_PROVIDERS,
    models: AI_MODELS,
    providerTasks: PROVIDER_TASKS,
    taskNeeds: TASK_NEEDS,
    compatCapabilities: COMPAT_CAPABILITIES,
    features: AI_FEATURES,
    prices: MODEL_PRICES,
    defaultPrice: DEFAULT_PRICE,
    workersAiFallbackPrice: WORKERS_AI_FALLBACK_PRICE,
    providerMarkup: PROVIDER_MARKUP,
    creditsPerUsd: CREDITS_PER_USD,
  };
}

async function main(): Promise<void> {
  /** Output path under rust/ → value. */
  const outputs: Record<string, unknown> = {
    'catalogs/entity-events.json': ENTITY_EVENTS,
    // The entity types in ENTITY_EVENTS' own order (the JSON above is sorted):
    // `listAllEvents()` and the public API's /v1/webhooks/events list in it.
    'catalogs/entity-event-order.json': Object.keys(ENTITY_EVENTS),
    'catalogs/feature-flags.json': FLAGS,
    'catalogs/weldconnect.json': weldconnectCatalog(),
    'catalogs/sheet-data.json': sheetDataCatalog(),
    'catalogs/forms-templates.json': formsTemplatesCatalog(),
    'catalogs/ai.json': aiCatalog(),
    'catalogs/permissions.json': {
      objects: PERMISSION_CATALOG_OBJECTS,
      systemRoles: SYSTEM_ROLES,
      employeeMemberPermissions: EMPLOYEE_MEMBER_PERMISSIONS,
      apps: PERMISSION_APPS,
      appCodeAliases: APP_CODE_ALIASES,
    },
    'crates/permissions/tests/fixtures/permission-cases.json': await buildPermissionCases(),
  };

  const check = process.argv.includes('--check');
  const stale: string[] = [];

  for (const [file, value] of Object.entries(outputs)) {
    const target = path.join(rustDir, file);
    const next = stableJson(value);
    const current = existsSync(target) ? readFileSync(target, 'utf8').replaceAll('\r\n', '\n') : null;
    if (current === next) continue;
    if (check) {
      stale.push(file);
    } else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, next);
    }
  }

  if (check && stale.length > 0) {
    console.error(`rust/ catalogs are out of date: ${stale.join(', ')}. Run \`pnpm rust:catalogs\` and commit the result.`);
    process.exit(1);
  }
  console.log(check ? 'rust/ catalogs are up to date.' : `Wrote ${Object.keys(outputs).length} files under rust/.`);
}

void main();
