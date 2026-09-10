/**
 * Social media asset routes — /v1/social-media/*
 *
 * Two create paths:
 *   - POST /          — register metadata for an already-hosted URL
 *   - POST /upload    — store bytes in R2 (base64 or fetched sourceUrl) and
 *                       return a ready asset with a public URL for posts
 *
 * Scopes: social_posts:read | social_posts:write (media is part of posting).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createSocialMediaSchema,
  updateSocialMediaSchema,
} from '@weldsuite/core-api-client/schemas/social-media';
import { schema } from '../../../db';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { generateId } from '../../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import { stripServerFields } from '../../../lib/sanitize';
import {
  SocialMediaUploadError,
  guessMediaType,
  guessMime,
  resolveUploadBytes,
  storeSocialMediaBytes,
} from './upload';

const listSocialMediaQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  mediaType: z.string().optional(),
  status: z.string().optional(),
});

const uploadSocialMediaSchema = z
  .object({
    fileName: z.string().min(1).max(500).optional(),
    /** Raw or data-URL base64 of the file bytes. */
    contentBase64: z.string().min(1).optional(),
    /** HTTPS URL to fetch and store into WeldSuite R2. */
    sourceUrl: z.string().url().optional(),
    mimeType: z.string().max(255).optional(),
    mediaType: z.enum(['image', 'video', 'gif']).optional(),
    altText: z.string().max(2000).optional(),
  })
  .refine((v) => Boolean(v.contentBase64 || v.sourceUrl), {
    message: 'Provide contentBase64 or sourceUrl',
  });

const table = schema.socialMedia;
const app = new Hono<HonoEnv>();

app.get('/', requireScope('social_posts:read'), zValidator('query', listSocialMediaQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [];
  if (q.mediaType) where.push(eq(table.mediaType, q.mediaType as typeof table.mediaType._.data));
  if (q.status) where.push(eq(table.status, q.status as typeof table.status._.data));
  const result = await listWithCursor({ db, table, where, cursor: q.cursor, limit: q.limit });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.post('/upload', requireScope('social_posts:write'), zValidator('json', uploadSocialMediaSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId');
  const storage = c.env.STORAGE;

  if (!storage) return error.internal(c, 'Storage is not configured');
  if (!workspaceId) return error.unauthorized(c);

  try {
    const loaded = await resolveUploadBytes({
      contentBase64: body.contentBase64,
      sourceUrl: body.sourceUrl,
    });
    const fileName =
      body.fileName ||
      loaded.fileName ||
      (body.mediaType === 'video' ? 'upload.mp4' : 'upload.png');

    const id = generateId('smed');
    const stored = await storeSocialMediaBytes({
      storage,
      r2PublicUrl: c.env.R2_PUBLIC_URL,
      workspaceId,
      assetId: id,
      fileName,
      bytes: loaded.bytes,
      mimeType: body.mimeType || loaded.mimeType,
      mediaType: body.mediaType,
    });

    const now = new Date();
    const [row] = await db
      .insert(table)
      .values({
        id,
        createdAt: now,
        updatedAt: now,
        fileName: stored.fileName,
        originalName: stored.originalName,
        mimeType: stored.mimeType,
        fileSize: stored.fileSize,
        mediaType: stored.mediaType,
        storagePath: stored.storagePath,
        url: stored.url,
        thumbnailUrl: stored.mediaType === 'image' || stored.mediaType === 'gif' ? stored.url : null,
        storageProvider: 'r2',
        status: 'ready',
        altText: body.altText ?? null,
        uploadedByUserId: userId,
      } as typeof table.$inferInsert)
      .returning();

    if (!row) return error.internal(c, 'Failed to create social media asset');

    publishEntityEvent({
      c,
      entityType: 'social_media',
      entityId: id,
      action: 'created',
      data: { id, fileName: row.fileName, mediaType: row.mediaType, status: row.status },
    });
    return success(c, row, 201);
  } catch (err) {
    if (err instanceof SocialMediaUploadError) {
      return err.status === 500
        ? error.internal(c, err.message)
        : error.badRequest(c, err.message);
    }
    console.error('[mcp/social-media] upload failed:', err);
    return error.internal(c, 'Failed to upload social media asset');
  }
});

app.get('/:id', requireScope('social_posts:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'SocialMedia', id);
  return success(c, row);
});

app.post('/', requireScope('social_posts:write'), zValidator('json', createSocialMediaSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json') as Record<string, unknown>;
  const userId = c.get('userId');
  const now = new Date();
  const id = generateId('smed');

  const fileName = String(body.fileName ?? 'asset');
  const url = typeof body.url === 'string' ? body.url : undefined;
  const mediaType = guessMediaType(fileName, typeof body.mimeType === 'string' ? body.mimeType : undefined, typeof body.mediaType === 'string' ? body.mediaType : undefined);
  const mimeType =
    (typeof body.mimeType === 'string' && body.mimeType) ||
    (typeof body.contentType === 'string' && body.contentType) ||
    guessMime(fileName, mediaType);
  const fileSize =
    typeof body.fileSize === 'number'
      ? body.fileSize
      : typeof body.size === 'number'
        ? body.size
        : 0;
  const storagePath =
    (typeof body.storagePath === 'string' && body.storagePath) ||
    (url ? `url:${url}` : `social-media/${id}/${fileName}`);

  const [row] = await db
    .insert(table)
    .values({
      ...stripServerFields(body),
      id,
      createdAt: now,
      updatedAt: now,
      fileName,
      originalName: (typeof body.originalName === 'string' && body.originalName) || fileName,
      mimeType,
      fileSize,
      mediaType,
      storagePath,
      url: url ?? null,
      storageProvider: (typeof body.storageProvider === 'string' && body.storageProvider) || (url ? 'url' : 'r2'),
      status: url ? 'ready' : ((body.status as typeof table.status._.data | undefined) ?? 'uploading'),
      altText: typeof body.altText === 'string' ? body.altText : null,
      uploadedByUserId: userId,
    } as typeof table.$inferInsert)
    .returning();
  if (!row) return error.internal(c, 'Failed to create social media asset');
  publishEntityEvent({
    c,
    entityType: 'social_media',
    entityId: id,
    action: 'created',
    data: { id, fileName: row.fileName, mediaType: row.mediaType, status: row.status },
  });
  return success(c, row, 201);
});

app.patch('/:id', requireScope('social_posts:write'), zValidator('json', updateSocialMediaSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(table)
    .set({ ...stripServerFields(body as Record<string, unknown>), updatedAt: new Date() })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'SocialMedia', id);
  publishEntityEvent({
    c,
    entityType: 'social_media',
    entityId: id,
    action: 'updated',
    data: { id, fileName: row.fileName, mediaType: row.mediaType, status: row.status },
  });
  return success(c, row);
});

app.delete('/:id', requireScope('social_posts:write'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .update(table)
    .set({ deletedAt: new Date(), updatedAt: new Date(), status: 'deleted' })
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .returning();
  if (!row) return error.notFound(c, 'SocialMedia', id);
  publishEntityEvent({
    c,
    entityType: 'social_media',
    entityId: id,
    action: 'deleted',
    data: { id },
  });
  return noContent(c);
});

export default app;
