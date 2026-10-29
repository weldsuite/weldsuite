/**
 * Export the TypeScript catalogs the Rust backend needs to JSON under
 * rust/catalogs/ (P1 work package 1.6 of the editions plan, ADR API-014).
 * `rust/crates/catalogs` turns the JSON into Rust types at build time, so the
 * TypeScript files stay the one source of truth while both backends run.
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

import { API_MODULES, RECORD_CHAT_OWNER, RECORD_CHAT_PREFIX } from '../packages/core/api-modules/src/index';
import { ENTITY_EVENTS } from '../packages/core/entity-events/src/events/index';
import { FLAGS } from '../packages/core/feature-flags/src/flags';
import {
  EMPLOYEE_MEMBER_PERMISSIONS,
  PERMISSION_CATALOG_OBJECTS,
  SYSTEM_ROLES,
} from '../packages/core/permissions/src/catalog';
import { APP_CODE_ALIASES, PERMISSION_APPS } from '../packages/core/permissions/src/apps';
import { FIRST_PARTY_ORIGINS } from '../packages/core/worker-kit/src/cors';
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

async function main(): Promise<void> {
  /** Output path under rust/ → value. */
  const outputs: Record<string, unknown> = {
    'catalogs/api-modules.json': API_MODULES,
    'catalogs/record-chat.json': { prefix: RECORD_CHAT_PREFIX, owners: RECORD_CHAT_OWNER },
    'catalogs/entity-events.json': ENTITY_EVENTS,
    'catalogs/feature-flags.json': FLAGS,
    'catalogs/first-party-origins.json': FIRST_PARTY_ORIGINS,
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
