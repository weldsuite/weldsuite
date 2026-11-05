/**
 * The risk category manager's draft: the built-ins it hides and the custom
 * categories as the dialog edits them, checked before saving with the rules
 * flow-api applies (`@weldsuite/flow-domain/risk-categories`), plus one the
 * API cannot know: a name that is a built-in's label in the viewer's locale.
 */

import {
  MAX_CUSTOM_RISK_CATEGORIES,
  RISK_CATEGORIES,
  type BuiltInRiskCategory,
} from '@weldsuite/app-api-client/schemas/project-control';
import type { RiskCategories, UpdateRiskCategoriesInput } from '@weldsuite/app-api-client/domains/project-control';

export interface CategoryDraftRow {
  /** Stable React key: the category id, or a local one for a new row. */
  uid: string;
  /** Absent for a category added in this dialog. */
  id?: string;
  name: string;
}

export interface CategoryDraft {
  hidden: BuiltInRiskCategory[];
  custom: CategoryDraftRow[];
}

export type CategoryRowError = 'empty' | 'duplicate' | 'builtIn';

export function draftFromCategories(categories: RiskCategories): CategoryDraft {
  return {
    hidden: categories.builtIn.filter((entry) => entry.hidden).map((entry) => entry.key),
    custom: categories.custom.map((entry) => ({ uid: entry.id, id: entry.id, name: entry.name })),
  };
}

/**
 * Why each row cannot be saved, by `uid`. A row repeating an earlier row's
 * name (ignoring case and spaces) is the duplicate; `builtInLabels` are the
 * built-ins' labels in the viewer's locale.
 */
export function draftRowErrors(rows: readonly CategoryDraftRow[], builtInLabels: readonly string[]): Map<string, CategoryRowError> {
  const reserved = new Set([...RISK_CATEGORIES, ...builtInLabels.map((label) => label.toLowerCase())]);
  const seen = new Set<string>();
  const errors = new Map<string, CategoryRowError>();
  for (const row of rows) {
    const folded = row.name.trim().toLowerCase();
    if (!folded) errors.set(row.uid, 'empty');
    else if (reserved.has(folded)) errors.set(row.uid, 'builtIn');
    else if (seen.has(folded)) errors.set(row.uid, 'duplicate');
    seen.add(folded);
  }
  return errors;
}

export function canAddCategory(draft: CategoryDraft): boolean {
  return draft.custom.length < MAX_CUSTOM_RISK_CATEGORIES;
}

export function draftBody(draft: CategoryDraft): UpdateRiskCategoriesInput {
  return {
    hidden: RISK_CATEGORIES.filter((key) => draft.hidden.includes(key)),
    custom: draft.custom.map((row) => (row.id ? { id: row.id, name: row.name.trim() } : { name: row.name.trim() })),
  };
}
