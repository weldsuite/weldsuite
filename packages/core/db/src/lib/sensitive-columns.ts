/**
 * Ciphertext columns that never leave the server, not even as ciphertext.
 *
 * TINs, SSNs, bank account numbers and provider credentials are stored as
 * AES-GCM blobs. The blob is useless without the key, but it is still the
 * thing an attacker would exfiltrate, and "encrypted" stops being a defence
 * the moment a list endpoint, an entity event, a search document, an MCP tool
 * result or an AI prompt carries it. So these columns are read only by the
 * code that decrypts them (the reveal route, the 1099 export, the bank-feed
 * sync) and are stripped from everything else.
 *
 * Dependency-free on purpose: external-api, every module worker, the
 * entity-events publisher and the MCP server all import this one file.
 *
 *   - `omitSensitive` / `omitSensitiveRows` strip a row (or a Drizzle column
 *     map from `getTableColumns`, to build a `select(...)` column list).
 *   - `selectableColumns` is the same for generic code that only knows a table
 *     by its SQL name (a CRUD factory, a workflow action).
 *   - `scrubSensitiveKeys` strips the same keys, by name, from an arbitrary
 *     payload (entity-event data, search documents, log fields).
 *
 * Keys are the Drizzle property names (camelCase), tables are keyed by their
 * SQL name, so the map reads like the schema.
 */

export const SENSITIVE_COLUMNS = {
  /** TIN + vendor ACH account number, AES-GCM blob of `{ tin?, achAccountNumber? }`. */
  parties: ['sensitiveEncrypted'],
  /** The owner's SSN (sole proprietor) and the customer's own sales tax engine credentials. */
  entities: ['ssnEncrypted', 'salesTaxCredentialsEncrypted'],
  /** Full bank account number; only `accountNumberLast4` is shown. */
  bank_accounts: ['accountNumberEncrypted'],
  /** Bank feed provider access token(s). */
  bank_connections: ['credentialsEncrypted'],
  /** Payroll provider access token. */
  payroll_connections: ['credentialsEncrypted'],
  /** Recipient TIN of a filed 1099 line; only the 1099 file export reads it. */
  form_1099_filing_lines: ['recipientTinEncrypted'],
  /** HR employee sensitive blob (bank, national id, ...); hr-api reveals it behind `employees:sensitive`. */
  hr_employees: ['sensitiveEncrypted'],
} as const satisfies Record<string, readonly string[]>;

export type SensitiveTableName = keyof typeof SENSITIVE_COLUMNS;

/** The sensitive property names of one table. */
export type SensitiveKeysOf<T extends SensitiveTableName> = (typeof SENSITIVE_COLUMNS)[T][number];

/** `R` without the sensitive properties of table `T`. */
export type WithoutSensitive<T extends SensitiveTableName, R> = Omit<R, SensitiveKeysOf<T>>;

/** Every sensitive property name across all tables, for key-based scrubbing. */
export const ALL_SENSITIVE_KEYS: ReadonlySet<string> = new Set(
  Object.values(SENSITIVE_COLUMNS).flat(),
);

/** The sensitive property names of `table`. */
export function sensitiveColumnsOf<T extends SensitiveTableName>(
  table: T,
): readonly SensitiveKeysOf<T>[] {
  return SENSITIVE_COLUMNS[table] as readonly SensitiveKeysOf<T>[];
}

/**
 * Copy of `row` without the sensitive columns of `table`.
 *
 * Works on a loaded row and on a Drizzle column map alike:
 *
 *   omitSensitive('entities', row)
 *   db.select(omitSensitive('parties', getTableColumns(schema.parties))).from(schema.parties)
 *   db.update(t).set(...).returning(omitSensitive('bank_accounts', getTableColumns(t)))
 */
export function omitSensitive<T extends SensitiveTableName, R extends object>(
  table: T,
  row: R,
): WithoutSensitive<T, R> {
  const copy = { ...row } as Record<string, unknown>;
  for (const key of SENSITIVE_COLUMNS[table]) delete copy[key];
  return copy as WithoutSensitive<T, R>;
}

/** `omitSensitive` over a list. */
export function omitSensitiveRows<T extends SensitiveTableName, R extends object>(
  table: T,
  rows: readonly R[],
): WithoutSensitive<T, R>[] {
  return rows.map((row) => omitSensitive(table, row));
}

/**
 * Column map for a generic `db.select(map)` / `.returning(map)` over a table
 * known only by its SQL name: `columns` (Drizzle's `getTableColumns(table)`)
 * without the table's ciphertext columns and any `extraOmit` property names.
 * `undefined` when there is nothing to leave out, which `db.select(undefined)`
 * and `.returning(undefined)` treat as "all columns".
 *
 *   const columns = selectableColumns(getTableName(table), getTableColumns(table));
 *   db.select(columns).from(table)
 */
export function selectableColumns(
  tableName: string,
  columns: Record<string, unknown>,
  extraOmit: readonly string[] = [],
): Record<string, unknown> | undefined {
  const sensitive = (SENSITIVE_COLUMNS as Record<string, readonly string[]>)[tableName] ?? [];
  if (sensitive.length === 0 && extraOmit.length === 0) return undefined;
  const drop = new Set<string>([...sensitive, ...extraOmit]);
  return Object.fromEntries(Object.entries(columns).filter(([key]) => !drop.has(key)));
}

/** Deeper than any row, event payload or search document nests; also bounds a cyclic value. */
const MAX_SCRUB_DEPTH = 24;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function scrub(value: unknown, depth: number): unknown {
  if (depth > MAX_SCRUB_DEPTH) return value;

  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const next = scrub(value[i], depth + 1);
      if (next !== value[i]) {
        out ??= value.slice();
        out[i] = next;
      }
    }
    return out ?? value;
  }

  if (!isPlainObject(value)) return value;

  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(value)) {
    if (ALL_SENSITIVE_KEYS.has(key)) {
      out ??= { ...value };
      delete out[key];
      continue;
    }
    const next = scrub(value[key], depth + 1);
    if (next !== value[key]) {
      out ??= { ...value };
      out[key] = next;
    }
  }
  return out ?? value;
}

/**
 * `value` with every sensitive key, at any depth, removed. Matches by property
 * name, so it also catches a row nested in a payload (an invoice that carries
 * its party, an event whose `changes` mention the column). Returns the input
 * itself when there is nothing to strip, and never mutates it.
 */
export function scrubSensitiveKeys<T>(value: T): T {
  return scrub(value, 0) as T;
}
