/**
 * Customer-status validation shared by company writes.
 *
 * A company's `status` is one of the five locked built-in statuses or a slug
 * from the workspace's configured statuses (Settings > WeldCRM > Customer
 * statuses, table `crm_customer_statuses`). The column is free text, so
 * without this check an API caller (or an import) could save any string and
 * the grid would render a status that exists nowhere in the picker.
 */

import { and, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';

/** The built-in statuses every workspace starts with. Keep in sync with the platform's `CUSTOMER_STATUS_OPTIONS`. */
export const BUILTIN_CUSTOMER_STATUSES = [
  'prospect',
  'active',
  'inactive',
  'churned',
  'blacklisted',
] as const;

export class InvalidStatusError extends Error {
  readonly isValidationError = true as const;
  readonly field = 'status';
  constructor(public readonly value: string) {
    super(`"${value}" is not a configured customer status`);
    this.name = 'InvalidStatusError';
  }
}

export interface CustomerStatusLookup {
  /** Exact, configured status keys (built-ins + workspace slugs). */
  keys: Set<string>;
  /** Lowercased slug / display name -> status key, for forgiving imports. */
  byLooseName: Map<string, string>;
}

/** Built-in keys plus the workspace's configured (non-deleted) status slugs. */
export async function loadCustomerStatusLookup(db: Database): Promise<CustomerStatusLookup> {
  const { crmCustomerStatuses } = schema;
  const rows = await db
    .select({ slug: crmCustomerStatuses.slug, name: crmCustomerStatuses.name })
    .from(crmCustomerStatuses)
    .where(and(isNull(crmCustomerStatuses.deletedAt)));

  const keys = new Set<string>(BUILTIN_CUSTOMER_STATUSES);
  const byLooseName = new Map<string, string>();
  for (const key of BUILTIN_CUSTOMER_STATUSES) byLooseName.set(key, key);
  for (const row of rows) {
    keys.add(row.slug);
    byLooseName.set(row.slug.toLowerCase(), row.slug);
    // A display name never shadows a slug.
    const name = row.name.trim().toLowerCase();
    if (name && !byLooseName.has(name)) byLooseName.set(name, row.slug);
  }
  return { keys, byLooseName };
}

/**
 * Throws `InvalidStatusError` when `status` is set to something that is not a
 * configured status key. `undefined` (field omitted) is never checked.
 */
export async function assertValidCustomerStatus(
  db: Database,
  status: string | null | undefined,
  lookup?: CustomerStatusLookup,
): Promise<void> {
  if (status === undefined || status === null) return;
  const { keys } = lookup ?? (await loadCustomerStatusLookup(db));
  if (!keys.has(status)) throw new InvalidStatusError(status);
}
