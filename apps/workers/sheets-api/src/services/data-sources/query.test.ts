import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { SENSITIVE_COLUMNS } from '@weldsuite/db/lib/sensitive-columns';
import {
  SHEET_DATA_OBJECTS,
  SHEET_DATA_OBJECT_KEYS,
  checkSheetDataDefinition,
  sheetDataDefinitionSchema,
  type SheetDataDefinition,
  type SheetDataFieldType,
  type SheetDataFilter,
} from '@weldsuite/app-api-client/schemas/sheet-data';
import { DATA_SOURCES, type DataViewer } from './catalog';
import { SheetDataPermissionError, listRecords, toSerial } from './query';

const ALICE = 'user_alice';
const BOB = 'user_bob';

/** Holds every permission, `<object>:scope:all` included. */
const everything: DataViewer = { userId: ALICE, hasPermission: () => true };
/** Reads everything but only sees their own records where a module scopes by owner or membership. */
const ownOnly = (userId: string): DataViewer => ({ userId, hasPermission: (key) => !key.endsWith(':scope:all') });

let db: Database;

function def(columns: string[], extra: Partial<SheetDataDefinition> = {}): SheetDataDefinition {
  return { columns, headers: columns, filters: [], limit: 100, ...extra };
}

let seq = 0;
/** A company created on 2026-01-<n>, so the default order (newest first) is the reverse of insertion. */
async function company(name: string, values: Partial<typeof schema.companies.$inferInsert> = {}): Promise<string> {
  seq++;
  const id = `cmp_${seq}`;
  await db.insert(schema.companies).values({
    id,
    name,
    displayName: name,
    createdAt: new Date(Date.UTC(2026, 0, seq)),
    ...values,
  });
  return id;
}

/** Company names matching one filter, A–Z. */
async function namesWhere(filter: SheetDataFilter, viewer: DataViewer = everything): Promise<string[]> {
  const rows = await listRecords(db, 'companies', def(['name'], { filters: [filter], sort: { field: 'name' } }), viewer);
  return rows.map((r) => r[0] as string);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.tasks);
  await db.delete(schema.projectMembers);
  await db.delete(schema.projects);
  await db.delete(schema.companies);
  await db.delete(schema.people);
  await db.delete(schema.crmOpportunities);
  seq = 0;
});

describe('catalog', () => {
  const COLUMN_TYPES: Record<SheetDataFieldType, string[]> = {
    text: ['PgVarchar', 'PgText'],
    number: ['PgInteger', 'PgSmallInt', 'PgBigInt53', 'PgNumeric', 'PgReal', 'PgDoublePrecision'],
    currency: ['PgNumeric'],
    date: ['PgTimestamp', 'PgDate'],
    datetime: ['PgTimestamp'],
    boolean: ['PgBoolean'],
  };

  it.each(SHEET_DATA_OBJECT_KEYS)('%s: every field has a column of a fitting type and every column a field', (key) => {
    const object = SHEET_DATA_OBJECTS[key];
    const source = DATA_SOURCES[key];
    expect(Object.keys(source.columns).sort()).toEqual(object.fields.map((f) => f.key).sort());

    const tableName = getTableName(source.table);
    const propertyOf = new Map(Object.entries(getTableColumns(source.table)).map(([prop, col]) => [col, prop]));
    const sensitive: readonly string[] = (SENSITIVE_COLUMNS as Record<string, readonly string[]>)[tableName] ?? [];
    for (const field of object.fields) {
      const column = source.columns[field.key]!(source.table);
      expect(COLUMN_TYPES[field.type], `${key}.${field.key} is ${column.columnType}`).toContain(column.columnType);
      expect(propertyOf.has(column), `${key}.${field.key} is a column of ${tableName}`).toBe(true);
      expect(sensitive).not.toContain(propertyOf.get(column));
    }
  });

  it('keeps every object between 8 and 20 fields with a handful of defaults', () => {
    for (const key of SHEET_DATA_OBJECT_KEYS) {
      const { fields } = SHEET_DATA_OBJECTS[key];
      expect(fields.length).toBeGreaterThanOrEqual(8);
      expect(fields.length).toBeLessThanOrEqual(20);
      const defaults = fields.filter((f) => f.default).length;
      expect(defaults).toBeGreaterThanOrEqual(4);
      expect(defaults).toBeLessThanOrEqual(6);
      expect(new Set(fields.map((f) => f.key)).size).toBe(fields.length);
    }
  });

  it.each(SHEET_DATA_OBJECT_KEYS)('%s: lists every field, sorted by each kind of field, against the migrated schema', async (key) => {
    const keys = SHEET_DATA_OBJECTS[key].fields.map((f) => f.key);
    for (const field of SHEET_DATA_OBJECTS[key].fields) {
      const filter: SheetDataFilter = { field: field.key, op: 'notEmpty' };
      await expect(listRecords(db, key, def(keys, { filters: [filter], sort: { field: field.key, descending: true } }), everything)).resolves.toEqual([]);
    }
  });
});

