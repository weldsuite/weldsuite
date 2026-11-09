/**
 * The `form_responses` connected table against pglite: the definition checks
 * (form as parameter, a column per question and hidden field), the columns
 * across form versions, cells by type, filters and sorts on the metadata, and
 * who sees which form (the connector's `form_responses:read` plus the form's
 * own visibility). WeldForms' tables are read through @weldsuite/forms-domain.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { formDefinitionSchema } from '@weldsuite/forms-engine/definition';
import { answerColumnKey, blockIdOfColumnKey, formColumns, FORM_RESPONSE_META_COLUMNS } from '@weldsuite/forms-domain/columns';
import {
  SHEET_DATA_OBJECTS,
  checkSheetDataDefinition,
  sheetDataDefinitionSchema,
  type SheetDataDefinition,
} from '@weldsuite/app-api-client/schemas/sheet-data';
import type { DataViewer } from './catalog';
import { SheetDataPermissionError, listRecords, toSerial } from './query';

const OWNER = 'user_owner';
const OTHER = 'user_other';
const everything = (userId: string): DataViewer => ({ userId, hasPermission: () => true });
/** Reads responses but has no `forms:manage`. */
const reader = (userId: string): DataViewer => ({ userId, hasPermission: (key) => key !== 'forms:manage' });

const v1 = formDefinitionSchema.parse({
  blocks: [
    { id: 'b_name', ref: 'name', type: 'short_text', title: 'Your name', properties: {} },
    { id: 'b_age', ref: 'age', type: 'number', title: 'Age', properties: {} },
    { id: 'b_ok', ref: 'ok', type: 'yes_no', title: 'Can we call?', properties: {} },
    { id: 'b_when', ref: 'when', type: 'date', title: 'When?', properties: {} },
    { id: 'b_plan', ref: 'plan', type: 'multiple_choice', title: 'Plan', properties: { choices: [{ id: 'c_free', label: 'Free' }, { id: 'c_pro', label: 'Pro' }] } },
    { id: 'b_secret', ref: 'secret', type: 'short_text', title: 'Private', sensitive: true, properties: {} },
    { id: 'b_cv', ref: 'cv', type: 'file_upload', title: 'CV', properties: {} },
  ],
  hidden: [{ name: 'source' }, { name: 'utm_medium' }],
  endings: [{ id: 'e_done', ref: 'thanks', title: 'Thanks' }],
});
const v2 = formDefinitionSchema.parse({
  blocks: [
    { id: 'b_name', ref: 'name', type: 'short_text', title: 'Full name', properties: {} },
    { id: 'b_age', ref: 'age', type: 'number', title: 'Age', properties: {} },
    { id: 'b_extra', ref: 'extra', type: 'long_text', title: 'Anything else?', properties: {} },
  ],
  endings: [{ id: 'e_done', ref: 'thanks', title: 'Thanks' }],
});

let db: Database;

function def(columns: string[], extra: Partial<SheetDataDefinition> = {}): SheetDataDefinition {
  return { columns, headers: columns, filters: [], limit: 100, formId: 'frm_sheet', ...extra };
}

