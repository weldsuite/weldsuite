/**
 * WeldSheets connected tables — which WeldSuite records a sheet can list, and
 * the definition of one listing. Zod v3, shared by the platform and sheets-api.
 *
 * A connected table fills a range of a sheet with records of one object
 * (companies, tickets, invoices, …): the chosen fields as columns, filtered,
 * sorted and capped. sheets-api maps every field key below to a column
 * (apps/workers/sheets-api/src/services/data-sources/catalog.ts, which fails to
 * compile when the two drift apart) and lists the records with the access of
 * the person who connected the table.
 *
 * Field keys are stored in saved definitions: renaming one breaks every sheet
 * that uses it. Add fields freely; remove or rename only with a migration of
 * `sheet_data_sources.definition`. Labels live in the `sheetData` i18n
 * namespace (`sheetData.objects.<object>`, `sheetData.fields.<object>.<field>`).
 *
 * Only scalar columns are offered: no JSON, arrays or ciphertext.
 */

import { z } from 'zod';

export const SHEET_DATA_OBJECT_KEYS = [
  'companies',
  'people',
  'leads',
  'opportunities',
  'quotes',
  'tickets',
  'projects',
  'tasks',
  'products',
  'orders',
  'invoices',
] as const;
export type SheetDataObjectKey = (typeof SHEET_DATA_OBJECT_KEYS)[number];

/**
 * How a field's values reach the sheet: text as text, number and currency as
 * numbers, date and datetime as spreadsheet serial numbers (days since
 * 1899-12-30, with a fraction for the time of day), boolean as TRUE/FALSE.
 */
export type SheetDataFieldType = 'text' | 'number' | 'currency' | 'date' | 'datetime' | 'boolean';

export interface SheetDataField {
  key: string;
  type: SheetDataFieldType;
  /** Picked when someone first connects this object. */
  default?: boolean;
}

export interface SheetDataObject {
  key: SheetDataObjectKey;
  /** Workspace permission needed to list it, e.g. 'companies:read'. */
  permission: string;
  fields: SheetDataField[];
}

export const SHEET_DATA_FILTER_OPS = ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty'] as const;
export type SheetDataFilterOp = (typeof SHEET_DATA_FILTER_OPS)[number];

/** Most records one connected table lists. */
export const MAX_SHEET_DATA_ROWS = 10_000;
/** Most columns one connected table shows. */
export const MAX_SHEET_DATA_COLUMNS = 50;
/** Most filters on one connected table. */
export const MAX_SHEET_DATA_FILTERS = 20;

const ORDERED_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty'] as const;

/** The filter operators that fit each kind of field, in the order a picker shows them. */
export const SHEET_DATA_FILTER_OPS_BY_TYPE: Record<SheetDataFieldType, readonly SheetDataFilterOp[]> = {
  text: ['eq', 'neq', 'contains', 'empty', 'notEmpty'],
  number: ORDERED_OPS,
  currency: ORDERED_OPS,
  date: ORDERED_OPS,
  datetime: ORDERED_OPS,
  boolean: ['eq', 'neq', 'empty', 'notEmpty'],
};

