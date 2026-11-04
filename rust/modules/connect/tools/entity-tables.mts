/**
 * Generates rust/modules/connect/src/engine/actions/data/tables.rs: the tables
 * the engine's generic record steps (`create_record`, `update_record`,
 * `delete_record`, `query_data`) reach, by entity type, as workflow-worker's
 * `engine/entity-tables.ts` maps them, with their Drizzle properties, column
 * kinds and the columns `selectableColumns` leaves out (sensitive ones), and
 * the statements those steps run:
 *
 * - insert: a `{ column: value }` object written as Drizzle's insert would: a
 *   column the object leaves out gets its database default (from the latest
 *   tenant snapshot), one set to null gets NULL;
 * - patch: only the columns the object names change (`.set(data)`);
 * - soft and hard delete, and the list `query_data` reads;
 * - the shared-mailbox condition of the mail tables (MAIL-003).
 *
 *   pnpm --filter @weldsuite/db exec tsx ../../../rust/modules/connect/tools/entity-tables.mts
 *
 * Run from packages/core/db (it imports the Drizzle schema). Commit the output.
 * ENTITY_TABLES and ID_PREFIXES copy `entityTableMap` / `entityIdPrefixMap` of
 * apps/workers/workflow-worker/src/engine/entity-tables.ts: keep them in step.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '@weldsuite/db/schema';
import { SENSITIVE_COLUMNS } from '@weldsuite/db/lib/sensitive-columns';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const snapshotDir = path.join(repo, 'packages/core/db/drizzle/tenant-migrations/meta');
const latest = readdirSync(snapshotDir)
  .filter((f) => f.endsWith('_snapshot.json'))
  .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
  .at(-1)!;
const snapshot = JSON.parse(readFileSync(path.join(snapshotDir, latest), 'utf8')) as {
  tables: Record<string, { columns: Record<string, { type: string; default?: unknown }> }>;
};

/** `entityTableMap`: entity type → the table's export name, in the map's order. */
const ENTITY_TABLES: Array<[string, string]> = [
  ['lead', 'crmLeads'],
  ['crm_lead', 'crmLeads'],
  ['customer', 'companies'],
  ['company', 'companies'],
  ['contact', 'people'],
  ['person', 'people'],
  ['opportunity', 'crmOpportunities'],
  ['crm_opportunity', 'crmOpportunities'],
  ['activity', 'crmActivities'],
  ['crm_activity', 'crmActivities'],
  ['pipeline_stage', 'crmPipelineStages'],
  ['ticket', 'helpdeskTickets'],
  ['helpdesk_ticket', 'helpdeskTickets'],
  ['ticket_message', 'helpdeskTicketMessages'],
  ['department', 'helpdeskDepartments'],
  ['helpdesk_department', 'helpdeskDepartments'],
  ['canned_response', 'helpdeskCannedResponses'],
  ['order', 'orders'],
  ['product', 'products'],
  ['category', 'categories'],
  ['project', 'projects'],
  ['task', 'tasks'],
  ['milestone', 'milestones'],
  ['time_entry', 'timeEntries'],
  ['project_file', 'projectFiles'],
  ['project_member', 'projectMembers'],
  ['mail_account', 'mailAccounts'],
  ['mail_message', 'mailMessages'],
  ['mail_folder', 'mailFolders'],
  ['mail_template', 'mailTemplates'],
  ['workflow', 'workflows'],
  ['workflow_execution', 'workflowExecutions'],
  ['workflow_schedule', 'workflowSchedules'],
  ['workflow_variable', 'workflowVariables'],
  ['workflow_webhook', 'workflowWebhooks'],
  ['workflow_integration', 'workflowIntegrations'],
  ['host_domain', 'hostDomains'],
];

