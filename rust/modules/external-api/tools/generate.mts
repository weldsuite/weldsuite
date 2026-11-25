/**
 * Generates rust/modules/external-api/src/schemas_gen.rs and src/tables_gen.rs:
 *
 * - every Zod schema the public API's /v1 routes validate with, as a `Z` tree
 *   (`src/zod.rs`); what a schema computes in JavaScript (`.refine`,
 *   `.transform`, `z.preprocess`) becomes a call to a hook in `src/hooks.rs`
 *   named after the schema and the field, which must be written by hand;
 * - the tenant tables the routes write, as Drizzle sees them (property →
 *   column, kind), each with its SeaORM entity, whose statements write a
 *   `{ column: value }` JSON object the way Drizzle's insert would
 *   (`weldsuite_db::record`, see `src/table.rs`): a column the body leaves out
 *   gets its database default, one it sets to null gets NULL. The entity's
 *   columns a table never reads (`selectableColumns`) are listed as omitted.
 *
 *   pnpm --filter external-api exec tsx ../../../rust/modules/external-api/tools/generate.mts
 *
 * Commit the output.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OMIT_SENSITIVE, SCHEMAS, TABLES } from './inventory.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');

// Packages resolve from external-api, which depends on all of them.
const requireFrom = createRequire(path.join(repo, 'apps/workers/external-api/package.json'));
const load = (specifier: string) => import(pathToFileURL(requireFrom.resolve(specifier)).href);
const { getTableColumns, getTableName, is } = await load('drizzle-orm');
const { PgTable } = await load('drizzle-orm/pg-core');
const schema = await load('@weldsuite/db/schema');
const { selectableColumns } = await load('@weldsuite/db/lib/sensitive-columns');
const zod = await load('zod');

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const hooks: string[] = [];
const warnings: string[] = [];

const rustStr = (text: string) => JSON.stringify(text);
const msg = (message: unknown) => (typeof message === 'string' ? `Some(${rustStr(message)})` : 'None');
const num = (n: number) => (Number.isInteger(n) ? `${n}.0` : String(n));
const snake = (text: string) =>
  text
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll(/[^A-Za-z0-9]+/g, '_')
    .replaceAll(/^_|_$/g, '')
    .toLowerCase();

function stringChecks(checks: any[], where: string): string {
  const out: string[] = [];
  for (const c of checks) {
    switch (c.kind) {
      case 'min':
        out.push(`S::Min(${c.value}, ${msg(c.message)})`);
        break;
      case 'max':
        out.push(`S::Max(${c.value}, ${msg(c.message)})`);
        break;
      case 'length':
        out.push(`S::Len(${c.value}, ${msg(c.message)})`);
        break;
      case 'email':
        out.push(`S::Email(${msg(c.message)})`);
        break;
      case 'url':
        out.push(`S::Url(${msg(c.message)})`);
        break;
      case 'uuid':
        out.push(`S::Uuid(${msg(c.message)})`);
        break;
      case 'datetime':
        if (c.precision != null || c.local) warnings.push(`${where}: datetime precision/local not supported`);
        out.push(`S::Datetime { offset: ${!!c.offset}, msg: ${msg(c.message)} }`);
        break;
      case 'regex': {
        const re = c.regex as RegExp;
        const flags = re.flags.includes('i') ? '(?i)' : '';
        out.push(`S::Regex(${rustStr(flags + re.source)}, ${msg(c.message)})`);
        break;
      }
      case 'startsWith':
        out.push(`S::StartsWith(${rustStr(c.value)}, ${msg(c.message)})`);
        break;
      case 'endsWith':
        out.push(`S::EndsWith(${rustStr(c.value)}, ${msg(c.message)})`);
        break;
      case 'trim':
        out.push('S::Trim');
        break;
      case 'toLowerCase':
        out.push('S::Lower');
        break;
      case 'toUpperCase':
        out.push('S::Upper');
        break;
      default:
        warnings.push(`${where}: string check ${c.kind} not supported`);
        out.push(`compile_error!("${where}: string check ${c.kind}")`);
    }
  }
  return `&[${out.join(', ')}]`;
}

function numberChecks(checks: any[], where: string): string {
  const out: string[] = [];
  for (const c of checks) {
    switch (c.kind) {
      case 'int':
        out.push(`N::Int(${msg(c.message)})`);
        break;
      case 'min':
        out.push(`N::Min(${num(c.value)}, ${!!c.inclusive}, ${msg(c.message)})`);
        break;
      case 'max':
        out.push(`N::Max(${num(c.value)}, ${!!c.inclusive}, ${msg(c.message)})`);
        break;
      case 'finite':
        out.push(`N::Finite(${msg(c.message)})`);
        break;
      default:
        warnings.push(`${where}: number check ${c.kind} not supported`);
        out.push(`compile_error!("${where}: number check ${c.kind}")`);
    }
  }
  return `&[${out.join(', ')}]`;
}

/** A Zod schema as a Rust `Z` expression. `name` names hooks. */
function emit(s: any, name: string): string {
  const def = s?._def;
  if (!def) return `compile_error!("${name}: not a Zod schema")`;
  if (def.errorMap && !def.coerce && !['ZodEffects', 'ZodOptional', 'ZodNullable', 'ZodDefault', 'ZodObject'].includes(def.typeName)) {
    warnings.push(`${name}: ${def.typeName} has an errorMap (a custom message): check by hand`);
  }
  switch (def.typeName) {
    case 'ZodString':
      return `Z::${def.coerce ? 'CoerceStr' : 'Str'}(${stringChecks(def.checks ?? [], name)})`;
    case 'ZodNumber':
      return `Z::${def.coerce ? 'CoerceNum' : 'Num'}(${numberChecks(def.checks ?? [], name)})`;
    case 'ZodBoolean':
      return def.coerce ? 'Z::CoerceBool' : 'Z::Bool';
    case 'ZodDate':
      if ((def.checks ?? []).length) warnings.push(`${name}: date checks not supported`);
      return def.coerce ? 'Z::CoerceDate' : 'Z::Date';
    case 'ZodEnum':
      return `Z::Enum(&[${(def.values as string[]).map(rustStr).join(', ')}], None)`;
    case 'ZodNativeEnum': {
      const values = Object.values(def.values).filter((v) => typeof v === 'string') as string[];
      return `Z::Enum(&[${values.map(rustStr).join(', ')}], None)`;
    }
    case 'ZodLiteral': {
      const v = def.value;
      if (typeof v === 'string') return `Z::Lit(Lit::Str(${rustStr(v)}))`;
      if (typeof v === 'number') return `Z::Lit(Lit::Num(${num(v)}))`;
      if (typeof v === 'boolean') return `Z::Lit(Lit::Bool(${v}))`;
      return `compile_error!("${name}: literal ${String(v)}")`;
    }
    case 'ZodAny':
    case 'ZodUnknown':
      return 'Z::Any';
    case 'ZodNull':
      return 'Z::Null';
    case 'ZodArray': {
      const min = def.exactLength ?? def.minLength;
      if (def.exactLength) warnings.push(`${name}: exact array length treated as min`);
      const bound = (b: any) => (b ? `Some((${b.value}, ${msg(b.message)}))` : 'None');
      return `Z::Arr(&${emit(def.type, `${name}_item`)}, ${bound(min)}, ${bound(def.maxLength)})`;
    }
    case 'ZodRecord':
      return `Z::Rec(&${emit(def.valueType, `${name}_value`)})`;
    case 'ZodObject': {
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
      const catchall = def.catchall?._def?.typeName;
      if (catchall && catchall !== 'ZodNever') warnings.push(`${name}: catchall not supported`);
      const keys = def.unknownKeys === 'passthrough' ? 'Passthrough' : def.unknownKeys === 'strict' ? 'Strict' : 'Strip';
      const fields = Object.keys(shape).map((k) => `(${rustStr(k)}, ${emit(shape[k], `${name}_${k}`)})`);
      return `Z::Obj(&[${fields.join(', ')}], Keys::${keys})`;
    }
    case 'ZodUnion': {
      const options = def.options as any[];
      return `Z::Union(&[${options.map((o, i) => emit(o, `${name}_or${i}`)).join(', ')}])`;
    }
    case 'ZodDiscriminatedUnion': {
      const options = (def.options instanceof Map ? [...def.options.values()] : def.options) as any[];
      return `Z::Disc(${rustStr(def.discriminator)}, &[${options.map((o, i) => emit(o, `${name}_or${i}`)).join(', ')}])`;
    }
    case 'ZodOptional':
      return `Z::Opt(&${emit(def.innerType, name)})`;
    case 'ZodNullable':
      return `Z::Nul(&${emit(def.innerType, name)})`;
    case 'ZodDefault':
      return `Z::Def(&${emit(def.innerType, name)}, ${rustStr(JSON.stringify(def.defaultValue()))})`;
    case 'ZodBranded':
    case 'ZodReadonly':
      return emit(def.innerType ?? def.type, name);
    case 'ZodEffects': {
      const effect = def.effect;
      const hook = `${effect.type === "refinement" ? "refine" : effect.type}_${snake(name)}`;
      if (effect.type === 'refinement') {
        hooks.push(`refine ${hook}`);
        return `Z::Refine(&${emit(def.schema, name)}, hooks::${hook})`;
      }
      if (effect.type === 'transform') {
        hooks.push(`transform ${hook}: ${String(effect.transform).replaceAll(/s+/g, " ").slice(0, 300)}`);
        return `Z::Transform(&${emit(def.schema, name)}, hooks::${hook})`;
      }
      if (effect.type === 'preprocess') {
        hooks.push(`preprocess ${hook}: ${String(effect.transform).replaceAll(/s+/g, " ").slice(0, 300)}`);
        return `Z::Pre(hooks::${hook}, &${emit(def.schema, name)})`;
      }
      return `compile_error!("${name}: effect ${effect.type}")`;
    }
    default:
      warnings.push(`${name}: ${def.typeName} not supported`);
      return `compile_error!("${name}: ${def.typeName}")`;
  }
}

