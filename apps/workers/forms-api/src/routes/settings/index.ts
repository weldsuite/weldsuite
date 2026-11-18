/**
 * Workspace settings and usage — /api/forms/settings, /api/forms/usage.
 *
 *   GET   /settings   → defaults for the workspace (default theme, sender name, reminders, badge)
 *   PATCH /settings   → change them (`forms:manage`)
 *   GET   /usage      → completed responses this UTC month against the plan's quota
 *
 * Both are mounted at /api/forms (the paths are fixed by the client), after
 * /api/forms/forms and the other object prefixes.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { success } from '@weldsuite/worker-kit/response';
import { updateFormsWorkspaceSettingsSchema } from '@weldsuite/app-api-client/schemas/weldforms';
import { handle } from '../../lib/errors';
import { workspaceCtx } from '../../services/context';
import { getWorkspaceSettings, updateWorkspaceSettings } from '../../services/settings';
import { loadUsage } from '../../services/usage';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/settings', requirePermission('forms:read'), (c) => handle(c, async () => success(c, await getWorkspaceSettings(workspaceCtx(c)))));

app.patch('/settings', requirePermission('forms:manage'), zValidator('json', updateFormsWorkspaceSettingsSchema), (c) =>
  handle(c, async () => success(c, await updateWorkspaceSettings(workspaceCtx(c), c.req.valid('json')))),
);

app.get('/usage', requirePermission('forms:read'), (c) =>
  handle(c, async () => {
    // Everything but `workspacePlan`, which is for the server's own checks.
    const { periodStart, periodEnd, used, limit, plan } = await loadUsage(workspaceCtx(c));
    return success(c, { periodStart, periodEnd, used, limit, plan });
  }),
);

export default app;
