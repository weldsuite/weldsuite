/**
 * Theme routes — /api/forms/themes/*. A theme is a workspace-level look
 * (fonts, colours, background, logo); one of them is the default. Reading is
 * `forms:read`; changing them needs `forms:manage`, as it restyles every form
 * that picks the theme.
 *
 *   GET    /      → every theme
 *   POST   /      → new theme (`isDefault` makes it the only default)
 *   PATCH  /:id   → change it
 *   DELETE /:id   → delete (forms using it fall back to the default)
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { noContent, success } from '@weldsuite/worker-kit/response';
import { createFormThemeSchema, updateFormThemeSchema } from '@weldsuite/app-api-client/schemas/weldforms';
import { handle } from '../../lib/errors';
import { workspaceCtx } from '../../services/context';
import { supportEventData } from '../../services/events';
import { createTheme, deleteTheme, listThemes, loadTheme, updateTheme } from '../../services/folders-themes';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('forms:read'), (c) => handle(c, async () => success(c, await listThemes(workspaceCtx(c)))));

app.post('/', requirePermission('forms:manage'), zValidator('json', createFormThemeSchema), (c) =>
  handle(c, async () => {
    const theme = await createTheme(workspaceCtx(c), c.get('userId'), c.req.valid('json'));
    publishEntityEvent({ c, entityType: 'form_theme', entityId: theme.id, action: 'created', data: supportEventData(theme) });
    return success(c, theme, 201);
  }),
);

app.patch('/:id', requirePermission('forms:manage'), zValidator('json', updateFormThemeSchema), (c) =>
  handle(c, async () => {
    const ctx = workspaceCtx(c);
    const theme = await updateTheme(ctx, await loadTheme(ctx, c.req.param('id')), c.req.valid('json'));
    publishEntityEvent({ c, entityType: 'form_theme', entityId: theme.id, action: 'updated', data: supportEventData(theme) });
    return success(c, theme);
  }),
);

app.delete('/:id', requirePermission('forms:manage'), (c) =>
  handle(c, async () => {
    const ctx = workspaceCtx(c);
    const theme = await loadTheme(ctx, c.req.param('id'));
    await deleteTheme(ctx, theme);
    publishEntityEvent({ c, entityType: 'form_theme', entityId: theme.id, action: 'deleted', data: supportEventData(theme) });
    return noContent(c);
  }),
);

export default app;
