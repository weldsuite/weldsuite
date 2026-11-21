/**
 * Write the SeaORM entities of rust/crates/schema from the Drizzle schema
 * (weldsuite-documentation plans/rust-schema-orm-and-migrations.md, phase 1).
 *
 * One module per table under rust/crates/schema/src/{tenant,master}/, plus
 * per database an `enums` module (the Postgres enums as SeaORM active enums)
 * and a `views` module (the materialized views, which have no entity: their
 * columns are SQL expressions). Each entity carries:
 *   - the Rust types and serde attributes that give the row Drizzle's JSON
 *     shape (property names, `toISOString()` timestamps, `numeric` as a
 *     string), decided per column from the Drizzle column's type and mode;
 *   - `DDL`: what the entity can't say about the table, from the newest
 *     drizzle-kit snapshot: defaults, generated columns, indexes, foreign
 *     keys, checks, and a column's SQL type only where the snapshot spells it
 *     differently from what the entity's column type renders to.
 *
 * Entity and DDL together rebuild that snapshot exactly
 * (`<kind>::snapshot()`, checked by rust/crates/schema/tests/snapshot.rs).
 *
 * Until the flip the Drizzle schema is the source and this file is rerun after
 * every schema change; after the flip the entities are edited by hand and this
 * script goes.
 *
 *   pnpm rust:schema           write the files
 *   pnpm rust:schema --check   exit 1 when a file is missing or stale (CI)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* eslint-disable @typescript-eslint/no-explicit-any */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFrom = createRequire(path.join(repo, 'packages/core/db/package.json'));
const load = (specifier: string) => import(pathToFileURL(requireFrom.resolve(specifier)).href);

