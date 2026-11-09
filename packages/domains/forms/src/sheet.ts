/**
 * WeldForms' responses as a WeldSheets connected table (object
 * `form_responses`, ADR SHEETS-007): the completed responses of one form, the
 * chosen columns, filtered, sorted and capped, as rows of cells.
 *
 * Reading goes through this package, never through forms-api (ADR API-004).
 * Access is the connector's: `form_responses:read` (which the catalog entry
 * names and sheets-api checks first) and the form's own visibility, so a sheet
 * never lists the answers of a restricted form its connector could not open in
 * WeldForms. Questions marked sensitive and file questions have no column.
 *
 * Filters and sorts apply to the metadata columns only (number, dates, email,
 * score, ...): answers are JSON, and one question's column can mean different
 * things across versions. Everything runs over at most MAX_RESPONSES of the
 * newest completed responses.
 */

import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { formDefinitionSchema, type FormDefinition } from '@weldsuite/forms-engine/definition';
import {
  formColumns,
  isMetaColumnKey,
  responseCell,
  toSerial,
  type FormColumn,
  type ResponseCell,
} from './columns';

const { forms, formVersions, formResponses, formAccess } = schema;

/** The newest completed responses one listing reads. */
export const MAX_RESPONSES = 10_000;

export const FILTER_OPS = ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface SheetListDefinition {
  columns: readonly string[];
  filters?: ReadonlyArray<{ field: string; op: FilterOp; value?: string | number | boolean | null }>;
  sort?: { field: string; descending?: boolean };
  limit: number;
}

/** Who a listing is for, with their workspace permissions already resolved by the caller. */
export interface FormsViewer {
  userId: string;
  hasPermission: (permission: string) => boolean | Promise<boolean>;
}

/** The form does not exist, or is restricted and the viewer is not on it (a 404 to them). */
export class FormNotVisibleError extends Error {
  constructor(readonly formId: string) {
    super(`Form ${formId} is not available`);
    this.name = 'FormNotVisibleError';
  }
}

/** The listing asks for a column or a filter this table does not have. */
export class FormColumnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormColumnError';
  }
}

type FormRow = typeof forms.$inferSelect;

/**
 * The form, when the viewer may see it: its owner, `forms:manage`, anyone when
 * the form is open to the workspace, else the members of its access list. Null
 * when it does not exist or is not theirs to see.
 */
export async function visibleForm(db: Database, formId: string, viewer: FormsViewer): Promise<FormRow | null> {
  const [form] = await db.select().from(forms).where(eq(forms.id, formId)).limit(1);
  if (!form) return null;
  if (form.ownerUserId === viewer.userId || form.access === 'workspace' || (await viewer.hasPermission('forms:manage'))) return form;
  const [entry] = await db
    .select({ id: formAccess.id })
    .from(formAccess)
    .where(and(eq(formAccess.formId, formId), eq(formAccess.userId, viewer.userId)))
    .limit(1);
  return entry ? form : null;
}

async function loadDefinitions(db: Database, formId: string): Promise<Map<string, FormDefinition>> {
  const rows = await db
    .select({ id: formVersions.id, definition: formVersions.definition })
    .from(formVersions)
    .where(eq(formVersions.formId, formId))
    .orderBy(formVersions.number);
  const out = new Map<string, FormDefinition>();
  for (const row of rows) {
    const parsed = formDefinitionSchema.safeParse(row.definition);
    if (parsed.success) out.set(row.id, parsed.data);
  }
  return out;
}

/** The columns of a form, across its versions; for the connected table's picker and its formats. */
export async function listFormColumns(db: Database, formId: string, viewer: FormsViewer): Promise<FormColumn[]> {
  if (!(await visibleForm(db, formId, viewer))) throw new FormNotVisibleError(formId);
  return formColumns([...(await loadDefinitions(db, formId)).values()]);
}

// ── Filters on cells ─────────────────────────────────────────────────────────

const DAY = 1;