/** `entityIdPrefixMap`. */
const ID_PREFIXES: Record<string, string> = {
  lead: 'led', crm_lead: 'led', customer: 'cus', contact: 'con',
  opportunity: 'opp', crm_opportunity: 'opp', activity: 'act', crm_activity: 'act',
  pipeline_stage: 'pst', ticket: 'tkt', helpdesk_ticket: 'tkt',
  ticket_message: 'tmg', department: 'dep', canned_response: 'crs',
  order: 'ord', product: 'prd', category: 'cat',
  project: 'prj', task: 'tsk', milestone: 'mls', time_entry: 'ten',
  project_file: 'pfl', project_member: 'pmb',
  mail_account: 'mac', mail_message: 'mmsg', mail_folder: 'mfl', mail_template: 'mtp',
  workflow: 'wfl', workflow_execution: 'wex', workflow_schedule: 'wsc',
  workflow_variable: 'wvr', workflow_webhook: 'wwh', workflow_integration: 'win',
  host_domain: 'hdo',
};

/** `sharedMailboxCondition`: the mail tables' rows a workflow may touch (MAIL-003). */
const MAIL_CONDITIONS: Record<string, string> = {
  mail_accounts: 't.is_shared = true',
  mail_messages: 't.account_id in (select a.id from mail_accounts a where a.is_shared = true and a.deleted_at is null)',
  mail_folders: 't.account_id in (select a.id from mail_accounts a where a.is_shared = true and a.deleted_at is null)',
};

type Kind = 'Text' | 'Number' | 'Bool' | 'Json' | 'Date' | 'DateString' | 'Numeric' | 'Array' | 'Other';