/** Operators that compare against a value; `empty` and `notEmpty` take none. */
export function sheetDataOpNeedsValue(op: SheetDataFilterOp): boolean {
  return op !== 'empty' && op !== 'notEmpty';
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * The objects and their fields. `as const` keeps every field key as a literal
 * type (`SheetDataFieldKey`), which sheets-api's catalog is checked against.
 */
const OBJECT_DEFINITIONS = {
  companies: {
    permission: 'companies:read',
    fields: [
      { key: 'name', type: 'text', default: true },
      { key: 'tradingName', type: 'text' },
      { key: 'email', type: 'text', default: true },
      { key: 'phone', type: 'text', default: true },
      { key: 'website', type: 'text' },
      { key: 'industry', type: 'text', default: true },
      { key: 'status', type: 'text', default: true },
      { key: 'lifecycleStage', type: 'text' },
      { key: 'source', type: 'text' },
      { key: 'employeeCount', type: 'text' },
      { key: 'vatNumber', type: 'text' },
      { key: 'ownerId', type: 'text' },
      { key: 'accountManagerId', type: 'text' },
      { key: 'isSupplier', type: 'boolean' },
      { key: 'leadScore', type: 'number' },
      { key: 'lastContactDate', type: 'date' },
      { key: 'nextFollowUpDate', type: 'date' },
      { key: 'createdAt', type: 'datetime' },
      { key: 'updatedAt', type: 'datetime' },
      { key: 'archivedAt', type: 'datetime' },
    ],
  },
  people: {
    permission: 'people:read',
    fields: [
      { key: 'name', type: 'text', default: true },
      { key: 'firstName', type: 'text' },
      { key: 'lastName', type: 'text' },
      { key: 'email', type: 'text', default: true },
      { key: 'directPhone', type: 'text', default: true },
      { key: 'mobilePhone', type: 'text' },
      { key: 'title', type: 'text', default: true },
      { key: 'department', type: 'text' },
      { key: 'status', type: 'text', default: true },
      { key: 'lifecycleStage', type: 'text' },
      { key: 'source', type: 'text' },
      { key: 'ownerId', type: 'text' },
      { key: 'accountManagerId', type: 'text' },
      { key: 'isDecisionMaker', type: 'boolean' },
      { key: 'leadScore', type: 'number' },
      { key: 'lastContactedAt', type: 'datetime' },
      { key: 'nextFollowUpDate', type: 'date' },
      { key: 'createdAt', type: 'datetime' },
      { key: 'updatedAt', type: 'datetime' },
      { key: 'archivedAt', type: 'datetime' },
    ],
  },
  leads: {
    permission: 'leads:read',
    fields: [
      { key: 'name', type: 'text', default: true },
      { key: 'firstName', type: 'text' },
      { key: 'lastName', type: 'text' },
      { key: 'companyName', type: 'text', default: true },
      { key: 'title', type: 'text' },
      { key: 'email', type: 'text', default: true },
      { key: 'phone', type: 'text' },
      { key: 'source', type: 'text', default: true },
      { key: 'status', type: 'text', default: true },
      { key: 'rating', type: 'text' },
      { key: 'score', type: 'number' },
      { key: 'ownerId', type: 'text' },
      { key: 'isQualified', type: 'boolean' },
      { key: 'convertedAt', type: 'datetime' },
      { key: 'lastActivityAt', type: 'datetime' },
      { key: 'createdAt', type: 'datetime' },
      { key: 'updatedAt', type: 'datetime' },
    ],
  },
  opportunities: {
    permission: 'opportunities:read',
    fields: [
      { key: 'name', type: 'text', default: true },
      { key: 'customerName', type: 'text', default: true },
      { key: 'amount', type: 'currency', default: true },
      { key: 'currency', type: 'text' },
      { key: 'expectedRevenue', type: 'currency' },
      { key: 'stage', type: 'text', default: true },
      { key: 'probability', type: 'number' },
      { key: 'status', type: 'text', default: true },
      { key: 'pipeline', type: 'text' },
      { key: 'type', type: 'text' },
      { key: 'forecastCategory', type: 'text' },
      { key: 'leadSource', type: 'text' },
      { key: 'ownerId', type: 'text' },
      { key: 'closeDate', type: 'date', default: true },
      { key: 'actualCloseDate', type: 'date' },
      { key: 'nextStep', type: 'text' },
      { key: 'nextStepDate', type: 'date' },
      { key: 'createdAt', type: 'datetime' },
      { key: 'updatedAt', type: 'datetime' },
    ],
  },
  quotes: {
    permission: 'quotes:read',
    fields: [
      { key: 'quoteNumber', type: 'text', default: true },
      { key: 'name', type: 'text', default: true },
      { key: 'status', type: 'text', default: true },
      { key: 'subtotal', type: 'currency' },
      { key: 'discount', type: 'currency' },
      { key: 'tax', type: 'currency' },
      { key: 'shipping', type: 'currency' },
      { key: 'total', type: 'currency', default: true },
      { key: 'currency', type: 'text' },
      { key: 'validFrom', type: 'date' },
      { key: 'validUntil', type: 'date', default: true },
      { key: 'opportunityId', type: 'text' },
      { key: 'sentAt', type: 'datetime' },
      { key: 'approvedAt', type: 'datetime' },
      { key: 'signedAt', type: 'datetime' },
      { key: 'createdAt', type: 'datetime' },
      { key: 'updatedAt', type: 'datetime' },
    ],
  },
  tickets: {
    permission: 'tickets:read',
    fields: [
      { key: 'ticketNumber', type: 'text', default: true },
      { key: 'subject', type: 'text', default: true },
      { key: 'status', type: 'text', default: true },
      { key: 'priority', type: 'text', default: true },
      { key: 'category', type: 'text' },
      { key: 'channel', type: 'text' },
      { key: 'customerName', type: 'text', default: true },
      { key: 'customerEmail', type: 'text' },
      { key: 'customerCompany', type: 'text' },
      { key: 'assigneeId', type: 'text' },
      { key: 'assigneeName', type: 'text' },
      { key: 'slaStatus', type: 'text' },
      { key: 'firstResponseAt', type: 'datetime' },
      { key: 'resolvedAt', type: 'datetime' },
      { key: 'closedAt', type: 'datetime' },
      { key: 'satisfactionRating', type: 'number' },
      { key: 'messageCount', type: 'number' },
      { key: 'createdAt', type: 'datetime', default: true },
      { key: 'updatedAt', type: 'datetime' },
    ],
  },
  projects: {
    permission: 'projects:read',
    fields: [
      { key: 'name', type: 'text', default: true },
      { key: 'code', type: 'text' },
      { key: 'status', type: 'text', default: true },
      { key: 'priority', type: 'text' },
      { key: 'health', type: 'text' },
      { key: 'type', type: 'text' },
      { key: 'progress', type: 'number', default: true },
      { key: 'projectManagerId', type: 'text' },
      { key: 'startDate', type: 'date', default: true },
      { key: 'endDate', type: 'date', default: true },
      { key: 'budgetedAmount', type: 'currency' },
      { key: 'actualAmount', type: 'currency' },
      { key: 'budgetedHours', type: 'number' },
      { key: 'actualHours', type: 'number' },
      { key: 'isBillable', type: 'boolean' },
      { key: 'totalTasks', type: 'number' },
      { key: 'completedTasks', type: 'number' },
      { key: 'createdAt', type: 'datetime' },
      { key: 'updatedAt', type: 'datetime' },
    ],
  },
  tasks: {
    permission: 'tasks:read',
    fields: [
      { key: 'title', type: 'text', default: true },
      { key: 'key', type: 'text' },
      { key: 'status', type: 'text', default: true },
      { key: 'priority', type: 'text', default: true },
      { key: 'type', type: 'text' },
      { key: 'category', type: 'text' },
      { key: 'projectId', type: 'text' },
      { key: 'assigneeId', type: 'text', default: true },
      { key: 'reporterId', type: 'text' },
      { key: 'startDate', type: 'date' },
      { key: 'dueDate', type: 'date', default: true },
      { key: 'completedDate', type: 'datetime' },
      { key: 'estimatedHours', type: 'number' },
      { key: 'actualHours', type: 'number' },
      { key: 'storyPoints', type: 'number' },
      { key: 'progress', type: 'number' },
      { key: 'isBillable', type: 'boolean' },
      { key: 'createdAt', type: 'datetime' },
      { key: 'updatedAt', type: 'datetime' },
    ],
  },
  products: {
    permission: 'products:read',
    fields: [
      { key: 'name', type: 'text', default: true },
      { key: 'sku', type: 'text', default: true },
      { key: 'barcode', type: 'text' },
      { key: 'status', type: 'text', default: true },
      { key: 'price', type: 'currency', default: true },
      { key: 'compareAtPrice', type: 'currency' },
      { key: 'costPrice', type: 'currency' },
      { key: 'currency', type: 'text' },
      { key: 'inventoryQuantity', type: 'number', default: true },
      { key: 'lowStockThreshold', type: 'number' },
      { key: 'productType', type: 'text' },
      { key: 'vendor', type: 'text' },
      { key: 'brand', type: 'text' },
      { key: 'visibility', type: 'text' },
      { key: 'salesCount', type: 'number' },
      { key: 'publishedAt', type: 'datetime' },
      { key: 'createdAt', type: 'datetime' },
      { key: 'updatedAt', type: 'datetime' },
    ],
  },
  orders: {
    permission: 'orders:read',
    fields: [
      { key: 'orderNumber', type: 'text', default: true },
      { key: 'status', type: 'text', default: true },
      { key: 'paymentStatus', type: 'text' },
      { key: 'fulfillmentStatus', type: 'text' },
      { key: 'customerName', type: 'text', default: true },
      { key: 'customerEmail', type: 'text' },
      { key: 'currency', type: 'text' },
      { key: 'subtotal', type: 'currency' },
      { key: 'discountTotal', type: 'currency' },
      { key: 'shippingTotal', type: 'currency' },
      { key: 'taxTotal', type: 'currency' },
      { key: 'total', type: 'currency', default: true },
      { key: 'itemCount', type: 'number' },
      { key: 'source', type: 'text' },
      { key: 'paidAt', type: 'datetime' },
      { key: 'shippedAt', type: 'datetime' },
      { key: 'deliveredAt', type: 'datetime' },
      { key: 'cancelledAt', type: 'datetime' },
      { key: 'createdAt', type: 'datetime', default: true },
      { key: 'updatedAt', type: 'datetime' },
    ],
  },
  invoices: {
    permission: 'invoices:read',
    fields: [
      { key: 'invoiceNumber', type: 'text', default: true },
      { key: 'type', type: 'text' },
      { key: 'status', type: 'text', default: true },
      { key: 'contactName', type: 'text', default: true },
      { key: 'contactEmail', type: 'text' },
      { key: 'issueDate', type: 'date', default: true },
      { key: 'dueDate', type: 'date', default: true },
      { key: 'paidAt', type: 'datetime' },
      { key: 'sentAt', type: 'datetime' },
      { key: 'currency', type: 'text' },
      { key: 'subtotal', type: 'currency' },
      { key: 'discountTotal', type: 'currency' },
      { key: 'taxTotal', type: 'currency' },
      { key: 'total', type: 'currency', default: true },
      { key: 'amountPaid', type: 'currency' },
      { key: 'balanceDue', type: 'currency' },
      { key: 'reference', type: 'text' },
      { key: 'entityId', type: 'text' },
      { key: 'createdAt', type: 'datetime' },
      { key: 'updatedAt', type: 'datetime' },
    ],
  },
} as const satisfies Record<SheetDataObjectKey, { permission: string; fields: readonly SheetDataField[] }>;

/** The field keys of one object, as literal types. */
export type SheetDataFieldKey<K extends SheetDataObjectKey> = (typeof OBJECT_DEFINITIONS)[K]['fields'][number]['key'];

export const SHEET_DATA_OBJECTS: Record<SheetDataObjectKey, SheetDataObject> = Object.fromEntries(
  SHEET_DATA_OBJECT_KEYS.map((key) => [
    key,
    {
      key,
      permission: OBJECT_DEFINITIONS[key].permission,
      fields: (OBJECT_DEFINITIONS[key].fields as readonly SheetDataField[]).map((field) => ({ ...field })),
    },
  ]),
) as Record<SheetDataObjectKey, SheetDataObject>;

export function isSheetDataObjectKey(value: string): value is SheetDataObjectKey {
  return (SHEET_DATA_OBJECT_KEYS as readonly string[]).includes(value);
}

/** One field of an object, or undefined when the object has no such field. */
export function findSheetDataField(objectType: SheetDataObjectKey, key: string): SheetDataField | undefined {
  return SHEET_DATA_OBJECTS[objectType]?.fields.find((field) => field.key === key);
}

/** The fields picked when someone first connects this object. */
export function defaultSheetDataColumns(objectType: SheetDataObjectKey): string[] {
  return SHEET_DATA_OBJECTS[objectType].fields.filter((field) => field.default).map((field) => field.key);
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

const fieldKey = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/).max(64);

/**
 * What a filter compares with, as the editor sends it: text, a number or a
 * boolean. sheets-api reads it per field type (dates as `yyyy-mm-dd`); a value
 * that does not fit the field makes the filter match nothing.
 */
const filterValue = z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]);

