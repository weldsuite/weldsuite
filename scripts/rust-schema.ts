/**
 * Write the SeaORM entities of rust/crates/schema from the Drizzle schema
 * (weldsuite-documentation plans/rust-schema-orm-and-migrations.md, phase 1).
 *
 * One module per table under rust/crates/schema/src/{tenant,master}/, plus an
 * `enums` module per database with the Postgres enums as SeaORM active enums.
 * Each entity carries:
 *   - the Rust types and serde attributes that give the row Drizzle's JSON
 *     shape (property names, `toISOString()` timestamps, `numeric` as a
 *     string), decided per column from the Drizzle column's type and mode;
 *   - `DDL`: the table's definition as the newest drizzle-kit snapshot has it
 *     (SQL types, defaults, indexes, foreign keys, checks), as static data.
 *
 * Until the flip the Drizzle schema is the source and this file is rerun after
 * every schema change; after the flip the entities are edited by hand and this
 * script goes.
 *
 *   pnpm rust:schema           write the files
 *   pnpm rust:schema --check   exit 1 when a file is missing or stale (CI)
 *
 * Materialized views are left out: their columns are SQL expressions whose
 * types Drizzle doesn't know.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFrom = createRequire(path.join(repo, 'packages/core/db/package.json'));
const load = (specifier: string) => import(pathToFileURL(requireFrom.resolve(specifier)).href);
// Loaded in main(): drizzle-orm from the schema package, so `is()` sees its classes.
/* eslint-disable @typescript-eslint/no-explicit-any */
let getTableColumns: (table: any) => Record<string, any>;
let is: (value: unknown, type: any) => boolean;
let PgTable: any;
let getTableConfig: (table: any) => any;
let isPgEnum: (value: unknown) => boolean;

const check = process.argv.includes('--check');
const outRoot = path.join(repo, 'rust/crates/schema/src');

interface Kind {
  name: 'tenant' | 'master';
  entry: string;
  snapshots: string;
}

const KINDS: Kind[] = [
  {
    name: 'tenant',
    entry: 'packages/core/db/src/schema/index.ts',
    snapshots: 'packages/core/db/drizzle/tenant-migrations/meta',
  },
  {
    name: 'master',
    entry: 'packages/core/db/src/schema/master.ts',
    snapshots: 'packages/core/db/drizzle/master-migrations/meta',
  },
];

const RUST_KEYWORDS = new Set(
  (
    'as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref ' +
    'return self Self static struct super trait true type unsafe use where while async await dyn abstract become ' +
    'box do final macro override priv typeof unsized virtual yield try gen'
  ).split(' '),
);
// Names SeaORM's derive puts in an entity module; a column or table can't use them.
const SEA_ORM_RESERVED = new Set(['entity', 'model', 'column', 'active_model', 'primary_key', 'relation']);

const pascal = (text: string) =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');

const camel = (column: string) => column.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** A snake_case Rust identifier for a SQL name. */
function ident(name: string): string {
  let out = name
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll(/[^A-Za-z0-9]+/g, '_')
    .replaceAll(/^_|_$/g, '')
    .toLowerCase();
  if (/^[0-9]/.test(out)) out = `n${out}`;
  if (RUST_KEYWORDS.has(out) || SEA_ORM_RESERVED.has(out)) out = `${out}_`;
  return out;
}

const str = (text: string) => JSON.stringify(text);

interface Snapshot {
  tables: Record<string, any>;
  enums: Record<string, { name: string; values: string[] }>;
}

function latestSnapshot(dir: string): { file: string; snapshot: Snapshot } {
  const file = readdirSync(path.join(repo, dir))
    .filter((f) => f.endsWith('_snapshot.json'))
    .sort()
    .at(-1)!;
  return { file, snapshot: JSON.parse(readFileSync(path.join(repo, dir, file), 'utf8')) };
}

interface RustColumn {
  field: string;
  column: string;
  prop: string;
  rustType: string;
  attrs: string[];
  serde: string[];
}

