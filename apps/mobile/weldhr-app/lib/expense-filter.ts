/**
 * Filtering a list of expense claims, after Shiftbase's filter sheet: a switch
 * per status (own claims) or category (claims to approve), all on to begin
 * with. The filter keeps what is switched off, which is hidden; an empty
 * filter is the whole list.
 */

import type { HrDeclarationCategory, HrDeclarationStatus } from '@weldsuite/app-api-client/domains/weldhr';

export interface ExpenseFilter {
  /** Statuses switched off. */
  statuses: HrDeclarationStatus[];
  /** Categories switched off. */
  categories: HrDeclarationCategory[];
}

export const NO_FILTER: ExpenseFilter = { statuses: [], categories: [] };

/** The way a claim goes, then the dead ends. */
export const EXPENSE_STATUSES: HrDeclarationStatus[] = ['pending', 'approved', 'paid', 'rejected', 'cancelled'];
export const EXPENSE_CATEGORIES: HrDeclarationCategory[] = [
  'travel',
  'meals',
  'accommodation',
  'equipment',
  'training',
  'other',
];

interface Filterable {
  status: HrDeclarationStatus;
  category: HrDeclarationCategory;
}

export const isFiltered = (filter: ExpenseFilter) => filter.statuses.length > 0 || filter.categories.length > 0;

export const passesFilter = (filter: ExpenseFilter, row: Filterable) =>
  !filter.statuses.includes(row.status) && !filter.categories.includes(row.category);

/** A list with the value in it or taken out, once. */
export const toggled = <T>(values: T[], value: T, included: boolean) =>
  included ? [...values.filter((v) => v !== value), value] : values.filter((v) => v !== value);

/**
 * The statuses and categories to offer: the ones the list has, plus the ones
 * switched off, in sheet order. So no switch is there for nothing.
 */
export function filterChoices(rows: Filterable[], filter: ExpenseFilter) {
  return {
    statuses: EXPENSE_STATUSES.filter((s) => filter.statuses.includes(s) || rows.some((row) => row.status === s)),
    categories: EXPENSE_CATEGORIES.filter(
      (c) => filter.categories.includes(c) || rows.some((row) => row.category === c),
    ),
  };
}