export const sheetDataFilterSchema = z.object({
  field: fieldKey,
  op: z.enum(SHEET_DATA_FILTER_OPS),
  value: filterValue.optional(),
});
export type SheetDataFilter = z.infer<typeof sheetDataFilterSchema>;

export const sheetDataSortSchema = z.object({
  field: fieldKey,
  descending: z.boolean().optional(),
});
export type SheetDataSort = z.infer<typeof sheetDataSortSchema>;

/**
 * One connected table: which fields (`columns`, in sheet order) under which
 * titles (`headers`), which records (`filters`, all of which must match), in
 * which order (`sort`; newest first when unset) and at most how many.
 *
 * Whether the fields exist on the object is `checkSheetDataDefinition`, which
 * callers run with the object type (it is not part of the definition).
 */
export const sheetDataDefinitionSchema = z
  .object({
    columns: z.array(fieldKey).min(1).max(MAX_SHEET_DATA_COLUMNS),
    headers: z.array(z.string().trim().min(1).max(255)).min(1).max(MAX_SHEET_DATA_COLUMNS),
    filters: z.array(sheetDataFilterSchema).max(MAX_SHEET_DATA_FILTERS).default([]),
    sort: sheetDataSortSchema.optional(),
    limit: z.number().int().min(1).max(MAX_SHEET_DATA_ROWS),
  })
  .superRefine((def, ctx) => {
    if (new Set(def.columns).size !== def.columns.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['columns'], message: 'Each field can be a column only once' });
    }
    if (def.headers.length !== def.columns.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['headers'], message: 'Every column needs exactly one header' });
    }
  });