/** The Rust type and serde handling of one Drizzle column. */
function mapColumn(col: any, enumTypes: Map<string, string>, where: string): Omit<RustColumn, 'field' | 'column' | 'prop'> {
  const nullable = !col.notNull;
  const attrs: string[] = [];
  const serde: string[] = [];
  let rustType: string;
  let with_: string | null = null;
  switch (col.columnType) {
    case 'PgVarchar':
    case 'PgChar':
      rustType = 'String';
      attrs.push(
        col.length ? `column_type = "String(StringLen::N(${col.length}))"` : 'column_type = "String(StringLen::None)"',
      );
      break;
    case 'PgText':
      rustType = 'String';
      attrs.push('column_type = "Text"');
      break;
    case 'PgInteger':
    case 'PgSerial':
      rustType = 'i32';
      break;
    case 'PgSmallInt':
    case 'PgSmallSerial':
      rustType = 'i16';
      break;
    case 'PgBigInt53':
    case 'PgBigSerial53':
      rustType = 'i64';
      break;
    case 'PgBigInt64':
    case 'PgBigSerial64':
      // Drizzle returns a JS bigint, which JSON can't carry; the routes that
      // use these columns serialize them themselves.
      rustType = 'i64';
      with_ = 'js::bigint';
      break;
    case 'PgReal':
      rustType = 'f32';
      with_ = 'js::real';
      break;
    case 'PgDoublePrecision':
      rustType = 'f64';
      break;
    case 'PgNumeric': {
      rustType = 'BigDecimal';
      // sqlx decodes numeric without its display scale, so a declared scale
      // is applied when printing; an unconstrained numeric prints normalized.
      const scale = col.scale ?? (col.precision !== undefined ? 0 : undefined);
      attrs.push(
        col.precision !== undefined
          ? `column_type = "Decimal(Some((${col.precision}, ${scale})))"`
          : 'column_type = "Decimal(None)"',
      );
      if (scale === undefined) {
        with_ = 'js::numeric';
      } else {
        serde.push(
          `serialize_with = ${str(`crate::js::Numeric::<${scale}>::${nullable ? 'serialize_option' : 'serialize'}`)}`,
        );
      }
      break;
    }
    case 'PgNumericNumber':
      rustType = 'BigDecimal';
      with_ = 'js::numeric_number';
      break;
    case 'PgBoolean':
      rustType = 'bool';
      break;
    case 'PgJson':
      rustType = 'Json';
      attrs.push('column_type = "Json"');
      break;
    case 'PgJsonb':
      rustType = 'Json';
      attrs.push('column_type = "JsonBinary"');
      break;
    case 'PgTimestamp':
      rustType = col.withTimezone ? 'TimeDateTimeWithTimeZone' : 'TimeDateTime';
      with_ = col.withTimezone ? 'js::timestamptz' : 'js::timestamp';
      break;
    case 'PgTimestampString':
      rustType = col.withTimezone ? 'TimeDateTimeWithTimeZone' : 'TimeDateTime';
      with_ = col.withTimezone ? 'js::timestamptz_text' : 'js::timestamp_text';
      break;
    case 'PgDate':
      rustType = 'TimeDate';
      with_ = 'js::date_as_timestamp';
      break;
    case 'PgDateString':
      rustType = 'TimeDate';
      with_ = 'js::date';
      break;
    case 'PgEnumColumn': {
      const name = enumTypes.get(col.enum.enumName);
      if (!name) throw new Error(`${where}: enum ${col.enum.enumName} is not exported`);
      rustType = `super::enums::${name}`;
      break;
    }
    case 'PgVector':
      rustType = 'PgVector';
      attrs.push(`column_type = "Vector(Some(${col.dimensions}))"`);
      break;
    default:
      throw new Error(`${where}: column type ${col.columnType} has no Rust mapping yet`);
  }
  if (with_) serde.push(`with = ${str(nullable ? `crate::${with_}::option` : `crate::${with_}`)}`);
  if (nullable) rustType = `Option<${rustType}>`;
  return { rustType, attrs, serde };
}

function enumVariant(value: string, used: Set<string>): string {
  let name = pascal(value) || 'Empty';
  if (/^[0-9]/.test(name)) name = `V${name}`;
  let unique = name;
  for (let i = 2; used.has(unique); i++) unique = `${name}${i}`;
  used.add(unique);
  return unique;
}