async function response(n: number, versionId: string, answers: Record<string, unknown>, extra: Partial<typeof schema.formResponses.$inferInsert> = {}) {
  await db.insert(schema.formResponses).values({
    id: `frs_${n}`,
    formId: 'frm_sheet',
    versionId,
    number: n,
    status: 'completed',
    answers,
    startedAt: new Date(Date.UTC(2026, 10, n, 9, 0)),
    submittedAt: new Date(Date.UTC(2026, 10, n, 10, 0)),
    durationMs: n * 60_000,
    score: n,
    respondentEmail: `r${n}@mail.test`,
    ...extra,
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  const t = schema;
  await db.delete(t.formResponses);
  await db.delete(t.formAccess);
  await db.delete(t.formVersions);
  await db.delete(t.forms);
  await db.insert(t.forms).values({ id: 'frm_sheet', title: 'Survey', definition: v2, settings: {}, ownerUserId: OWNER, publicId: 'pubsheet01', status: 'published', access: 'workspace' });
  await db.insert(t.formVersions).values([
    { id: 'fve_1', formId: 'frm_sheet', number: 1, definition: v1, publishedByUserId: OWNER },
    { id: 'fve_2', formId: 'frm_sheet', number: 2, definition: v2, publishedByUserId: OWNER },
  ]);
  await response(1, 'fve_1', { b_name: 'Ada', b_age: 36, b_ok: true, b_when: '2026-12-01', b_plan: { choiceIds: ['c_pro'] }, b_secret: 'hunter2' }, { hidden: { source: 'news', utm_medium: 'email' } });
  await response(2, 'fve_1', { b_name: 'Bob', b_age: 41, b_ok: false, b_plan: { choiceIds: ['c_free'] } });
  await response(3, 'fve_2', { b_name: 'Cy', b_age: 29, b_extra: 'Hello there' });
  await db.insert(schema.formResponses).values({ id: 'frs_draft', formId: 'frm_sheet', versionId: 'fve_2', number: null, status: 'in_progress', answers: { b_name: 'Draft' } });
});

const Q = (blockId: string) => answerColumnKey(blockId)!;

describe('catalog and definition', () => {
  it('offers the form responses object with its metadata fields, matching the forms-domain column model', () => {
    const object = SHEET_DATA_OBJECTS.form_responses;
    expect(object.permission).toBe('form_responses:read');
    expect(object.fields.map((f) => f.key).sort()).toEqual(FORM_RESPONSE_META_COLUMNS.map((c) => c.key).sort());
    expect(object.fields.every((f) => f.type === FORM_RESPONSE_META_COLUMNS.find((c) => c.key === f.key)!.type)).toBe(true);
  });

  it('needs the form, accepts question and hidden-field columns, and filters only on metadata', () => {
    const base = { headers: ['a'], filters: [], limit: 10 };
    expect(checkSheetDataDefinition('form_responses', { ...base, columns: ['number'] })).toMatch(/Pick the form/);
    expect(checkSheetDataDefinition('form_responses', { ...base, columns: ['number', Q('b_name'), 'hsource'], headers: ['a', 'b', 'c'], formId: 'frm_x' })).toBeNull();
    expect(checkSheetDataDefinition('form_responses', { ...base, columns: ['nonsense'], formId: 'frm_x' })).toMatch(/Unknown field/);
    expect(checkSheetDataDefinition('form_responses', { ...base, columns: ['number'], formId: 'frm_x', filters: [{ field: Q('b_name'), op: 'eq', value: 'x' }] })).toMatch(/Unknown filter field/);
    expect(checkSheetDataDefinition('companies', { ...base, columns: ['name'], formId: 'frm_x' })).toMatch(/only applies to form_responses/);
    expect(sheetDataDefinitionSchema.parse({ ...base, columns: ['number'], formId: 'frm_x' }).formId).toBe('frm_x');
  });

  it('maps question column keys to block ids and back', () => {
    expect(Q('b_x7Kp2QaZ')).toBe('qbx7Kp2QaZ');
    expect(blockIdOfColumnKey('qbx7Kp2QaZ')).toBe('b_x7Kp2QaZ');
    expect(answerColumnKey('weird-id')).toBeNull();
  });
});

describe('columns across versions', () => {
  it('lists metadata, every question that ever existed under its latest title, then hidden fields; sensitive and file questions have none', () => {
    const columns = formColumns([v1, v2]);
    expect(columns.map((c) => [c.key, c.type, c.label])).toEqual([
      ...FORM_RESPONSE_META_COLUMNS.map((c) => [c.key, c.type, c.key]),
      [Q('b_name'), 'text', 'Full name'],
      [Q('b_age'), 'number', 'Age'],
      [Q('b_ok'), 'boolean', 'Can we call?'],
      [Q('b_when'), 'date', 'When?'],
      [Q('b_plan'), 'text', 'Plan'],
      [Q('b_extra'), 'text', 'Anything else?'],
      ['hsource', 'text', 'source'],
    ]);
    // utm_medium has an underscore and so no key of its own.
    expect(columns.some((c) => c.name === 'utm_medium')).toBe(false);
  });
});

describe('listRecords for form_responses', () => {
  it('lists the completed responses newest submitted first, cells by type, with the choices as labels', async () => {
    const rows = await listRecords(db, 'form_responses', def(['number', 'submittedAt', 'respondentEmail', Q('b_name'), Q('b_age'), Q('b_ok'), Q('b_when'), Q('b_plan'), Q('b_extra'), 'hsource', 'durationSeconds', 'score']), everything(OWNER));
    expect(rows).toEqual([
      [3, toSerial(Date.UTC(2026, 10, 3, 10), true), 'r3@mail.test', 'Cy', 29, null, null, null, 'Hello there', null, 180, 3],
      [2, toSerial(Date.UTC(2026, 10, 2, 10), true), 'r2@mail.test', 'Bob', 41, false, null, 'Free', null, null, 120, 2],
      [1, toSerial(Date.UTC(2026, 10, 1, 10), true), 'r1@mail.test', 'Ada', 36, true, toSerial(Date.UTC(2026, 11, 1), false), 'Pro', null, 'news', 60, 1],
    ]);
  });

  it('applies filters and sort on the metadata and the limit', async () => {
    const col = ['number'];
    expect(await listRecords(db, 'form_responses', def(col, { filters: [{ field: 'number', op: 'gte', value: 2 }], sort: { field: 'number' } }), everything(OWNER))).toEqual([[2], [3]]);
    expect(await listRecords(db, 'form_responses', def(col, { filters: [{ field: 'respondentEmail', op: 'contains', value: 'R1@' }] }), everything(OWNER))).toEqual([[1]]);
    expect(await listRecords(db, 'form_responses', def(col, { filters: [{ field: 'respondentEmail', op: 'neq', value: 'r1@mail.test' }], sort: { field: 'score', descending: true } }), everything(OWNER))).toEqual([[3], [2]]);
    expect(await listRecords(db, 'form_responses', def(col, { filters: [{ field: 'submittedAt', op: 'eq', value: '2026-11-02' }] }), everything(OWNER))).toEqual([[2]]);
    expect(await listRecords(db, 'form_responses', def(col, { filters: [{ field: 'submittedAt', op: 'gt', value: '2026-11-02' }] }), everything(OWNER))).toEqual([[3]]);
    expect(await listRecords(db, 'form_responses', def(col, { filters: [{ field: 'submittedAt', op: 'lt', value: '2026-11-02T10:00:00Z' }] }), everything(OWNER))).toEqual([[1]]);
    expect(await listRecords(db, 'form_responses', def(col, { filters: [{ field: 'personId', op: 'empty' }] }), everything(OWNER))).toHaveLength(3);
    expect(await listRecords(db, 'form_responses', def(col, { filters: [{ field: 'number', op: 'eq', value: 'abc' }] }), everything(OWNER))).toEqual([]);
    expect(await listRecords(db, 'form_responses', def(col, { limit: 2 }), everything(OWNER))).toEqual([[3], [2]]);
  });

  it('has no column for sensitive or file questions, or for a question that does not exist', async () => {
    for (const blockId of ['b_secret', 'b_cv', 'b_missing']) {
      await expect(listRecords(db, 'form_responses', def([Q(blockId)]), everything(OWNER))).rejects.toThrow(/Unknown column/);
    }
  });

  it('shows no one a form they have no read permission for, or one that is gone', async () => {
    const noRead: DataViewer = { userId: OWNER, hasPermission: (key) => key !== 'form_responses:read' };
    await expect(listRecords(db, 'form_responses', def(['number']), noRead)).rejects.toBeInstanceOf(SheetDataPermissionError);
    await expect(listRecords(db, 'form_responses', def(['number'], { formId: 'frm_gone' }), everything(OWNER))).rejects.toBeInstanceOf(SheetDataPermissionError);
  });

  it('follows the form: a restricted form is for its owner, its access list and forms:manage', async () => {
    await db.update(schema.forms).set({ access: 'restricted' });
    expect(await listRecords(db, 'form_responses', def(['number']), reader(OWNER))).toHaveLength(3);
    await expect(listRecords(db, 'form_responses', def(['number']), reader(OTHER))).rejects.toBeInstanceOf(SheetDataPermissionError);
    expect(await listRecords(db, 'form_responses', def(['number']), everything(OTHER))).toHaveLength(3);
    await db.insert(schema.formAccess).values({ id: 'fac_1', formId: 'frm_sheet', userId: OTHER, role: 'results' });
    expect(await listRecords(db, 'form_responses', def(['number']), reader(OTHER))).toHaveLength(3);
  });
});
