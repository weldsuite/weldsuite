/**
 * Export the TypeScript catalogs the Rust backend needs to JSON under
 * rust/catalogs/ (P1 work package 1.6 of the editions plan, ADR API-014).
 * `rust/crates/catalogs` turns the JSON into Rust types at build time, so the
 * TypeScript files stay the one source of truth while both backends run.
 *
 *   pnpm rust:catalogs           write rust/catalogs/*.json
 *   pnpm rust:catalogs --check   exit 1 when a file is missing or stale (CI)
 *
 * Imports the catalog source files directly, not the package entry points,
 * so no package build is needed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_MODULES } from '../packages/core/api-modules/src/index';
import { ENTITY_EVENTS } from '../packages/core/entity-events/src/events/index';
import { FLAGS } from '../packages/core/feature-flags/src/flags';
import {
  EMPLOYEE_MEMBER_PERMISSIONS,
  PERMISSION_CATALOG_OBJECTS,
  SYSTEM_ROLES,
} from '../packages/core/permissions/src/catalog';
import { PERMISSION_APPS } from '../packages/core/permissions/src/apps';
import { FIRST_PARTY_ORIGINS } from '../packages/core/worker-kit/src/cors';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repo, 'rust', 'catalogs');

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

const catalogs: Record<string, unknown> = {
  'api-modules.json': API_MODULES,
  'entity-events.json': ENTITY_EVENTS,
  'feature-flags.json': FLAGS,
  'first-party-origins.json': FIRST_PARTY_ORIGINS,
  'permissions.json': {
    objects: PERMISSION_CATALOG_OBJECTS,
    systemRoles: SYSTEM_ROLES,
    employeeMemberPermissions: EMPLOYEE_MEMBER_PERMISSIONS,
    apps: PERMISSION_APPS,
  },
};

const check = process.argv.includes('--check');
const stale: string[] = [];
if (!check) mkdirSync(outDir, { recursive: true });

for (const [file, value] of Object.entries(catalogs)) {
  const target = path.join(outDir, file);
  const next = stableJson(value);
  const current = existsSync(target) ? readFileSync(target, 'utf8').replaceAll('\r\n', '\n') : null;
  if (current === next) continue;
  if (check) stale.push(file);
  else writeFileSync(target, next);
}

if (check && stale.length > 0) {
  console.error(`rust/catalogs is out of date: ${stale.join(', ')}. Run \`pnpm rust:catalogs\` and commit the result.`);
  process.exit(1);
}
console.log(check ? 'rust/catalogs is up to date.' : `Wrote ${Object.keys(catalogs).length} catalogs to rust/catalogs/.`);