function parseSerial(value: unknown): { serial: number; day: boolean } | null {
  if (typeof value === 'number' && Number.isFinite(value)) return { serial: value, day: Number.isInteger(value) };
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const ms = Date.parse(`${text}T00:00:00Z`);
    return Number.isFinite(ms) ? { serial: toSerial(ms, false), day: true } : null;
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) {
    const iso = text.replace(' ', 'T');
    const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`);
    return Number.isFinite(ms) ? { serial: toSerial(ms, true), day: false } : null;
  }
  const n = Number(text);
  return text !== '' && Number.isFinite(n) ? { serial: n, day: Number.isInteger(n) } : null;
}

function matches(cell: ResponseCell, type: FormColumn['type'], op: FilterOp, raw: string | number | boolean | null | undefined): boolean {
  if (op === 'empty') return cell === null || (typeof cell === 'string' && cell.trim() === '');
  if (op === 'notEmpty') return !(cell === null || (typeof cell === 'string' && cell.trim() === ''));

  if (type === 'text') {
    if (raw === null || raw === undefined) return false;
    const needle = String(raw).toLowerCase();
    const hay = typeof cell === 'string' ? cell.toLowerCase() : null;
    if (op === 'eq') return hay === needle;
    if (op === 'neq') return hay === null || hay !== needle;
    if (op === 'contains') return hay !== null && hay.includes(needle);
    return false;
  }

  if (type === 'number') {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
    if (!Number.isFinite(n)) return false;
    if (op === 'neq') return typeof cell !== 'number' || cell !== n;
    if (typeof cell !== 'number') return false;
    return compare(cell, op, n);
  }

  // date, datetime: compared as serials; a whole-day value covers that UTC day.
  const value = parseSerial(raw);
  if (!value) return false;
  const day = type === 'date' || value.day;
  const start = Math.floor(value.serial);
  if (op === 'neq') {
    if (typeof cell !== 'number') return true;
    return day ? Math.floor(cell) !== start : cell !== value.serial;
  }
  if (typeof cell !== 'number') return false;
  if (!day) return compare(cell, op, value.serial);
  switch (op) {
    case 'eq':
      return cell >= start && cell < start + DAY;
    case 'gt':
      return cell >= start + DAY;
    case 'gte':
      return cell >= start;
    case 'lt':
      return cell < start;
    case 'lte':
      return cell < start + DAY;
    default:
      return false;
  }
}

function compare(a: number, op: FilterOp, b: number): boolean {
  switch (op) {
    case 'eq':
      return a === b;
    case 'gt':
      return a > b;
    case 'gte':
      return a >= b;
    case 'lt':
      return a < b;
    case 'lte':
      return a <= b;
    default:
      return false;
  }
}

function byCell(a: ResponseCell, b: ResponseCell, descending: boolean): number {
  // Empty values last, whichever way it sorts.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const order = typeof a === 'string' && typeof b === 'string' ? a.toLowerCase().localeCompare(b.toLowerCase()) : Number(a) - Number(b);
  return descending ? -order : order;
}

/**
 * The completed responses of `formId` as rows of cells in `def.columns` order
 * (no header row). Newest submitted first unless `def.sort` says otherwise.
 *
 * Throws `FormNotVisibleError` when the viewer cannot see the form,
 * `FormColumnError` for a column, filter or sort the table does not have.
 */
export async function listResponsesForSheet(
  db: Database,
  formId: string,
  def: SheetListDefinition,
  viewer: FormsViewer,
): Promise<ResponseCell[][]> {
  if (!(await visibleForm(db, formId, viewer))) throw new FormNotVisibleError(formId);
  const definitions = await loadDefinitions(db, formId);
  const columns = new Map(formColumns([...definitions.values()]).map((c) => [c.key, c]));

  const selected = def.columns.map((key) => {
    const column = columns.get(key);
    if (!column) throw new FormColumnError(`Unknown column '${key}'`);
    return column;
  });
  const filters = (def.filters ?? []).map((f) => {
    const column = columns.get(f.field);
    if (!column || !isMetaColumnKey(f.field)) throw new FormColumnError(`Cannot filter on '${f.field}'`);
    return { column, op: f.op, value: f.value };
  });
  const sortColumn = def.sort ? columns.get(def.sort.field) : undefined;
  if (def.sort && (!sortColumn || !isMetaColumnKey(def.sort.field))) throw new FormColumnError(`Cannot sort on '${def.sort.field}'`);

  const rows = await db
    .select()
    .from(formResponses)
    .where(and(eq(formResponses.formId, formId), eq(formResponses.status, 'completed')))
    .orderBy(desc(formResponses.submittedAt), desc(formResponses.id))
    .limit(MAX_RESPONSES);

  let kept = rows;
  if (filters.length > 0) {
    kept = rows.filter((row) => filters.every((f) => matches(responseCell(f.column, row, undefined), f.column.type, f.op, f.value)));
  }
  if (sortColumn && def.sort) {
    const { descending = false } = def.sort;
    // A stable sort keeps newest-first among equal values.
    kept = [...kept].sort((a, b) => byCell(responseCell(sortColumn, a, undefined), responseCell(sortColumn, b, undefined), descending));
  }
  return kept.slice(0, Math.max(0, def.limit)).map((row) => {
    const definition = definitions.get(row.versionId);
    return selected.map((column) => responseCell(column, row, definition));
  });
}