export type SheetDataDefinition = z.infer<typeof sheetDataDefinitionSchema>;
export type SheetDataDefinitionInput = z.input<typeof sheetDataDefinitionSchema>;

/**
 * Null when every column, filter and sort field exists on the object and every
 * filter fits its field (`contains` only on text, `gt`/`lt` and friends only on
 * numbers and dates, a value for every operator but `empty`/`notEmpty`); else
 * a short English reason.
 */
export function checkSheetDataDefinition(objectType: SheetDataObjectKey, def: SheetDataDefinitionInput): string | null {
  const object = SHEET_DATA_OBJECTS[objectType];
  if (!object) return `Unknown object '${String(objectType)}'`;
  const fields = new Map(object.fields.map((field) => [field.key, field]));

  const problem = checkColumns(objectType, def, fields) ?? checkFilters(objectType, def, fields);
  if (problem) return problem;
  if (def.sort && !fields.has(def.sort.field)) return `Unknown sort field '${def.sort.field}' on ${objectType}`;
  if (!Number.isInteger(def.limit) || def.limit < 1 || def.limit > MAX_SHEET_DATA_ROWS) {
    return `The limit must be between 1 and ${MAX_SHEET_DATA_ROWS}`;
  }
  return null;
}

function checkColumns(objectType: SheetDataObjectKey, def: SheetDataDefinitionInput, fields: Map<string, SheetDataField>): string | null {
  if (def.columns.length === 0) return 'Pick at least one column';
  if (def.columns.length > MAX_SHEET_DATA_COLUMNS) return `At most ${MAX_SHEET_DATA_COLUMNS} columns`;
  if (new Set(def.columns).size !== def.columns.length) return 'Each field can be a column only once';
  if (def.headers.length !== def.columns.length) return 'Every column needs exactly one header';
  const unknown = def.columns.find((column) => !fields.has(column));
  return unknown === undefined ? null : `Unknown field '${unknown}' on ${objectType}`;
}

function checkFilters(objectType: SheetDataObjectKey, def: SheetDataDefinitionInput, fields: Map<string, SheetDataField>): string | null {
  for (const filter of def.filters ?? []) {
    const field = fields.get(filter.field);
    if (!field) return `Unknown filter field '${filter.field}' on ${objectType}`;
    if (!SHEET_DATA_FILTER_OPS_BY_TYPE[field.type].includes(filter.op)) {
      return `Filter '${filter.op}' does not fit the ${field.type} field '${field.key}'`;
    }
    if (sheetDataOpNeedsValue(filter.op) && (filter.value === undefined || filter.value === null)) {
      return `Filter on '${field.key}' needs a value`;
    }
  }
  return null;
}
