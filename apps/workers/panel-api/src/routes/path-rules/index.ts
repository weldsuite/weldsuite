/**
 * Path cleaning rules: /api/panel/path-rules/*. Regular expressions on the URL
 * path and their replacements (`^/users/\d+` → `/users/:id`), applied in
 * order wherever reports group or show by path.
 *
 *   GET  /        → ?projectId: the project's rules in order
 *   PUT  /        → ?projectId, `{ rules: [{ pattern, replacement, description? }] }` (≤ 30): replaces the list
 *   POST /test    → `{ rules? | projectId?, paths }`: the cleaned paths, to preview rules before saving
 *
 * Patterns must be valid JavaScript regular expressions of at most 500
 * characters without lookarounds or backreferences (the query engine's
 * dialect does not have them). `panel_reports:read` to read and test;
 * replacing needs `panel_reports:update`, plus `:create` when it adds rules
 * and `:delete` when it removes some. One entity event per rule created,
 * changed or removed.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import {
  applyPanelPathRules,
  setPanelPathRulesSchema,
  testPanelPathRulesSchema,
  type PanelPathRuleTestResult,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelPathRule } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { projectExists } from '../../services/saved-objects';
import { listPathRules, pathRuleEventData, planPathRules, replacePathRules, toPathRuleDto } from '../../services/definitions';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const projectQuery = z.object({ projectId: z.string().min(1).max(30) });

function publish(c: Ctx, row: PanelPathRule, action: 'created' | 'updated' | 'deleted') {
  publishEntityEvent({ c, entityType: 'panel_path_rule', entityId: row.id, action, data: pathRuleEventData(row) });
}

app.get('/', requirePermission('panel_reports:read'), zValidator('query', projectQuery), async (c) => {
  const rules = await listPathRules(c.get('tenantDb'), c.req.valid('query').projectId);
  return list(c, rules.map(toPathRuleDto), cursorPagination(rules.length, false, null));
});

app.put('/', requirePermission('panel_reports:update'), zValidator('query', projectQuery), zValidator('json', setPanelPathRulesSchema), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c);
  const { projectId } = c.req.valid('query');
  const { rules } = c.req.valid('json');
  const db = c.get('tenantDb');
  if (!(await projectExists(db, projectId))) return error.notFound(c, 'Project', projectId);

  const existing = await listPathRules(db, projectId);
  const plan = planPathRules(existing, rules);
  if (plan.created > 0 && !(await hasContextPermission(c, 'panel_reports:create'))) return error.forbidden(c, 'Missing permission: panel_reports:create');
  if (plan.deleted > 0 && !(await hasContextPermission(c, 'panel_reports:delete'))) return error.forbidden(c, 'Missing permission: panel_reports:delete');

  const change = await replacePathRules(db, projectId, rules, existing, userId);
  for (const row of change.created) publish(c, row, 'created');
  for (const row of change.updated) publish(c, row, 'updated');
  for (const row of change.deleted) publish(c, row, 'deleted');
  return list(c, change.rules.map(toPathRuleDto), cursorPagination(change.rules.length, false, null));
});

app.post('/test', requirePermission('panel_reports:read'), zValidator('json', testPanelPathRulesSchema), async (c) => {
  const input = c.req.valid('json');
  let rules: { pattern: string; replacement: string }[];
  if (input.rules) {
    rules = input.rules;
  } else {
    const projectId = input.projectId ?? '';
    const db = c.get('tenantDb');
    if (!(await projectExists(db, projectId))) return error.notFound(c, 'Project', projectId);
    rules = await listPathRules(db, projectId);
  }
  const results: PanelPathRuleTestResult[] = input.paths.map((path) => ({ path, ...applyPanelPathRules(path, rules) }));
  return success(c, { results });
});

export default app;
