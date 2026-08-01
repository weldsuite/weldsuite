/**
 * A WeldCommerce customer is either a company or a person.
 *
 * The identity layer has two objects — `companies` (organisations) and
 * `people` (individuals) — and "Customer" / "Supplier" / "Lead" are status
 * flags on the row rather than separate object types (see the header comments
 * on `schemas/companies.ts` and the `/people` route). So the customers list
 * unions both surfaces and keeps `kind` on each row to route the click, the
 * edit and the delete to the right object.
 *
 * `displayName` is server-stamped on both objects, so the name column never
 * has to branch or fall back — the same invariant the Companies/People
 * refactor introduced to kill the empty-name bug.
 */

import type { Company } from '@weldsuite/app-api-client/schemas/companies';
import type { Person } from '@weldsuite/core-api-client/schemas/people';

export type CustomerKind = 'company' | 'person';

export interface CustomerRow {
  id: string;
  kind: CustomerKind;
  displayName: string;
  email?: string | null;
  phone?: string | null;
  /** Industry for a company, job title for a person. */
  subtitle?: string | null;
  status?: string | null;
  /** The underlying record, for the edit dialog. */
  source: Company | Person;
}

export function companyToCustomerRow(c: Company): CustomerRow {
  return {
    id: c.id,
    kind: 'company',
    displayName: c.displayName ?? c.name,
    email: c.email,
    phone: c.phone,
    subtitle: c.industry,
    status: c.status,
    source: c,
  };
}

export function personToCustomerRow(p: Person): CustomerRow {
  return {
    id: p.id,
    kind: 'person',
    displayName: p.displayName,
    email: p.email,
    // People carry two numbers; the direct line is the business-facing one.
    phone: p.directPhone ?? p.mobilePhone,
    subtitle: p.title,
    status: p.status,
    source: p,
  };
}

/**
 * Two independent cursor-paged sources can't share one cursor, so the merged
 * list is sorted by name. That keeps ordering stable as further pages arrive
 * from either side, which a naive concat does not.
 */
export function mergeCustomerRows(companies: Company[], people: Person[]): CustomerRow[] {
  return [...companies.map(companyToCustomerRow), ...people.map(personToCustomerRow)].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );
}
