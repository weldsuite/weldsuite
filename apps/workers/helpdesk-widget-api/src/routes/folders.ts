/**
 * Widget Folders Routes
 *
 * Returns article folders for the helpdesk widget.
 */

import { Hono } from 'hono';
import { eq, and, isNull } from 'drizzle-orm';
import type { Env, Variables } from '../index';
import { schema } from '../db';
import { success, error } from '../lib/response';

export const foldersRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET / - List all article folders
 *
 * Returns folders that can contain articles in the knowledge base.
 */
foldersRoutes.get('/', async (c) => {
  try {
    const db = c.get('tenantDb');
    const { helpdeskArticleFolders } = schema;

    // Note: workspaceId filter removed - tenant DB is already workspace-scoped
    const results = await db
      .select({
        id: helpdeskArticleFolders.id,
        name: helpdeskArticleFolders.name,
        parentId: helpdeskArticleFolders.parentId,
        sortOrder: helpdeskArticleFolders.sortOrder,
      })
      .from(helpdeskArticleFolders)
      .where(isNull(helpdeskArticleFolders.deletedAt))
      .orderBy(helpdeskArticleFolders.sortOrder);

    const folders = results.map((folder) => ({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      sortOrder: folder.sortOrder || 0,
    }));

    return success(c, folders);
  } catch (err) {
    console.error('[Widget] Failed to fetch folders:', err);
    return error.internal(c, 'Failed to fetch folders');
  }
});

/**
 * GET /:id - Get a single folder
 */
foldersRoutes.get('/:id', async (c) => {
  const folderId = c.req.param('id');

  try {
    const db = c.get('tenantDb');
    const { helpdeskArticleFolders } = schema;

    // Note: workspaceId filter removed - tenant DB is already workspace-scoped
    const results = await db
      .select({
        id: helpdeskArticleFolders.id,
        name: helpdeskArticleFolders.name,
        parentId: helpdeskArticleFolders.parentId,
        sortOrder: helpdeskArticleFolders.sortOrder,
      })
      .from(helpdeskArticleFolders)
      .where(
        and(
          eq(helpdeskArticleFolders.id, folderId),
          isNull(helpdeskArticleFolders.deletedAt)
        )
      )
      .limit(1);

    if (results.length === 0) {
      return error.notFound(c, 'Folder', folderId);
    }

    const folder = results[0];

    return success(c, {
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      sortOrder: folder.sortOrder || 0,
    });
  } catch (err) {
    console.error('[Widget] Failed to fetch folder:', err);
    return error.internal(c, 'Failed to fetch folder');
  }
});