function renderEnums(enums: Array<{ name: string; values: string[]; rust: string }>, header: string): string {
  const out = [header, '', 'use sea_orm::entity::prelude::*;', ''];
  for (const e of enums) {
    const used = new Set<string>();
    out.push(
      `/// \`${e.name}\`.`,
      '#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, EnumIter, DeriveActiveEnum, serde::Serialize)]',
      `#[sea_orm(rs_type = "String", db_type = "Enum", enum_name = ${str(e.name)})]`,
      `pub enum ${e.rust} {`,
    );
    for (const value of e.values) {
      out.push(`    #[sea_orm(string_value = ${str(value)})]`, `    #[serde(rename = ${str(value)})]`, `    ${enumVariant(value, used)},`);
    }
    out.push('}', '');
  }
  return out.join('\n');
}

/** The snapshot's table definition as `crate::ddl::Table` data. */
function renderDdl(t: any): string {
  const cols = Object.values<any>(t.columns).map(
    (c) =>
      `DdlColumn { name: ${str(c.name)}, sql_type: ${str(c.type)}, not_null: ${c.notNull}, primary_key: ${c.primaryKey}, default: ${
        c.default === undefined ? 'None' : `Some(${str(String(c.default))})`
      }, generated: ${c.generated ? `Some(${str(c.generated.as)})` : 'None'} }`,
  );
  const indexes = Object.values<any>(t.indexes ?? {}).map(
    (i) =>
      `Index { name: ${str(i.name)}, columns: &[${i.columns
        .map((c: any) => `IndexColumn { expression: ${str(c.expression)}, is_expression: ${c.isExpression}, asc: ${c.asc} }`)
        .join(', ')}], unique: ${i.isUnique}, method: ${str(i.method)}, filter: ${i.where ? `Some(${str(i.where)})` : 'None'} }`,
  );
  const fks = Object.values<any>(t.foreignKeys ?? {}).map(
    (f) =>
      `ForeignKey { name: ${str(f.name)}, columns: &[${f.columnsFrom.map(str).join(', ')}], references: ${str(
        f.tableTo,
      )}, referenced_columns: &[${f.columnsTo.map(str).join(', ')}], on_delete: ${str(f.onDelete ?? 'no action')}, on_update: ${str(
        f.onUpdate ?? 'no action',
      )} }`,
  );
  const uniques = Object.values<any>(t.uniqueConstraints ?? {}).map(
    (u) => `Unique { name: ${str(u.name)}, columns: &[${u.columns.map(str).join(', ')}], nulls_not_distinct: ${u.nullsNotDistinct} }`,
  );
  const checks = Object.values<any>(t.checkConstraints ?? {}).map((c) => `Check { name: ${str(c.name)}, expression: ${str(c.value)} }`);
  const pks = Object.values<any>(t.compositePrimaryKeys ?? {}).map(
    (p) => `DdlPrimaryKey { name: ${str(p.name)}, columns: &[${p.columns.map(str).join(', ')}] }`,
  );
  const list = (items: string[]) => (items.length ? `&[\n        ${items.join(',\n        ')},\n    ]` : '&[]');
  return [
    '/// The table as the migrations define it.',
    'pub const DDL: Table = Table {',
    `    name: ${str(t.name)},`,
    `    columns: ${list(cols)},`,
    `    primary_key: ${pks.length ? `Some(${pks[0]})` : 'None'},`,
    `    indexes: ${list(indexes)},`,
    `    foreign_keys: ${list(fks)},`,
    `    uniques: ${list(uniques)},`,
    `    checks: ${list(checks)},`,
    '};',
  ].join('\n');
}

interface Written {
  rel: string;
  text: string;
}

