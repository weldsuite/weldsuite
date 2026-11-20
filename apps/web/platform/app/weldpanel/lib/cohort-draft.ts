/**
 * The cohort editor's draft: conditions as the form holds them (a value is
 * text until it is turned into a typed filter value), converted to and from
 * the contract's `panelCohortFilterSchema` shape.
 */

import {
  panelCohortFilterSchema,
  type PanelCohortCondition,
  type PanelCohortFilter,
  type PanelFilter,
  type PanelFilterOperator,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { formatFilterValue, operatorNeedsValue, parseFilterValue, type FilterLabels } from './filters';

export type ConditionDraft =
  | { type: 'person_property'; key: string; operator: PanelFilterOperator; text: string }
  | { type: 'performed'; event: string; filters: PanelFilter[]; withinDays: number; minCount: number; negate: boolean };

export interface CohortDraft {
  match: 'all' | 'any';
  conditions: ConditionDraft[];
}

export function emptyCondition(type: ConditionDraft['type']): ConditionDraft {
  return type === 'person_property'
    ? { type, key: '', operator: 'eq', text: '' }
    : { type, event: '', filters: [], withinDays: 30, minCount: 1, negate: false };
}

export function emptyCohortDraft(): CohortDraft {
  return { match: 'all', conditions: [emptyCondition('person_property')] };
}

/** The contract's condition for a draft, or null while it is incomplete. */
export function conditionFromDraft(draft: ConditionDraft): PanelCohortCondition | null {
  if (draft.type === 'person_property') {
    if (draft.key.trim() === '') return null;
    const value = parseFilterValue(draft.text, draft.operator);
    if (operatorNeedsValue(draft.operator) && value === undefined) return null;
    return { type: 'person_property', key: draft.key.trim(), operator: draft.operator, ...(value === undefined ? {} : { value }) };
  }
  if (draft.event.trim() === '') return null;
  return { type: 'performed', event: draft.event, filters: draft.filters, withinDays: draft.withinDays, minCount: draft.minCount, negate: draft.negate };
}

/** The cohort filter to save, or null when a condition is incomplete or the schema refuses it. */
export function cohortFilterFromDraft(draft: CohortDraft): PanelCohortFilter | null {
  const conditions = draft.conditions.map(conditionFromDraft);
  if (conditions.length === 0 || conditions.some((c) => c === null)) return null;
  const filter = { match: draft.match, conditions: conditions as PanelCohortCondition[] };
  return panelCohortFilterSchema.safeParse(filter).success ? filter : null;
}

/** A stored cohort filter back into a draft; null when it no longer parses. */
export function draftFromCohortFilter(stored: Record<string, unknown>): CohortDraft | null {
  const parsed = panelCohortFilterSchema.safeParse(stored);
  if (!parsed.success) return null;
  return {
    match: parsed.data.match,
    conditions: parsed.data.conditions.map((c): ConditionDraft =>
      c.type === 'person_property'
        ? { type: 'person_property', key: c.key, operator: c.operator, text: formatFilterValue(c.value) }
        : { type: 'performed', event: c.event, filters: c.filters, withinDays: c.withinDays, minCount: c.minCount, negate: c.negate },
    ),
  };
}

type SummaryLabels = { person: string; personNoValue: string; did: string; didNot: string; separator: string; all: string; any: string };

/** "All of: plan is pro; did Signed up 1× in 30 days" for a stored cohort filter. */
export function summariseCohortFilter(stored: Record<string, unknown>, labels: SummaryLabels, filterLabels: FilterLabels): string {
  const parsed = panelCohortFilterSchema.safeParse(stored);
  if (!parsed.success) return '';
  const parts = parsed.data.conditions.map((c) => {
    if (c.type === 'person_property') {
      const operator = filterLabels.operators[c.operator];
      const template = operatorNeedsValue(c.operator) ? labels.person : labels.personNoValue;
      return template.replace('{key}', c.key).replace('{operator}', operator).replace('{value}', formatFilterValue(c.value));
    }
    const template = c.negate ? labels.didNot : labels.did;
    return template.replace('{event}', c.event).replace('{times}', String(c.minCount)).replace('{days}', String(c.withinDays));
  });
  return (parsed.data.match === 'all' ? labels.all : labels.any).replace('{conditions}', parts.join(labels.separator));
}
