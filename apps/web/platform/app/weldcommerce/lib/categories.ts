/**
 * Category helpers shared by the categories page, the category dialog and
 * its rules editor: the tree flattened for lists and pickers, and what a rule
 * may say about each product field (the server's whitelist).
 */

import {
  CATEGORY_RULE_COLUMNS,
  type CategoryRule,
  type CategoryRuleColumn,
  type CategoryRuleRelation,
  type CommerceCategory,
  type CommerceCategoryNode,
} from '@/hooks/queries/use-commerce-queries';

/**
 * The forest depth-first, parents directly above their children, without the
 * `children` arrays: the order a list or a parent picker shows it in.
 */
export function flattenCategoryTree(nodes: readonly CommerceCategoryNode[]): CommerceCategory[] {
  const out: CommerceCategory[] = [];
  const walk = (list: readonly CommerceCategoryNode[]) => {
    for (const { children, ...category } of list) {
      out.push(category);
      if (children?.length) walk(children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * The ids of a category and everything below it. A category can't move under
 * itself or one of its descendants (the cycle the API refuses), so the parent
 * picker leaves these out.
 */
export function subtreeIds(nodes: readonly CommerceCategoryNode[], rootId: string): Set<string> {
  const ids = new Set<string>();
  const collect = (node: CommerceCategoryNode) => {
    ids.add(node.id);
    node.children?.forEach(collect);
  };
  const find = (list: readonly CommerceCategoryNode[]): boolean => {
    for (const node of list) {
      if (node.id === rootId) {
        collect(node);
        return true;
      }
      if (node.children?.length && find(node.children)) return true;
    }
    return false;
  };
  if (!find(nodes)) ids.add(rootId);
  return ids;
}

/** Fields compared as numbers. */
const NUMBER_COLUMNS: ReadonlySet<CategoryRuleColumn> = new Set([
  'price',
  'compareAtPrice',
  'weight',
  'inventoryQuantity',
]);

const TEXT_RELATIONS: readonly CategoryRuleRelation[] = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
];
const NUMBER_RELATIONS: readonly CategoryRuleRelation[] = ['equals', 'not_equals', 'greater_than', 'less_than'];
/** A product either has a tag or it doesn't. */
const TAG_RELATIONS: readonly CategoryRuleRelation[] = ['equals'];

export function isNumberColumn(column: CategoryRuleColumn): boolean {
  return NUMBER_COLUMNS.has(column);
}

/** The relations the server accepts for a field. */
export function relationsFor(column: CategoryRuleColumn): readonly CategoryRuleRelation[] {
  if (column === 'tag') return TAG_RELATIONS;
  return isNumberColumn(column) ? NUMBER_RELATIONS : TEXT_RELATIONS;
}

export function isRuleColumn(value: string): value is CategoryRuleColumn {
  return (CATEGORY_RULE_COLUMNS as readonly string[]).includes(value);
}

/** A rule for a field, with its first relation; what "Add rule" and a field change start from. */
export function newRule(column: CategoryRuleColumn = 'name', condition = ''): CategoryRule {
  return { column, relation: relationsFor(column)[0], condition };
}

/** A rule moved to another field keeps its relation when the field allows it, else takes the first one. */
export function withColumn(rule: CategoryRule, column: CategoryRuleColumn): CategoryRule {
  const relations = relationsFor(column);
  return { column, relation: relations.includes(rule.relation) ? rule.relation : relations[0], condition: rule.condition };
}

export type RuleProblem = 'condition' | 'number';

/** What is wrong with a rule, or null when the server would take it. */
export function ruleProblem(rule: CategoryRule): RuleProblem | null {
  const condition = rule.condition.trim();
  if (!condition) return 'condition';
  if (isNumberColumn(rule.column) && !Number.isFinite(Number(condition))) return 'number';
  return null;
}

/** The rules with their conditions trimmed, as they are sent. */
export function cleanRules(rules: readonly CategoryRule[]): CategoryRule[] {
  return rules.map((rule) => ({ ...rule, condition: rule.condition.trim() }));
}

/** True when there is at least one rule and every rule is complete. */
export function rulesAreComplete(rules: readonly CategoryRule[]): boolean {
  return rules.length > 0 && rules.every((rule) => ruleProblem(rule) === null);
}