let schemasOut = `//! Generated by \`tools/generate.mts\` from the client packages' Zod
//! schemas; don't edit. Each schema as a [\`Z\`] tree; what it computes in
//! JavaScript is a hook in [\`crate::hooks\`].

#![allow(clippy::doc_markdown, clippy::too_many_lines, dead_code)]

use crate::hooks;
use crate::zod::{Keys, Lit, N, S, Z};
`;

for (const entry of SCHEMAS) {
  const mod = await load(entry.from);
  const exported = mod[entry.export];
  const stripped = entry.strip ? exported?.strip() : exported;
  const zodSchema = entry.derive && stripped ? entry.derive(stripped, zod) : stripped;
  if (!zodSchema) throw new Error(`${entry.from} has no export ${entry.export}`);
  const expr = emit(zodSchema, entry.name.toLowerCase());
  schemasOut += `\n/// \`${entry.export}\` (\`${entry.from}\`).\npub(crate) const ${entry.name}: Z = ${expr};\n`;
}

writeFileSync(path.join(here, '../src/schemas_gen.rs'), schemasOut);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

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

let tablesOut = `//! Generated by \`tools/generate.mts\` from the Drizzle schema; don't edit.
//! The tables the public API writes: Drizzle's properties and kinds, and the
//! entity whose statements write a \`{ column: value }\` object as Drizzle
//! would (see [\`crate::table\`]).

#![allow(clippy::doc_markdown, clippy::too_many_lines, dead_code)]

use crate::table::{Column, Delete, Kind, Table};
use weldsuite_db::record::JsonTable;
use weldsuite_schema::tenant;
`;

