/**
 * Path cleaning (`panel_path_rules`): `/users/123/settings` → `/users/:id/settings`
 * wherever a report groups or shows pages by path. Each rule is a regular
 * expression and a replacement, applied in order with
 * `regexp_replace(path, pattern, replacement, 'g')`.
 *
 * Basin's regex dialect (Rust's `regex` crate) has no look-around and no
 * back-references, and its replacements know `$1` / `${name}` but not `$&`.
 * {@link pathRuleProblem} refuses what would not run there, so a rule that
 * previews well in JavaScript also runs in SQL. Patterns and replacements
 * reach SQL only through `lit()`.
 */

import type { PanelPathRule } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import {
  PANEL_MAX_PATH_RULES,
  PANEL_MAX_PATH_RULE_LENGTH,
  panelPathPatternProblem,
  panelPathReplacementProblem,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelQueryContext } from './context';
import { PanelQueryError, lit } from './sql';

export const MAX_PATH_RULE_LENGTH = PANEL_MAX_PATH_RULE_LENGTH;

/**
 * Why a rule cannot be used (a message for the member), or null when it is
 * fine. The same checks the saved-rule schema runs, so what the API accepts
 * is what SQL can run.
 */
export function pathRuleProblem(rule: PanelPathRule): string | null {
  if (typeof rule.pattern !== 'string') return 'Enter a pattern';
  return panelPathPatternProblem(rule.pattern) ?? panelPathReplacementProblem(rule.replacement);
}

/** Applies the rules to one path in JavaScript (previews and tests); the SQL does the same. */
export function applyPathRules(path: string, rules: readonly PanelPathRule[]): string {
  return rules.reduce((value, rule) => value.replace(new RegExp(rule.pattern, 'g'), rule.replacement), path);
}

/** The rules a query applies: the context's, unless the spec switched cleaning off. Each one checked. */
export function activePathRules(ctx: PanelQueryContext, cleanPaths: boolean | undefined): readonly PanelPathRule[] {
  if (cleanPaths === false) return [];
  const rules = ctx.pathRules ?? [];
  if (rules.length > PANEL_MAX_PATH_RULES) throw new PanelQueryError(`At most ${PANEL_MAX_PATH_RULES} path rules are applied`);
  for (const rule of rules) {
    const problem = pathRuleProblem(rule);
    if (problem) throw new PanelQueryError(`A path rule cannot be used: ${problem}`);
  }
  return rules;
}

/** `column` with the path rules applied (the column itself when there are none). */
export function cleanedPathSql(ctx: PanelQueryContext, cleanPaths: boolean | undefined, column = 'e.path'): string {
  return activePathRules(ctx, cleanPaths).reduce(
    (expr, rule) => `regexp_replace(${expr}, ${lit(rule.pattern)}, ${lit(rule.replacement)}, 'g')`,
    column,
  );
}