/** drizzle-orm, loaded from the schema package in main() so `is()` sees its classes. */
interface Drizzle {
  getTableColumns: (table: any) => Record<string, any>;
  is: (value: unknown, type: any) => boolean;
  PgTable: any;
  getTableConfig: (table: any) => any;
  isPgEnum: (value: unknown) => boolean;
}

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
    .split(/[^A-Za-z\d]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');

const camel = (column: string) => column.replace(/_([a-z\d])/g, (_, c: string) => c.toUpperCase());

/** A snake_case Rust identifier for a SQL name. */
function ident(name: string): string {
  let out = name
    .replaceAll(/([a-z\d])([A-Z])/g, '$1_$2')
    .replaceAll(/[^A-Za-z\d]+/g, '_')
    .replaceAll(/^_|_$/g, '')
    .toLowerCase();
  if (/^\d/.test(out)) out = `n${out}`;
  if (RUST_KEYWORDS.has(out) || SEA_ORM_RESERVED.has(out)) out = `${out}_`;
  return out;
}

const str = (text: string) => JSON.stringify(text);

/** `base`, or `suffixed(2)`, `suffixed(3)`, … until one isn't in `used`; then it is. */
function uniqueName(base: string, used: Set<string>, suffixed: (i: number) => string): string {
  let name = base;
  let i = 2;
  while (used.has(name)) {
    name = suffixed(i);
    i += 1;
  }
  used.add(name);
  return name;
}

interface Snapshot {
  tables: Record<string, any>;
  enums: Record<string, { name: string; values: string[] }>;
  views?: Record<string, any>;
}

function latestSnapshot(dir: string): { file: string; snapshot: Snapshot } {
  const file = readdirSync(path.join(repo, dir))
    .filter((f) => f.endsWith('_snapshot.json'))
    .sort()
    .at(-1)!;
  return { file, snapshot: JSON.parse(readFileSync(path.join(repo, dir, file), 'utf8')) };
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

interface RustColumn {
  field: string;
  column: string;
  prop: string;
  rustType: string;
  attrs: string[];
  serde: string[];
  /** The SQL type `snapshot::sql_type` renders from the entity's column type. */
  renderedSqlType: string;
  /** Drizzle's `$defaultFn` and `$onUpdate`: filled by the application. */
  defaultFn: boolean;
  onUpdate: boolean;
}

/** A column's Rust type, its `#[sea_orm]` attributes, extra serde attributes and `js` serializer. */
interface Mapping {
  rustType: string;
  attrs: string[];
  serde: string[];
  js?: string;
}

const plain = (rustType: string, attrs: string[] = [], js?: string): Mapping => ({ rustType, attrs, serde: [], js });

const varchar = (col: any): Mapping => {
  const length = col.length ? `StringLen::N(${col.length})` : 'StringLen::None';
  return plain('String', [`column_type = "String(${length})"`]);
};

/** sqlx decodes numeric without its display scale, so a declared scale is applied when printing; an unconstrained numeric prints normalized. */
const numeric = (col: any, nullable: boolean): Mapping => {
  const scale = col.scale ?? (col.precision === undefined ? undefined : 0);
  const columnType = col.precision === undefined ? 'Decimal(None)' : `Decimal(Some((${col.precision}, ${scale})))`;
  const attrs = [`column_type = "${columnType}"`];
  if (scale === undefined) return plain('BigDecimal', attrs, 'js::numeric');
  const method = nullable ? 'serialize_option' : 'serialize';
  const serializer = `crate::js::Numeric::<${scale}>::${method}`;
  return { rustType: 'BigDecimal', attrs, serde: [`serialize_with = ${str(serializer)}`] };
};

const timestampType = (col: any) => (col.withTimezone ? 'TimeDateTimeWithTimeZone' : 'TimeDateTime');

// Drizzle returns a JS bigint for `mode: 'bigint'`, which JSON can't carry; the
// routes that use these columns serialize them themselves.
const MAPPERS: Record<string, (col: any, nullable: boolean) => Mapping> = {
  PgVarchar: varchar,
  PgChar: varchar,
  PgText: () => plain('String', ['column_type = "Text"']),
  PgInteger: () => plain('i32'),
  PgSerial: () => plain('i32'),
  PgSmallInt: () => plain('i16'),
  PgSmallSerial: () => plain('i16'),
  PgBigInt53: () => plain('i64'),
  PgBigSerial53: () => plain('i64'),
  PgBigInt64: () => plain('i64', [], 'js::bigint'),
  PgBigSerial64: () => plain('i64', [], 'js::bigint'),
  PgReal: () => plain('f32', [], 'js::real'),
  PgDoublePrecision: () => plain('f64'),
  PgNumeric: numeric,
  PgNumericNumber: (col) => ({ ...numeric(col, false), serde: [], js: 'js::numeric_number' }),
  PgBoolean: () => plain('bool'),
  PgJson: () => plain('Json', ['column_type = "Json"']),
  PgJsonb: () => plain('Json', ['column_type = "JsonBinary"']),
  PgTimestamp: (col) => plain(timestampType(col), [], col.withTimezone ? 'js::timestamptz' : 'js::timestamp'),
  PgTimestampString: (col) =>
    plain(timestampType(col), [], col.withTimezone ? 'js::timestamptz_text' : 'js::timestamp_text'),
  PgDate: () => plain('TimeDate', [], 'js::date_as_timestamp'),
  PgDateString: () => plain('TimeDate', [], 'js::date'),
  PgVector: (col) => plain('PgVector', [`column_type = "Vector(Some(${col.dimensions}))"`]),
};

const numericSqlType = (col: any) =>
  col.precision === undefined ? 'numeric' : `numeric(${col.precision}, ${col.scale ?? 0})`;
const timestampSqlType = (col: any) => (col.withTimezone ? 'timestamp with time zone' : 'timestamp');
const varcharSqlType = (col: any) => (col.length ? `varchar(${col.length})` : 'varchar');

/**
 * What `snapshot::sql_type` (rust/crates/schema/src/snapshot.rs) renders for
 * the column type each mapping gives the entity, explicit or inferred by
 * SeaORM from the Rust type. Where drizzle-kit's snapshot spells a column's
 * type differently, the entity's DDL carries the snapshot's spelling.
 */
const RENDERED_SQL_TYPES: Record<string, (col: any) => string> = {
  PgVarchar: varcharSqlType,
  PgChar: varcharSqlType,
  PgText: () => 'text',
  PgInteger: () => 'integer',
  PgSerial: () => 'integer',
  PgSmallInt: () => 'smallint',
  PgSmallSerial: () => 'smallint',
  PgBigInt53: () => 'bigint',
  PgBigSerial53: () => 'bigint',
  PgBigInt64: () => 'bigint',
  PgBigSerial64: () => 'bigint',
  PgReal: () => 'real',
  PgDoublePrecision: () => 'double precision',
  PgNumeric: numericSqlType,
  PgNumericNumber: numericSqlType,
  PgBoolean: () => 'boolean',
  PgJson: () => 'json',
  PgJsonb: () => 'jsonb',
  PgTimestamp: timestampSqlType,
  PgTimestampString: timestampSqlType,
  PgDate: () => 'date',
  PgDateString: () => 'date',
  PgEnumColumn: (col) => col.enum.enumName,
  PgVector: (col) => `vector(${col.dimensions})`,
};

/** `crate::js::<module>`, or its `option` twin for a nullable column. */
const jsPath = (module: string, nullable: boolean) => (nullable ? `crate::${module}::option` : `crate::${module}`);

/** The Rust type and serde handling of one Drizzle column. */
function mapColumn(col: any, enumTypes: Map<string, string>, where: string): Omit<RustColumn, 'field' | 'column' | 'prop'> {
  const nullable = !col.notNull;
  let mapping: Mapping | undefined;
  if (col.columnType === 'PgEnumColumn') {
    const name = enumTypes.get(col.enum.enumName);
    if (!name) throw new Error(`${where}: enum ${col.enum.enumName} is not exported`);
    mapping = plain(`super::enums::${name}`);
  } else {
    mapping = MAPPERS[col.columnType]?.(col, nullable);
  }
  if (!mapping) throw new Error(`${where}: column type ${col.columnType} has no Rust mapping yet`);
  const serde = [...mapping.serde];
  if (mapping.js) serde.push(`with = ${str(jsPath(mapping.js, nullable))}`);
  const rustType = nullable ? `Option<${mapping.rustType}>` : mapping.rustType;
  return { rustType, attrs: mapping.attrs, serde };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface EnumDef {
  name: string;
  values: string[];
  rust: string;
}

function enumVariant(value: string, used: Set<string>): string {
  let name = pascal(value) || 'Empty';
  if (/^\d/.test(name)) name = `V${name}`;
  return uniqueName(name, used, (i) => `${name}${i}`);
}

function renderEnum(e: EnumDef): string[] {
  const used = new Set<string>();
  const variants = e.values.flatMap((value) => [
    `    #[sea_orm(string_value = ${str(value)})]`,
    `    #[serde(rename = ${str(value)})]`,
    `    ${enumVariant(value, used)},`,
  ]);
  return [
    `/// \`${e.name}\`.`,
    '#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, EnumIter, DeriveActiveEnum, serde::Serialize)]',
    `#[sea_orm(rs_type = "String", db_type = "Enum", enum_name = ${str(e.name)})]`,
    `pub enum ${e.rust} {`,
    ...variants,
    '}',
    '',
  ];
}

function renderEnums(enums: EnumDef[], header: string): string {
  return [
    header,
    '',
    'use sea_orm::entity::prelude::*;',
    '',
    ...enums.flatMap(renderEnum),
    "/// Every enum of the database, for the snapshot.",
    'pub fn all() -> Vec<crate::snapshot::EnumSchema> {',
    '    vec![',
    ...enums.map((e) => `        crate::snapshot::enum_schema::<${e.rust}>(),`),
    '    ]',
    '}',
    '',
  ].join('\n');
}

function renderView(name: string, view: any): string[] {
  return [
    '    View {',
    `        name: ${str(name)},`,
    `        definition: ${str(view.definition)},`,
    `        materialized: ${Boolean(view.materialized)},`,
    `        with_no_data: ${Boolean(view.withNoData)},`,
    `        columns_json: ${str(JSON.stringify(view.columns ?? {}))},`,
    '    },',
  ];
}

/** The snapshot's (materialized) views as `crate::ddl::View` data. */
function renderViews(header: string, kind: Kind, views: Record<string, any>): string {
  const entries = Object.values<any>(views).sort((a, b) => a.name.localeCompare(b.name));
  for (const view of entries) {
    if (view.isExisting || view.with || view.using || view.tablespace) {
      throw new Error(`${kind.name}: view ${view.name} uses options the generator doesn't carry yet`);
    }
  }
  return [
    header,
    '//!',
    `//! The ${kind.name} database's views. They have no entity: their columns are`,
    '//! query expressions, typed by the database.',
    '',
    '#[allow(unused_imports)]',
    'use crate::ddl::View;',
    '',
    '/// Every view, in name order.',
    'pub const VIEWS: &[View] = &[',
    ...entries.flatMap((view) => renderView(view.name, view)),
    '];',
    '',
  ].join('\n');
}

const strList = (items: string[]) => items.map(str).join(', ');
const some = (value: string) => `Some(${str(value)})`;

/** A snapshot default as `DdlDefault`: SQL text, or a number or boolean literal. */
function ddlDefault(value: unknown, where: string): string {
  if (typeof value === 'boolean') return `Some(DdlDefault::Bool(${value}))`;
  if (typeof value === 'number') return `Some(DdlDefault::Number(${str(String(value))}))`;
  if (typeof value === 'string') return `Some(DdlDefault::Sql(${str(value)}))`;
  throw new Error(`${where}: a default of type ${typeof value} has no DdlDefault yet`);
}

/**
 * The snapshot column's DDL beyond the entity field, or `null` when there is
 * none: a default, a generated expression, application-filled values, or the
 * snapshot's own spelling of the type where the entity renders it otherwise.
 */
function ddlColumn(c: any, column: RustColumn | undefined): string | null {
  const sqlType = column && c.type !== column.renderedSqlType ? some(c.type) : 'None';
  const fallback = c.default === undefined ? 'None' : ddlDefault(c.default, `column ${c.name}`);
  const generated = c.generated ? some(c.generated.as) : 'None';
  const defaultFn = column?.defaultFn ?? false;
  const onUpdate = column?.onUpdate ?? false;
  const nothing = sqlType === 'None' && fallback === 'None' && generated === 'None' && !defaultFn && !onUpdate;
  if (nothing) return null;
  return `DdlColumn { name: ${str(c.name)}, sql_type: ${sqlType}, default: ${fallback}, generated: ${generated}, default_fn: ${defaultFn}, on_update: ${onUpdate} }`;
}

function ddlIndexColumn(c: any): string {
  return `IndexColumn { expression: ${str(c.expression)}, is_expression: ${c.isExpression}, asc: ${c.asc} }`;
}

function ddlIndex(i: any): string {
  const columns = i.columns.map(ddlIndexColumn).join(', ');
  const filter = i.where ? some(i.where) : 'None';
  return `Index { name: ${str(i.name)}, columns: &[${columns}], unique: ${i.isUnique}, method: ${str(i.method)}, filter: ${filter} }`;
}

function ddlForeignKey(f: any): string {
  const onDelete = str(f.onDelete ?? 'no action');
  const onUpdate = str(f.onUpdate ?? 'no action');
  return `ForeignKey { name: ${str(f.name)}, columns: &[${strList(f.columnsFrom)}], references: ${str(f.tableTo)}, referenced_columns: &[${strList(f.columnsTo)}], on_delete: ${onDelete}, on_update: ${onUpdate} }`;
}

function ddlUnique(u: any): string {
  return `Unique { name: ${str(u.name)}, columns: &[${strList(u.columns)}], nulls_not_distinct: ${u.nullsNotDistinct} }`;
}

function ddlCheck(c: any): string {
  return `Check { name: ${str(c.name)}, expression: ${str(c.value)} }`;
}

function ddlPrimaryKey(p: any): string {
  return `DdlPrimaryKey { name: ${str(p.name)}, columns: &[${strList(p.columns)}] }`;
}

function ddlList(items: string[]): string {
  if (!items.length) return '&[]';
  const body = items.join(',\n        ');
  return `&[\n        ${body},\n    ]`;
}

/** The snapshot's table definition, less what the entity says, as `crate::ddl::Table` data. */
function renderDdl(t: any, columns: RustColumn[]): string {
  const pks = Object.values<any>(t.compositePrimaryKeys ?? {}).map(ddlPrimaryKey);
  const primaryKey = pks.length ? `Some(${pks[0]})` : 'None';
  const byName = new Map(columns.map((c) => [c.column, c]));
  const extras = Object.values<any>(t.columns)
    .map((c) => ddlColumn(c, byName.get(c.name)))
    .filter((line): line is string => line !== null);
  return [
    "/// What the entity doesn't say about the table: defaults, indexes, constraints.",
    'pub const DDL: Table = Table {',
    `    name: ${str(t.name)},`,
    `    columns: ${ddlList(extras)},`,
    `    primary_key: ${primaryKey},`,
    `    indexes: ${ddlList(Object.values<any>(t.indexes ?? {}).map(ddlIndex))},`,
    `    foreign_keys: ${ddlList(Object.values<any>(t.foreignKeys ?? {}).map(ddlForeignKey))},`,
    `    uniques: ${ddlList(Object.values<any>(t.uniqueConstraints ?? {}).map(ddlUnique))},`,
    `    checks: ${ddlList(Object.values<any>(t.checkConstraints ?? {}).map(ddlCheck))},`,
    '};',
  ].join('\n');
}

function renderField(c: RustColumn): string[] {
  const attrs = c.attrs.length ? [`    #[sea_orm(${c.attrs.join(', ')})]`] : [];
  const serde = [`rename = ${str(c.prop)}`, ...c.serde].join(', ');
  return [...attrs, `    #[serde(${serde})]`, `    pub ${c.field}: ${c.rustType},`];
}

function renderEntity(header: string, name: string, columns: RustColumn[], snap: any): string {
  return [
    header,
    '//!',
    `//! \`${name}\`.`,
    '',
    'use sea_orm::entity::prelude::*;',
    '',
    '#[allow(unused_imports)]',
    'use crate::ddl::{Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn, PrimaryKey as DdlPrimaryKey, Table, Unique};',
    '',
    '#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]',
    `#[sea_orm(table_name = ${str(name)})]`,
    'pub struct Model {',
    ...columns.flatMap(renderField),
    '}',
    '',
    '#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]',
    'pub enum Relation {}',
    '',
    'impl ActiveModelBehavior for ActiveModel {}',
    '',
    renderDdl(snap, columns),
    '',
  ].join('\n');
}

function renderMod(header: string, kind: Kind, modules: Array<{ module: string; table: string }>): string {
  return [
    header,
    '//!',
    `//! The ${kind.name} database: one SeaORM entity per table.`,
    '',
    'pub mod enums;',
    'pub mod views;',
    ...modules.map(({ module }) => `pub mod ${module};`),
    '',
    '/// Every table, from its entity and its DDL, in name order.',
    'pub fn tables() -> Vec<crate::snapshot::TableSchema> {',
    '    vec![',
    ...modules.map(({ module }) => `        crate::snapshot::table::<${module}::Entity>(&${module}::DDL),`),
    '    ]',
    '}',
    '',
    "/// The database's schema as a drizzle-kit snapshot, without `id` and `prevId`.",
    'pub fn snapshot() -> serde_json::Value {',
    '    crate::snapshot::snapshot(&tables(), &enums::all(), views::VIEWS)',
    '}',
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
    ...modules.map(
      ({ module, table }) => `        ${str(table)} => json(Box::pin(${module}::Entity::find().all(db)).await?),`,
    ),
    '        _ => return Ok(None),',
    '    }))',
    '}',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

interface Written {
  rel: string;
  text: string;
}

/** The schema's Postgres enums, by name, with a unique Rust name each. */
function collectEnums(drizzle: Drizzle, schema: Record<string, unknown>): { enumTypes: Map<string, string>; enums: EnumDef[] } {
  const enumTypes = new Map<string, string>();
  const enums: EnumDef[] = [];
  const used = new Set<string>();
  const pgEnums = Object.values(schema).filter(drizzle.isPgEnum) as Array<{ enumName: string; enumValues: string[] }>;
  for (const e of pgEnums) {
    if (enumTypes.has(e.enumName)) continue;
    const base = pascal(e.enumName);
    const rust = uniqueName(base, used, (i) => `${base}${i}`);
    enumTypes.set(e.enumName, rust);
    enums.push({ name: e.enumName, values: [...e.enumValues], rust });
  }
  enums.sort((a, b) => a.name.localeCompare(b.name));
  return { enumTypes, enums };
}

/** The schema's tables in the `public` schema, by name, in name order. */
function collectTables(drizzle: Drizzle, schema: Record<string, unknown>): Array<[string, any]> {
  const tables = new Map<string, any>();
  for (const value of Object.values(schema)) {
    if (!drizzle.is(value, drizzle.PgTable)) continue;
    const config = drizzle.getTableConfig(value);
    const isPublic = !config.schema || config.schema === 'public';
    if (isPublic && !tables.has(config.name)) tables.set(config.name, value);
  }
  return [...tables].sort(([a], [b]) => a.localeCompare(b));
}

/** One table's columns as Rust fields; `null` when SeaORM can't take it (no primary key). */
function tableColumns(
  drizzle: Drizzle,
  table: any,
  where: string,
  enumTypes: Map<string, string>,
): RustColumn[] | null {
  const config = drizzle.getTableConfig(table);
  const props = Object.entries<any>(drizzle.getTableColumns(table));
  const compositePk = new Set<string>(config.primaryKeys.flatMap((pk: any) => pk.columns.map((c: any) => c.name)));
  const usedFields = new Set<string>();
  const columns = props.map(([prop, col]): RustColumn => {
    const base = ident(col.name);
    const field = uniqueName(base, usedFields, (i) => `${base}_${i}`);
    const mapped = mapColumn(col, enumTypes, `${where}.${col.name}`);
    const attrs = [...mapped.attrs];
    if (field !== col.name) attrs.unshift(`column_name = ${str(col.name)}`);
    if (col.primary || compositePk.has(col.name)) attrs.unshift('primary_key', 'auto_increment = false');
    const renderedSqlType = RENDERED_SQL_TYPES[col.columnType]?.(col) ?? '';
    const defaultFn = col.defaultFn !== undefined;
    const onUpdate = col.onUpdateFn !== undefined;
    return { field, column: col.name, prop, ...mapped, attrs, renderedSqlType, defaultFn, onUpdate };
  });
  const hasPk = props.some(([, c]) => c.primary) || compositePk.size > 0;
  return hasPk ? columns : null;
}

function generate(drizzle: Drizzle, kind: Kind, schema: Record<string, unknown>): { files: Written[]; warnings: string[] } {
  const { file: snapshotFile, snapshot } = latestSnapshot(kind.snapshots);
  const header = `//! Generated by \`pnpm rust:schema\` (scripts/rust-schema.ts) from \`${kind.entry}\`\n//! and ${snapshotFile}; don't edit.`;
  const warnings: string[] = [];
  const { enumTypes, enums } = collectEnums(drizzle, schema);
  const enumsHeader = `${header}\n//!\n//! The Postgres enums of the ${kind.name} database.`;
  const files: Written[] = [{ rel: `${kind.name}/enums.rs`, text: renderEnums(enums, enumsHeader) }];

  const modules: Array<{ module: string; table: string }> = [];
  const usedModules = new Set<string>(['enums', 'views']);
  for (const [name, table] of collectTables(drizzle, schema)) {
    const snap = snapshot.tables[`public.${name}`];
    if (!snap) {
      warnings.push(`${kind.name}: table ${name} is in the schema but not in ${snapshotFile} (no migration yet); skipped`);
      continue;
    }
    const base = ident(name);
    const module = uniqueName(base, usedModules, (i) => `${base}_${i}`);
    const columns = tableColumns(drizzle, table, `${kind.name}.${name}`, enumTypes);
    if (!columns) {
      warnings.push(`${kind.name}.${name}: no primary key; skipped (SeaORM needs one)`);
      continue;
    }
    for (const c of columns.filter((c) => c.prop !== camel(c.column))) {
      warnings.push(`${kind.name}.${name}.${c.column}: property ${c.prop} is not the column's camelCase`);
    }
    files.push({ rel: `${kind.name}/${module}.rs`, text: renderEntity(header, name, columns, snap) });
    modules.push({ module, table: name });
  }
  files.push(
    { rel: `${kind.name}/views.rs`, text: renderViews(header, kind, snapshot.views ?? {}) },
    { rel: `${kind.name}/mod.rs`, text: renderMod(header, kind, modules) },
  );
  return { files, warnings };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * rustfmt from Cargo's own bin directory (rustup's proxy, which follows
 * rust/rust-toolchain.toml from rust/), not whatever comes first on PATH.
 */
function rustfmtBinary(): string {
  const cargoHome = process.env.CARGO_HOME ?? path.join(homedir(), '.cargo');
  return path.join(cargoHome, 'bin', process.platform === 'win32' ? 'rustfmt.exe' : 'rustfmt');
}

/** Format generated files as the workspace does (rust/rustfmt.toml). */
function rustfmt(files: string[]) {
  const binary = rustfmtBinary();
  for (let i = 0; i < files.length; i += 100) {
    const args = ['--edition', '2024', '--config', 'max_width=100', ...files.slice(i, i + 100)];
    const run = spawnSync(binary, args, { cwd: path.join(repo, 'rust'), stdio: 'inherit' });
    if (run.status !== 0) throw new Error(`rustfmt failed (${binary})`);
  }
}

// A checkout with core.autocrlf has CRLF files; compare text, not bytes.
const readText = (file: string) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n');

/** Print the files of `kind` that differ from what would be written; return how many. */
function checkKind(kind: Kind, files: Written[]): number {
  const scratch = mkdtempSync(path.join(tmpdir(), 'rust-schema-'));
  mkdirSync(path.join(scratch, kind.name));
  for (const f of files) writeFileSync(path.join(scratch, f.rel), f.text);
  rustfmt(files.map((f) => path.join(scratch, f.rel)));
  const changed = files.filter((f) => {
    const target = path.join(outRoot, f.rel);
    return !existsSync(target) || readText(target) !== readText(path.join(scratch, f.rel));
  });
  rmSync(scratch, { recursive: true, force: true });

  const dir = path.join(outRoot, kind.name);
  const wanted = new Set(files.map((f) => path.basename(f.rel)));
  const extra = existsSync(dir) ? readdirSync(dir).filter((f) => !wanted.has(f)) : [];
  for (const f of changed) console.error(`stale: rust/crates/schema/src/${f.rel}`);
  for (const f of extra) console.error(`stale: rust/crates/schema/src/${kind.name}/${f} (no such table)`);
  return changed.length + extra.length;
}

/** Write the files of `kind`, removing modules of tables that are gone. */
function writeKind(kind: Kind, files: Written[]) {
  const dir = path.join(outRoot, kind.name);
  const wanted = new Set(files.map((f) => path.basename(f.rel)));
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((name) => !wanted.has(name))) rmSync(path.join(dir, f));
  }
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(path.join(outRoot, f.rel), f.text);
  rustfmt(files.map((f) => path.join(outRoot, f.rel)));
  console.log(`${kind.name}: ${files.length - 3} tables, enums, views and mod.rs written`);
}

async function main() {
  const [orm, pgCore] = await Promise.all([load('drizzle-orm'), load('drizzle-orm/pg-core')]);
  const drizzle: Drizzle = {
    getTableColumns: orm.getTableColumns,
    is: orm.is,
    PgTable: pgCore.PgTable,
    getTableConfig: pgCore.getTableConfig,
    isPgEnum: pgCore.isPgEnum,
  };
  const schemas = await Promise.all(KINDS.map((kind) => import(pathToFileURL(path.join(repo, kind.entry)).href)));
  const results = KINDS.map((kind, i) => ({ kind, ...generate(drizzle, kind, schemas[i]) }));

  let stale = 0;
  for (const { kind, files } of results) {
    if (check) stale += checkKind(kind, files);
    else writeKind(kind, files);
  }
  for (const warning of results.flatMap((r) => r.warnings)) console.warn(`warning: ${warning}`);
  if (stale) {
    console.error(`${stale} file(s) stale: run pnpm rust:schema`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