function generate(kind: Kind, schema: Record<string, unknown>): { files: Written[]; warnings: string[] } {
  const { file: snapshotFile, snapshot } = latestSnapshot(kind.snapshots);
  const header = `//! Generated by \`pnpm rust:schema\` (scripts/rust-schema.ts) from \`${kind.entry}\`\n//! and ${snapshotFile}; don't edit.`;
  const warnings: string[] = [];
  const files: Written[] = [];

  // Enums: Rust names by Postgres name.
  const enumTypes = new Map<string, string>();
  const enums: Array<{ name: string; values: string[]; rust: string }> = [];
  const usedEnumNames = new Set<string>();
  for (const value of Object.values(schema)) {
    if (!isPgEnum(value)) continue;
    const e = value as { enumName: string; enumValues: string[] };
    if (enumTypes.has(e.enumName)) continue;
    let rust = pascal(e.enumName);
    for (let i = 2; usedEnumNames.has(rust); i++) rust = `${pascal(e.enumName)}${i}`;
    usedEnumNames.add(rust);
    enumTypes.set(e.enumName, rust);
    enums.push({ name: e.enumName, values: [...e.enumValues], rust });
  }
  enums.sort((a, b) => a.name.localeCompare(b.name));
  files.push({ rel: `${kind.name}/enums.rs`, text: renderEnums(enums, `${header}\n//!\n//! The Postgres enums of the ${kind.name} database.`) });

  // Tables.
  const tables = new Map<string, any>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    if (config.schema && config.schema !== 'public') continue;
    if (!tables.has(config.name)) tables.set(config.name, value);
  }
  const modules: string[] = [];
  const tableNames = new Map<string, string>();
  const usedModules = new Set<string>(['enums']);
  for (const [name, table] of [...tables].sort(([a], [b]) => a.localeCompare(b))) {
    const config = getTableConfig(table);
    const snap = snapshot.tables[`public.${name}`];
    if (!snap) {
      warnings.push(`${kind.name}: table ${name} is in the schema but not in ${snapshotFile} (no migration yet); skipped`);
      continue;
    }
    let module = ident(name);
    for (let i = 2; usedModules.has(module); i++) module = `${ident(name)}_${i}`;
    usedModules.add(module);

    const props = Object.entries<any>(getTableColumns(table));
    const compositePk = new Set<string>(config.primaryKeys.flatMap((pk: any) => pk.columns.map((c: any) => c.name)));
    const hasPk = props.some(([, c]) => c.primary) || compositePk.size > 0;
    const usedFields = new Set<string>();
    const columns: RustColumn[] = props.map(([prop, col]) => {
      const where = `${kind.name}.${name}.${col.name}`;
      let field = ident(col.name);
      for (let i = 2; usedFields.has(field); i++) field = `${ident(col.name)}_${i}`;
      usedFields.add(field);
      const mapped = mapColumn(col, enumTypes, where);
      const attrs = [...mapped.attrs];
      if (field !== col.name) attrs.unshift(`column_name = ${str(col.name)}`);
      if (col.primary || compositePk.has(col.name)) attrs.unshift('primary_key', 'auto_increment = false');
      return { field, column: col.name, prop, ...mapped, attrs };
    });
    if (!hasPk) {
      warnings.push(`${kind.name}.${name}: no primary key; skipped (SeaORM needs one)`);
      continue;
    }

    const lines = [
      `${header}`,
      `//!`,
      `//! \`${name}\`.`,
      '',
      'use sea_orm::entity::prelude::*;',
      '',
      '#[allow(unused_imports)]',
      'use crate::ddl::{Check, Column as DdlColumn, ForeignKey, Index, IndexColumn, PrimaryKey as DdlPrimaryKey, Table, Unique};',
      '',
      '#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]',
      `#[sea_orm(table_name = ${str(name)})]`,
      'pub struct Model {',
    ];
    for (const c of columns) {
      if (c.attrs.length) lines.push(`    #[sea_orm(${c.attrs.join(', ')})]`);
      if (c.prop !== camel(c.column)) {
        warnings.push(`${kind.name}.${name}.${c.column}: property ${c.prop} is not the column's camelCase`);
      }
      lines.push(`    #[serde(${[`rename = ${str(c.prop)}`, ...c.serde].join(', ')})]`);
      lines.push(`    pub ${c.field}: ${c.rustType},`);
    }
    lines.push(
      '}',
      '',
      '#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]',
      'pub enum Relation {}',
      '',
      'impl ActiveModelBehavior for ActiveModel {}',
      '',
      renderDdl(snap),
      '',
    );
    files.push({ rel: `${kind.name}/${module}.rs`, text: lines.join('\n') });
    modules.push(module);
    tableNames.set(module, name);
  }

  const mod = [
    `${header}`,
    '//!',
    `//! The ${kind.name} database: one SeaORM entity per table.`,
    '',
    'pub mod enums;',
    ...modules.map((m) => `pub mod ${m};`),
    '',
    `/// Every table's definition, in name order.`,
    'pub const TABLES: &[crate::ddl::Table] = &[',
    ...modules.map((m) => `    ${m}::DDL,`),
    '];',
    '',
    '/// Every row of `table` through its entity (`Entity::find().all`), as JSON;',
    "/// `None` for a table this database doesn't have. Behind the `all-tables`",
    "/// feature: spike S7 compares it with Drizzle's rows, and S6 measures what a",
    '/// query on every entity costs to build.',
    '#[cfg(feature = "all-tables")]',
    'pub async fn rows_json<C: sea_orm::ConnectionTrait>(',
    '    db: &C,',
    '    table: &str,',
    ') -> Result<Option<Vec<serde_json::Value>>, sea_orm::DbErr> {',
    '    use sea_orm::EntityTrait;',
    '    fn json<T: serde::Serialize>(rows: Vec<T>) -> Vec<serde_json::Value> {',
    '        rows.iter().map(|row| serde_json::to_value(row).unwrap_or_default()).collect()',
    '    }',
    '    Ok(Some(match table {',
    ...modules.map((m) => `        ${str(tableNames.get(m)!)} => json(Box::pin(${m}::Entity::find().all(db)).await?),`),
    '        _ => return Ok(None),',
    '    }))',
    '}',
    '',
  ];
  files.push({ rel: `${kind.name}/mod.rs`, text: mod.join('\n') });
  return { files, warnings };
}

