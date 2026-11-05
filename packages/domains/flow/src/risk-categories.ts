/**
 * The workspace's risk categories (`flow_workspace_settings.risk_categories`):
 * the built-ins it hides and the categories it added. Pure functions shared by
 * the flow-api route and its tests; the Rust flow module mirrors them
 * (`rust/modules/flow/src/raid/categories.rs`), messages included.
 *
 * A risk stores a built-in by key (`technical`) and a custom category by name
 * (`Security`). Saving a kept id under a new name is a rename: the route moves
 * every risk that carries the old name to the new one.
 */

import {
  RISK_CATEGORIES,
  type RiskCategories,
  type UpdateRiskCategoriesInput,
} from '@weldsuite/app-api-client/schemas/project-control';

/** What the column holds (`RiskCategorySettings` in `@weldsuite/db`). */
export interface StoredRiskCategories {
  hidden: string[];
  custom: Array<{ id: string; name: string }>;
}

export const RISK_CATEGORY_MESSAGES = {
  duplicate: (name: string) => `There are two categories called "${name}"`,
  builtIn: (name: string) => `"${name}" is a built-in category`,
  unknownId: (id: string) => `Unknown category id: ${id}`,
} as const;

/** A rename to carry over to the risks: every item whose category is `from` gets `to`. */
export interface RiskCategoryRename {
  from: string;
  to: string;
}

/** The list as the API answers it: every built-in with its hidden flag, then the custom ones. */
export function presentRiskCategories(stored: StoredRiskCategories | null): RiskCategories {
  const hidden = new Set(stored?.hidden ?? []);
  return {
    builtIn: RISK_CATEGORIES.map((key) => ({ key, hidden: hidden.has(key) })),
    custom: (stored?.custom ?? []).map(({ id, name }) => ({ id, name })),
  };
}

export type RiskCategoryPlan =
  | { ok: true; next: StoredRiskCategories; renames: RiskCategoryRename[] }
  | { ok: false; message: string };

/**
 * The list to store and the renames to carry over, or why the body is refused.
 * Checked in body order: an unknown id, then a name that is a built-in key,
 * then a name given twice (case-insensitive). New categories get `newId()`.
 */
export function planRiskCategories(
  stored: StoredRiskCategories | null,
  input: UpdateRiskCategoriesInput,
  newId: () => string,
): RiskCategoryPlan {
  const existing = new Map((stored?.custom ?? []).map((category) => [category.id, category.name]));
  const builtIns = new Set<string>(RISK_CATEGORIES);
  const seen = new Set<string>();
  const custom: StoredRiskCategories['custom'] = [];
  const renames: RiskCategoryRename[] = [];

  for (const entry of input.custom) {
    if (entry.id !== undefined && !existing.has(entry.id)) {
      return { ok: false, message: RISK_CATEGORY_MESSAGES.unknownId(entry.id) };
    }
    const folded = entry.name.toLowerCase();
    if (builtIns.has(folded)) return { ok: false, message: RISK_CATEGORY_MESSAGES.builtIn(entry.name) };
    if (seen.has(folded)) return { ok: false, message: RISK_CATEGORY_MESSAGES.duplicate(entry.name) };
    seen.add(folded);

    if (entry.id === undefined) {
      custom.push({ id: newId(), name: entry.name });
      continue;
    }
    const before = existing.get(entry.id)!;
    if (before !== entry.name) renames.push({ from: before, to: entry.name });
    custom.push({ id: entry.id, name: entry.name });
  }

  const hidden = RISK_CATEGORIES.filter((key) => input.hidden.includes(key));
  return { ok: true, next: { hidden, custom }, renames };
}