describe('checkSheetDataDefinition', () => {
  it('accepts fields of the object and ops that fit them', () => {
    expect(
      checkSheetDataDefinition('companies', {
        columns: ['name', 'leadScore'],
        headers: ['Name', 'Score'],
        filters: [
          { field: 'name', op: 'contains', value: 'acme' },
          { field: 'leadScore', op: 'gte', value: 5 },
          { field: 'archivedAt', op: 'empty' },
        ],
        sort: { field: 'createdAt', descending: true },
        limit: 500,
      }),
    ).toBeNull();
  });

  it('names what does not fit', () => {
    const base = { columns: ['name'], headers: ['Name'], limit: 10 };
    expect(checkSheetDataDefinition('companies', { ...base, columns: ['nope'] })).toMatch(/nope/);
    expect(checkSheetDataDefinition('companies', { ...base, filters: [{ field: 'leadScore', op: 'contains', value: '1' }] })).toMatch(/contains/);
    expect(checkSheetDataDefinition('companies', { ...base, filters: [{ field: 'name', op: 'gt', value: 'a' }] })).toMatch(/gt/);
    expect(checkSheetDataDefinition('companies', { ...base, filters: [{ field: 'name', op: 'eq' }] })).toMatch(/needs a value/);
    expect(checkSheetDataDefinition('companies', { ...base, sort: { field: 'ticketNumber' } })).toMatch(/ticketNumber/);
    expect(checkSheetDataDefinition('companies', { ...base, headers: ['A', 'B'] })).toMatch(/header/);
  });

  it('the schema rejects duplicate columns, a header count mismatch and limits out of range', () => {
    const ok = { columns: ['name'], headers: ['Name'], limit: 10 };
    expect(sheetDataDefinitionSchema.safeParse(ok).success).toBe(true);
    expect(sheetDataDefinitionSchema.safeParse({ ...ok, columns: ['name', 'name'], headers: ['A', 'B'] }).success).toBe(false);
    expect(sheetDataDefinitionSchema.safeParse({ ...ok, headers: ['A', 'B'] }).success).toBe(false);
    expect(sheetDataDefinitionSchema.safeParse({ ...ok, limit: 10_001 }).success).toBe(false);
    expect(sheetDataDefinitionSchema.safeParse({ ...ok, headers: ['  '] }).success).toBe(false);
  });
});

