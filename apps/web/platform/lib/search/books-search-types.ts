import type { SearchEntityType, SearchResultGroup } from '@weldsuite/app-api-client/schemas/search';
import { isFeatureAvailable } from '@/lib/edition';

/**
 * The WeldBooks records Cmd/Ctrl+K can search besides the usual types: bank
 * lines (amount, counterparty, description), contacts and inbox documents. The
 * Rust search returns them only when a request's `types` names them, each
 * scoped to the legal entities the member may see.
 */
export const BOOKS_SEARCH_TYPES: readonly SearchEntityType[] = ['bank_transaction', 'accounting_contact', 'accounting_document'];

/**
 * The opt-in types to ask for: where WeldBooks is installed and the edition
 * serves them (`books-todo` marks the Rust backend, the only one that searches
 * them), none elsewhere.
 */
export function booksSearchTypes(weldbooksInstalled: boolean): SearchEntityType[] {
  return weldbooksInstalled && isFeatureAvailable('books-todo') ? [...BOOKS_SEARCH_TYPES] : [];
}

/**
 * The groups of the usual search followed by those of the opt-in one; a type
 * both name appears once, from the first.
 */
export function mergeSearchGroups(
  ...lists: ReadonlyArray<readonly SearchResultGroup[] | undefined>
): SearchResultGroup[] {
  const seen = new Set<string>();
  const merged: SearchResultGroup[] = [];
  for (const list of lists) {
    for (const group of list ?? []) {
      if (seen.has(group.type)) continue;
      seen.add(group.type);
      merged.push(group);
    }
  }
  return merged;
}
