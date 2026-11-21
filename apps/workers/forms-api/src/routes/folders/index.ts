/**
 * Folder routes — /api/forms/folders/*. Folders group forms on the home page.
 *
 *   GET    /      → every folder with its form count
 *   POST   /      → new folder
 *   PATCH  /:id   → rename or reorder
 *   DELETE /:id   → delete (forms in it move to "no folder")
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { noContent, success } from '@weldsuite/worker-kit/response';
import { createFormFolderSchema, updateFormFolderSchema } from '@weldsuite/app-api-client/schemas/weldforms';
import { handle } from '../../lib/errors';
import { workspaceCtx } from '../../services/context';
import { supportEventData } from '../../services/events';
import { createFolder, deleteFolder, listFolders, loadFolder, updateFolder } from '../../services/folders-themes';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('forms:read'), (c) => handle(c, async () => success(c, await listFolders(workspaceCtx(c)))));

app.post('/', requirePermission('forms:create'), zValidator('json', createFormFolderSchema), (c) =>
  handle(c, async () => {
    const folder = await createFolder(workspaceCtx(c), c.req.valid('json'));
    publishEntityEvent({ c, entityType: 'form_folder', entityId: folder.id, action: 'created', data: supportEventData(folder) });
    return success(c, folder, 201);
  }),
);

app.patch('/:id', requirePermission('forms:update'), zValidator('json', updateFormFolderSchema), (c) =>
  handle(c, async () => {
    const ctx = workspaceCtx(c);
    const folder = await updateFolder(ctx, await loadFolder(ctx, c.req.param('id')), c.req.valid('json'));
    publishEntityEvent({ c, entityType: 'form_folder', entityId: folder.id, action: 'updated', data: supportEventData(folder) });
    return success(c, folder);
  }),
);

app.delete('/:id', requirePermission('forms:delete'), (c) =>
  handle(c, async () => {
    const ctx = workspaceCtx(c);
    const folder = await loadFolder(ctx, c.req.param('id'));
    await deleteFolder(ctx, folder);
    publishEntityEvent({ c, entityType: 'form_folder', entityId: folder.id, action: 'deleted', data: supportEventData(folder) });
    return noContent(c);
  }),
);

export default app;