/** Format generated files as the workspace does (rust/rustfmt.toml). */
function rustfmt(files: string[]) {
  for (let i = 0; i < files.length; i += 100) {
    const run = spawnSync('rustfmt', ['--edition', '2024', '--config', 'max_width=100', ...files.slice(i, i + 100)], {
      stdio: 'inherit',
    });
    if (run.status !== 0) throw new Error('rustfmt failed');
  }
}

async function main() {
  ({ getTableColumns, is } = await load('drizzle-orm'));
  ({ PgTable, getTableConfig, isPgEnum } = await load('drizzle-orm/pg-core'));
  // A checkout with core.autocrlf has CRLF files; compare text, not bytes.
  const read = (file: string) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
  let stale = 0;
  const allWarnings: string[] = [];
  for (const kind of KINDS) {
    const schema = await import(pathToFileURL(path.join(repo, kind.entry)).href);
    const { files, warnings } = generate(kind, schema);
    allWarnings.push(...warnings);
    const dir = path.join(outRoot, kind.name);
    const wanted = new Set(files.map((f) => path.join(outRoot, f.rel)));
    if (check) {
      const scratch = mkdtempSync(path.join(tmpdir(), 'rust-schema-'));
      mkdirSync(path.join(scratch, kind.name));
      for (const f of files) writeFileSync(path.join(scratch, f.rel), f.text);
      rustfmt(files.map((f) => path.join(scratch, f.rel)));
      for (const f of files) {
        const target = path.join(outRoot, f.rel);
        if (!existsSync(target) || read(target) !== read(path.join(scratch, f.rel))) {
          console.error(`stale: rust/crates/schema/src/${f.rel}`);
          stale++;
        }
      }
      for (const f of existsSync(dir) ? readdirSync(dir) : []) {
        if (!wanted.has(path.join(dir, f))) {
          console.error(`stale: rust/crates/schema/src/${kind.name}/${f} (no such table)`);
          stale++;
        }
      }
      rmSync(scratch, { recursive: true, force: true });
      continue;
    }
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) if (!wanted.has(path.join(dir, f))) rmSync(path.join(dir, f));
    }
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(path.join(outRoot, f.rel), f.text);
    rustfmt(files.map((f) => path.join(outRoot, f.rel)));
    console.log(`${kind.name}: ${files.length - 2} tables, enums and mod.rs written`);
  }
  for (const w of allWarnings) console.warn(`warning: ${w}`);
  if (check && stale) {
    console.error(`${stale} file(s) stale: run pnpm rust:schema`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