describe('listRecords', () => {
  it('returns rows in the order of the columns', async () => {
    await company('Acme', { email: 'hello@acme.test', leadScore: 7 });
    const rows = await listRecords(db, 'companies', def(['leadScore', 'name', 'email']), everything);
    expect(rows).toEqual([[7, 'Acme', 'hello@acme.test']]);
  });

  it('filters text: eq/neq case-insensitively, contains, empty and notEmpty (blank counts as empty)', async () => {
    await company('Acme', { industry: 'Tech' });
    await company('Beta', { industry: 'tech' });
    await company('Gamma', { industry: null });
    await company('Delta', { industry: '  ' });
    expect(await namesWhere({ field: 'industry', op: 'eq', value: 'TECH' })).toEqual(['Acme', 'Beta']);
    expect(await namesWhere({ field: 'industry', op: 'neq', value: 'tech' })).toEqual(['Delta', 'Gamma']);
    expect(await namesWhere({ field: 'industry', op: 'contains', value: 'EC' })).toEqual(['Acme', 'Beta']);
    expect(await namesWhere({ field: 'industry', op: 'empty' })).toEqual(['Delta', 'Gamma']);
    expect(await namesWhere({ field: 'industry', op: 'notEmpty' })).toEqual(['Acme', 'Beta']);
  });

  it('filters numbers with every comparison, reading numeric text', async () => {
    await company('Acme', { leadScore: 10 });
    await company('Beta', { leadScore: 20 });
    await company('Gamma', { leadScore: 30 });
    await company('Delta', { leadScore: null });
    expect(await namesWhere({ field: 'leadScore', op: 'eq', value: '20' })).toEqual(['Beta']);
    expect(await namesWhere({ field: 'leadScore', op: 'neq', value: 20 })).toEqual(['Acme', 'Delta', 'Gamma']);
    expect(await namesWhere({ field: 'leadScore', op: 'gt', value: 10 })).toEqual(['Beta', 'Gamma']);
    expect(await namesWhere({ field: 'leadScore', op: 'gte', value: 20 })).toEqual(['Beta', 'Gamma']);
    expect(await namesWhere({ field: 'leadScore', op: 'lt', value: 20 })).toEqual(['Acme']);
    expect(await namesWhere({ field: 'leadScore', op: 'lte', value: 20 })).toEqual(['Acme', 'Beta']);
    expect(await namesWhere({ field: 'leadScore', op: 'lt', value: 10.5 })).toEqual(['Acme']);
    expect(await namesWhere({ field: 'leadScore', op: 'empty' })).toEqual(['Delta']);
    expect(await namesWhere({ field: 'leadScore', op: 'notEmpty' })).toEqual(['Acme', 'Beta', 'Gamma']);
  });

  it('filters booleans from true/false, words and 1/0', async () => {
    await company('Acme', { isSupplier: true });
    await company('Beta', { isSupplier: false });
    expect(await namesWhere({ field: 'isSupplier', op: 'eq', value: true })).toEqual(['Acme']);
    expect(await namesWhere({ field: 'isSupplier', op: 'eq', value: 'yes' })).toEqual(['Acme']);
    expect(await namesWhere({ field: 'isSupplier', op: 'neq', value: 1 })).toEqual(['Beta']);
  });

  it('filters dates by whole UTC days and date-times by instant', async () => {
    await company('Acme', { lastContactDate: new Date('2026-03-15T10:00:00Z'), createdAt: new Date('2026-03-15T10:00:00Z') });
    await company('Beta', { lastContactDate: new Date('2026-03-16T00:00:00Z'), createdAt: new Date('2026-03-16T00:00:00Z') });
    await company('Gamma', { lastContactDate: null });
    const on = (op: SheetDataFilter['op'], value: SheetDataFilter['value'], field = 'lastContactDate') => namesWhere({ field, op, value });
    expect(await on('eq', '2026-03-15')).toEqual(['Acme']);
    expect(await on('neq', '2026-03-15')).toEqual(['Beta', 'Gamma']);
    expect(await on('gt', '2026-03-15')).toEqual(['Beta']);
    expect(await on('gte', '2026-03-16')).toEqual(['Beta']);
    expect(await on('lt', '2026-03-16')).toEqual(['Acme']);
    expect(await on('lte', '2026-03-15')).toEqual(['Acme']);
    // A spreadsheet serial (2026-03-16) and a date-time on a date field (widened to its day).
    expect(await on('eq', 46097)).toEqual(['Beta']);
    expect(await on('eq', '2026-03-15T23:59:00Z')).toEqual(['Acme']);
    // Date-times compare to the instant, a bare day still means the whole day.
    expect(await on('eq', '2026-03-15T10:00:00Z', 'createdAt')).toEqual(['Acme']);
    expect(await on('gt', '2026-03-15T10:00', 'createdAt')).toEqual(['Beta']);
    expect(await on('eq', '2026-03-15', 'createdAt')).toEqual(['Acme']);
  });

  it('makes a filter whose value does not fit its field match nothing', async () => {
    await company('Acme', { leadScore: 10, lastContactDate: new Date('2026-03-15T00:00:00Z'), isSupplier: true });
    expect(await namesWhere({ field: 'leadScore', op: 'gt', value: 'lots' })).toEqual([]);
    expect(await namesWhere({ field: 'lastContactDate', op: 'lte', value: '2026-02-30' })).toEqual([]);
    expect(await namesWhere({ field: 'lastContactDate', op: 'neq', value: 'yesterday' })).toEqual([]);
    expect(await namesWhere({ field: 'isSupplier', op: 'eq', value: 'maybe' })).toEqual([]);
  });

  it('matches %, _ and \\ in contains literally', async () => {
    for (const name of ['50% off', '500 off', 'a_b', 'axb', 'back\\slash', 'backslash']) await company(name);
    expect(await namesWhere({ field: 'name', op: 'contains', value: '50%' })).toEqual(['50% off']);
    expect(await namesWhere({ field: 'name', op: 'contains', value: 'a_b' })).toEqual(['a_b']);
    expect(await namesWhere({ field: 'name', op: 'contains', value: 'k\\s' })).toEqual(['back\\slash']);
  });

  it('sorts ascending and descending with empty values last, text case-insensitively, newest first by default', async () => {
    await company('banana', { leadScore: 20 });
    await company('Apple', { leadScore: null });
    await company('cherry', { leadScore: 30 });
    await company('date', { leadScore: 10 });
    const list = async (sort?: SheetDataDefinition['sort']) =>
      (await listRecords(db, 'companies', def(['name'], { sort }), everything)).map((r) => r[0]);
    expect(await list({ field: 'leadScore', descending: true })).toEqual(['cherry', 'banana', 'date', 'Apple']);
    expect(await list({ field: 'leadScore' })).toEqual(['date', 'banana', 'cherry', 'Apple']);
    expect(await list({ field: 'name' })).toEqual(['Apple', 'banana', 'cherry', 'date']);
    expect(await list({ field: 'name', descending: true })).toEqual(['date', 'cherry', 'banana', 'Apple']);
    expect(await list()).toEqual(['date', 'cherry', 'Apple', 'banana']);
  });

  it('stops at the limit', async () => {
    for (const name of ['One', 'Two', 'Three']) await company(name);
    const rows = await listRecords(db, 'companies', def(['name'], { limit: 2 }), everything);
    expect(rows).toEqual([['Three'], ['Two']]);
  });

  it('leaves soft-deleted records out', async () => {
    await company('Live');
    await company('Gone', { deletedAt: new Date() });
    expect(await listRecords(db, 'companies', def(['name']), everything)).toEqual([['Live']]);
  });

  it('turns dates into spreadsheet serials: whole days for dates, with the time for date-times', async () => {
    expect(toSerial(Date.UTC(1899, 11, 30), false)).toBe(0);
    expect(toSerial(Date.UTC(2026, 0, 1), false)).toBe(46023);
    await company('Acme', {
      lastContactDate: new Date('2026-03-15T18:00:00Z'),
      createdAt: new Date('2026-03-15T18:00:00Z'),
      nextFollowUpDate: null,
    });
    const rows = await listRecords(db, 'companies', def(['lastContactDate', 'createdAt', 'nextFollowUpDate']), everything);
    expect(rows).toEqual([[46096, 46096.75, null]]);
  });

  it('turns numeric strings into numbers', async () => {
    await db.insert(schema.crmOpportunities).values([
      { id: 'opp_1', name: 'Big deal', customerId: 'cmp_x', ownerId: ALICE, amount: '1234.50', probability: 40 },
      { id: 'opp_2', name: 'Small deal', customerId: 'cmp_x', ownerId: ALICE, amount: '99', expectedRevenue: null },
    ]);
    const rows = await listRecords(
      db,
      'opportunities',
      def(['name', 'amount', 'expectedRevenue', 'probability'], {
        filters: [{ field: 'amount', op: 'gt', value: '1000' }],
      }),
      everything,
    );
    expect(rows).toEqual([['Big deal', 1234.5, null, 40]]);
  });

  it('refuses a viewer without the object permission, and a definition that does not fit', async () => {
    const noCompanies: DataViewer = { userId: ALICE, hasPermission: (key) => key !== 'companies:read' };
    await expect(listRecords(db, 'companies', def(['name']), noCompanies)).rejects.toBeInstanceOf(SheetDataPermissionError);
    await expect(listRecords(db, 'companies', def(['subject']), everything)).rejects.toThrow(/subject/);
  });

  it('shows CRM records to their owner only, unless the viewer may see all', async () => {
    await company('Alice Co', { ownerId: ALICE });
    await company('Bob Co', { ownerId: BOB });
    await company('Nobody Co', { ownerId: null });
    const names = async (viewer: DataViewer) =>
      (await listRecords(db, 'companies', def(['name'], { sort: { field: 'name' } }), viewer)).map((r) => r[0]);
    expect(await names(ownOnly(ALICE))).toEqual(['Alice Co']);
    expect(await names(ownOnly(BOB))).toEqual(['Bob Co']);
    expect(await names(everything)).toEqual(['Alice Co', 'Bob Co', 'Nobody Co']);
  });

  it('lists people in the CRM only, never mail-only identities', async () => {
    await db.insert(schema.people).values([
      { id: 'per_1', displayName: 'In CRM', ownerId: ALICE },
      { id: 'per_2', displayName: 'Mail only', ownerId: ALICE, inCrm: false },
    ]);
    expect(await listRecords(db, 'people', def(['name']), everything)).toEqual([['In CRM']]);
  });

  it('shows projects and their tasks to managers and active members only, unless the viewer may see all', async () => {
    const at = new Date('2026-01-01T00:00:00Z');
    await db.insert(schema.projects).values([
      { id: 'prj_managed', name: 'Managed', projectManagerId: ALICE, createdAt: at, updatedAt: at },
      { id: 'prj_member', name: 'Member', projectManagerId: BOB, createdAt: at, updatedAt: at },
      { id: 'prj_left', name: 'Left', projectManagerId: BOB, createdAt: at, updatedAt: at },
      { id: 'prj_other', name: 'Other', projectManagerId: BOB, createdAt: at, updatedAt: at },
      { id: 'prj_deleted', name: 'Deleted', projectManagerId: ALICE, createdAt: at, updatedAt: at, deletedAt: at },
    ]);
    await db.insert(schema.projectMembers).values([
      { id: 'pm_1', projectId: 'prj_member', userId: ALICE, role: 'viewer' },
      { id: 'pm_2', projectId: 'prj_left', userId: ALICE, isActive: false },
    ]);
    await db.insert(schema.tasks).values([
      { id: 'tsk_personal', title: 'Personal' },
      { id: 'tsk_managed', title: 'In managed', projectId: 'prj_managed' },
      { id: 'tsk_member', title: 'In member', projectId: 'prj_member' },
      { id: 'tsk_left', title: 'In left', projectId: 'prj_left' },
      { id: 'tsk_other', title: 'In other', projectId: 'prj_other' },
      { id: 'tsk_deleted', title: 'In deleted', projectId: 'prj_deleted' },
    ]);
    const projects = async (viewer: DataViewer) =>
      (await listRecords(db, 'projects', def(['name'], { sort: { field: 'name' } }), viewer)).map((r) => r[0]);
    const tasks = async (viewer: DataViewer) =>
      (await listRecords(db, 'tasks', def(['title'], { sort: { field: 'title' } }), viewer)).map((r) => r[0]);

    expect(await projects(ownOnly(ALICE))).toEqual(['Managed', 'Member']);
    expect(await projects(everything)).toEqual(['Left', 'Managed', 'Member', 'Other']);
    expect(await tasks(ownOnly(ALICE))).toEqual(['In managed', 'In member', 'Personal']);
    expect(await tasks(everything)).toEqual(['In left', 'In managed', 'In member', 'In other', 'Personal']);
  });
});
