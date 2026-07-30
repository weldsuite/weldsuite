/**
 * Turn API payloads into something an assistant can read out loud.
 *
 * Tool results used to be `JSON.stringify(row, null, 2)`. A lead carries 40
 * columns, 13 of them identifiers or timestamps, so a 20-row search handed the
 * model ~800 fields — a third of them ids. Models mirror the shape they are
 * fed, so it answered in ids.
 *
 * The rules here are deliberately conservative: identifiers are **kept**,
 * because the model needs them to make follow-up calls. They are just moved out
 * of the way and labelled, and the server instructions tell the model not to
 * read them aloud. Removing them entirely would mean maintaining a name→id map
 * in the proxy, which fails in ways that are hard to debug.
 */

/**
 * Columns that carry no meaning for a human reader. Tenant scoping and
 * soft-delete bookkeeping are invariants of the request, not facts about the
 * record.
 */
const DROPPED_FIELDS = new Set([
  'deletedAt',
  'workspaceId',
  'searchVector',
  'tsv',
]);

/** Field names to try, in order, when looking for a record's human label. */
const LABEL_FIELDS = [
  'name',
  'fullName',
  'title',
  'subject',
  'displayName',
  'companyName',
  'email',
  'code',
  'slug',
  'number',
  'reference',
];

/**
 * Fields worth showing on a one-line list row, most distinguishing first.
 *
 * Column order is a poor guide here: on a lead it yields firstName/lastName,
 * which merely repeat the label, while status and company — the things that
 * actually tell two rows apart — fall outside the cut.
 */
const SUMMARY_FIELDS = [
  // Human-quotable identifiers: a ticket reference or SKU is what someone reads
  // off a screen, unlike a generated id.
  'reference',
  'number',
  'sku',
  'status',
  'stage',
  'state',
  'priority',
  'rating',
  'type',
  'category',
  'companyName',
  'company',
  'customerName',
  'projectName',
  'assigneeName',
  'ownerName',
  'email',
  'amount',
  'total',
  'value',
  'quantity',
  'dueDate',
  'startDate',
  'closeDate',
  'source',
];

/**
 * Parts of a composite label. Once "Sanne de Vries" is the heading, repeating
 * the first and last name on the same line is pure noise.
 */
const LABEL_COMPONENT_FIELDS = new Set([
  'firstName',
  'lastName',
  'givenName',
  'familyName',
  'middleName',
]);

/** Suffixes that mark a value as an identifier rather than content. */
function isIdentifierField(key: string): boolean {
  return key === 'id' || /Id$/.test(key) || /_id$/.test(key);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?/.test(value);
}

/**
 * Dates read better as plain dates. Time-of-day is kept only when it is not
 * midnight, which is how date-only values arrive over JSON.
 */
function humaniseTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const iso = date.toISOString();
  const [day, rest] = [iso.slice(0, 10), iso.slice(11, 16)];
  return rest === '00:00' ? day : `${day} ${rest}`;
}

/**
 * Initialisms that must not be title-cased. Without these, `slaBreached` reads
 * as "Sla Breached" and `sku` as "Sku".
 */
const ACRONYMS = new Set([
  'id',
  'sku',
  'sla',
  'url',
  'uri',
  'api',
  'pdf',
  'csv',
  'html',
  'vat',
  'btw',
  'kvk',
  'iban',
  'bic',
  'crm',
  'seo',
  'utm',
  'vip',
]);

function humaniseKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(' ')
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.replace(/^./, (c) => c.toUpperCase()),
    )
    .join(' ');
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** Render a leaf value compactly. Nested structures fall back to JSON. */
function renderValue(value: unknown): string {
  if (isIsoTimestamp(value)) return humaniseTimestamp(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

/** The best human label for a record, if it has one. */
export function labelFor(record: Record<string, unknown>): string | null {
  for (const field of LABEL_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

interface SplitRecord {
  /** Meaningful fields, in original order, with empties and noise removed. */
  content: Array<[string, unknown]>;
  /** Identifier fields, kept for follow-up calls but held back. */
  identifiers: Array<[string, unknown]>;
}

function splitRecord(record: Record<string, unknown>): SplitRecord {
  const content: Array<[string, unknown]> = [];
  const identifiers: Array<[string, unknown]> = [];

  for (const [key, value] of Object.entries(record)) {
    if (DROPPED_FIELDS.has(key) || isEmpty(value)) continue;
    if (isIdentifierField(key)) {
      identifiers.push([key, value]);
    } else {
      content.push([key, value]);
    }
  }

  return { content, identifiers };
}

/**
 * Render one record as labelled lines, with its identifiers gathered on a single
 * trailing line so they are available but visually subordinate.
 */
export function presentRecord(record: Record<string, unknown>): string {
  const { content, identifiers } = splitRecord(record);
  const label = labelFor(record);

  const lines: string[] = [];
  if (label) lines.push(`## ${label}`);

  for (const [key, value] of content) {
    if (label && renderValue(value) === label) continue;
    lines.push(`- ${humaniseKey(key)}: ${renderValue(value)}`);
  }

  if (identifiers.length > 0) {
    const refs = identifiers.map(([k, v]) => `${k}=${String(v)}`).join(' ');
    lines.push('', `<!-- refs (internal, do not display): ${refs} -->`);
  }

  return lines.join('\n');
}

/**
 * Render a list as a scannable summary rather than an array of full records.
 *
 * Each row is one line: the label, then a few distinguishing fields. The full
 * field set for a single record is available via that record's own get tool, so
 * dumping every column for every row only adds noise.
 */
export function presentList(
  rows: Array<Record<string, unknown>>,
  pagination?: { totalCount?: number; hasMore?: boolean; cursor?: string | null },
): string {
  if (rows.length === 0) return 'No matching records.';

  const lines = rows.map((row, index) => {
    const { content, identifiers } = splitRecord(row);
    const label = labelFor(row);

    const candidates = content.filter(
      ([key, value]) =>
        renderValue(value) !== label &&
        !(label !== null && LABEL_COMPONENT_FIELDS.has(key)),
    );

    // Salient fields first, then whatever else is left, so a row always says
    // something even for entities the priority list does not know about.
    const ranked = [
      ...SUMMARY_FIELDS.map((field) => candidates.find(([key]) => key === field)).filter(
        (entry): entry is [string, unknown] => entry !== undefined,
      ),
      ...candidates.filter(([key]) => !SUMMARY_FIELDS.includes(key)),
    ];

    const describe = ([key, value]: [string, unknown]) =>
      `${humaniseKey(key)}: ${renderValue(value)}`;

    // Records with no name at all — a time entry, a line item — read better led
    // by their most salient fact than by a placeholder.
    const heading = label ?? (ranked[0] ? describe(ranked[0]) : 'Untitled record');
    const details = ranked
      .slice(label ? 0 : 1, label ? 3 : 4)
      .map(describe)
      .join(', ');

    const id = identifiers.find(([key]) => key === 'id')?.[1];
    const ref = id ? ` <!--id=${String(id)}-->` : '';

    return `${index + 1}. ${heading}${details ? ` — ${details}` : ''}${ref}`;
  });

  const total = pagination?.totalCount;
  const header =
    typeof total === 'number' && total !== rows.length
      ? `Showing ${rows.length} of ${total}:`
      : `${rows.length} result${rows.length === 1 ? '' : 's'}:`;

  const footer = pagination?.hasMore
    ? '\nMore results are available — ask for the next page to continue.'
    : '';

  return [header, ...lines].join('\n') + footer;
}

/**
 * Entry point used by the tool executor. Detects the API's response envelope
 * (`{ data }` for one record, `{ data, pagination }` for a list) and renders
 * accordingly. Anything unrecognised falls back to formatted JSON so no tool
 * can silently lose information.
 */
export function present(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') {
    return JSON.stringify(payload, null, 2);
  }

  const envelope = payload as {
    data?: unknown;
    pagination?: { totalCount?: number; hasMore?: boolean; cursor?: string | null };
  };

  if (!('data' in envelope)) {
    return JSON.stringify(payload, null, 2);
  }

  const { data, pagination } = envelope;

  if (Array.isArray(data)) {
    const rows = data.filter(
      (row): row is Record<string, unknown> => row !== null && typeof row === 'object',
    );
    // Mixed or primitive arrays keep their raw form rather than being mangled.
    if (rows.length !== data.length) return JSON.stringify(payload, null, 2);
    return presentList(rows, pagination);
  }

  if (data !== null && typeof data === 'object') {
    return presentRecord(data as Record<string, unknown>);
  }

  return JSON.stringify(payload, null, 2);
}