const constNames: string[] = [];

for (const exportName of TABLES) {
  const table = (schema as Record<string, unknown>)[exportName];
  if (!is(table, PgTable)) throw new Error(`${exportName} is not a table`);
  const name = getTableName(table);
  const all = getTableColumns(table) as Record<string, unknown>;
  const readable = OMIT_SENSITIVE.has(exportName) ? (selectableColumns(name, all) ?? all) : all;
  const columnName = (column: unknown) => (column as { name: string }).name;
  const readableNames = new Set(Object.values(readable).map(columnName));
  const omitted = Object.values(all)
    .map(columnName)
    .filter((column) => !readableNames.has(column));
  const columns = Object.entries(readable).map(([prop, column]) => {
    const c = column as unknown as { name: string; columnType: string; defaultFn?: unknown; onUpdateFn?: unknown };
    return {
      prop,
      name: c.name,
      kind: kindOf(c.columnType),
      defaultFn: !!c.defaultFn,
      onUpdate: !!c.onUpdateFn,
    };
  });
  const hasDeleted = columns.some((c) => c.name === 'deleted_at');
  const constName = name.toUpperCase();
  constNames.push(constName);
  tablesOut += `
/// \`${exportName}\` (\`${name}\`).
pub(crate) const ${constName}: Table = Table {
    name: "${name}",
    entity: JsonTable::of::<tenant::${name}::Entity>(),
    delete: Delete::of::<tenant::${name}::Entity>(),
    columns: &[
${columns.map((c) => `        Column { prop: "${c.prop}", name: "${c.name}", kind: Kind::${c.kind}, default_fn: ${c.defaultFn}, on_update: ${c.onUpdate} },`).join('\n')}
    ],
    omitted: &[${omitted.map((c) => JSON.stringify(c)).join(', ')}],
    soft_delete: ${hasDeleted},
};
`;
}

tablesOut += `
/// Every table above, for the test that holds each to its entity.
pub(crate) const ALL: &[&Table] = &[
${constNames.map((n) => `    &${n},`).join('\n')}
];
`;

writeFileSync(path.join(here, '../src/tables_gen.rs'), tablesOut);

console.log(`wrote ${SCHEMAS.length} schemas and ${TABLES.length} tables`);
if (warnings.length) console.log(`\nWARNINGS:\n${warnings.join('\n')}`);
if (hooks.length) console.log(`\nHOOKS (write each in src/hooks.rs):\n${hooks.join('\n')}`);