function kindOf(columnType: string): Kind {
  switch (columnType) {
    case 'PgText':
    case 'PgVarchar':
    case 'PgChar':
    case 'PgUUID':
    case 'PgEnumColumn':
      return 'Text';
    case 'PgInteger':
    case 'PgSmallInt':
    case 'PgSerial':
    case 'PgBigInt53':
    case 'PgDoublePrecision':
    case 'PgReal':
      return 'Number';
    case 'PgBoolean':
      return 'Bool';
    case 'PgJsonb':
    case 'PgJson':
      return 'Json';
    case 'PgTimestamp':
    case 'PgDate':
      return 'Date';
    case 'PgTimestampString':
    case 'PgDateString':
      return 'DateString';
    case 'PgNumeric':
      return 'Numeric';
    case 'PgArray':
      return 'Array';
    default:
      return 'Other';
  }
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** A snapshot default as SQL. */
function defaultSql(raw: unknown, type: string): string {
  if (typeof raw === 'string') return `(${raw})::${type}`;
  return `(${JSON.stringify(raw)})::${type}`;
}

let out = `//! Generated by \`tools/entity-tables.mts\` from the Drizzle schema and tenant
//! snapshot ${latest}; don't edit. The tables the generic record steps reach
//! (\`engine/entity-tables.ts\`), with the statements they run (see
//! [\`super::EntityTable\`]).

#![allow(clippy::doc_markdown)]

use super::{Column, EntityTable, Kind};
`;

const generated = new Map<string, string>();
for (const [, exportName] of ENTITY_TABLES) {
  if (generated.has(exportName)) continue;
  const table = (schema as Record<string, unknown>)[exportName];
  if (!is(table, PgTable)) throw new Error(`${exportName} is not a table`);
  const name = getTableName(table);
  const snap = snapshot.tables[`public.${name}`];
  if (!snap) throw new Error(`${name} is not in ${latest}`);
  const sensitive = new Set<string>((SENSITIVE_COLUMNS as Record<string, readonly string[]>)[name] ?? []);
  const columns = Object.entries(getTableColumns(table)).map(([prop, column]) => {
    const c = column as unknown as { name: string; columnType: string; defaultFn?: unknown; onUpdateFn?: unknown };
    const s = snap.columns[c.name];
    if (!s) throw new Error(`${name}.${c.name} is not in ${latest}`);
    if (c.defaultFn || c.onUpdateFn) throw new Error(`${name}.${c.name} has a runtime default the generator doesn't model`);
    return { prop, name: c.name, kind: kindOf(c.columnType), type: s.type, default: s.default, selectable: !sensitive.has(prop) };
  });
  const has = (col: string) => columns.some((c) => c.name === col);
  const numeric = columns.filter((c) => c.kind === 'Numeric');
  const row = numeric.length
    ? `(to_jsonb(t) || jsonb_build_object(${numeric.map((c) => `'${c.name}', t.${quote(c.name)}::text`).join(', ')}))`
    : 'to_jsonb(t)';
  const mail = MAIL_CONDITIONS[name] ? ` and ${MAIL_CONDITIONS[name]}` : '';
  const exprs = columns.map((c) =>
    c.default === undefined
      ? `r.${quote(c.name)}`
      : `case when $1::jsonb ? '${c.name}' then r.${quote(c.name)} else ${defaultSql(c.default, c.type)} end`,
  );
  const insert =
    `insert into ${quote(name)} as t (${columns.map((c) => quote(c.name)).join(', ')}) ` +
    `select ${exprs.join(', ')} from jsonb_populate_record(null::${quote(name)}, $1::jsonb) r returning ${row}`;
  const sets = columns.map(
    (c) => `${quote(c.name)} = case when $1::jsonb ? '${c.name}' then r.${quote(c.name)} else t.${quote(c.name)} end`,
  );
  const patch =
    `update ${quote(name)} as t set ${sets.join(', ')} from jsonb_populate_record(null::${quote(name)}, $1::jsonb) r ` +
    `where t.id = $2${mail} returning ${row}`;
  // `.set({ deletedAt, updatedAt })`: Drizzle drops a key the table lacks.
  const stamps = ['deleted_at', 'updated_at'].filter(has).map((col) => `${quote(col)} = $2::timestamp`);
  const softDelete = stamps.length
    ? JSON.stringify(`update ${quote(name)} as t set ${stamps.join(', ')} where t.id = $1${mail}`)
    : 'None';
  const hardDelete = `delete from ${quote(name)} as t where t.id = $1${mail}`;
  // `isNull(table.deletedAt)` on a table without the column renders an empty
  // operand (\` is null\`), which the database refuses: `None` here.
  const query = has('deleted_at')
    ? JSON.stringify(`select ${row} from ${quote(name)} as t where t.deleted_at is null${mail} limit $1 offset $2`)
    : 'None';
  const constName = name.toUpperCase();
  generated.set(exportName, constName);
  out += `
/// \`${exportName}\` (\`${name}\`).
pub(super) const ${constName}: EntityTable = EntityTable {
    name: "${name}",
    columns: &[
${columns.map((c) => `        Column { prop: "${c.prop}", name: "${c.name}", kind: Kind::${c.kind}, selectable: ${c.selectable} },`).join('\n')}
    ],
    insert: ${JSON.stringify(insert)},
    patch: ${JSON.stringify(patch)},
    soft_delete: ${softDelete === 'None' ? 'None' : `Some(${softDelete})`},
    hard_delete: ${JSON.stringify(hardDelete)},
    query: ${query === 'None' ? 'None' : `Some(${query})`},
};
`;
}

out += `
/// \`entityTableMap\`: entity type (lowercase, \`_\` for \`-\`) → table, in the map's order.
pub(super) const ENTITY_TABLES: &[(&str, &EntityTable)] = &[
${ENTITY_TABLES.map(([entity, exportName]) => `    ("${entity}", &${generated.get(exportName)}),`).join('\n')}
];

/// \`entityIdPrefixMap\`.
pub(super) const ID_PREFIXES: &[(&str, &str)] = &[
${Object.entries(ID_PREFIXES).map(([entity, prefix]) => `    ("${entity}", "${prefix}"),`).join('\n')}
];
`;

writeFileSync(path.join(here, '../src/engine/actions/data/tables.rs'), out);
console.log(`wrote ${generated.size} tables from ${latest}`);
