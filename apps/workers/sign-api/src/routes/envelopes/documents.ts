/**
 * Documents of a draft or a template — /api/sign/{envelopes,templates}/:id/documents/*.
 *
 *   POST   /                  → upload a PDF (multipart field `file`)
 *   POST   /from-drive        → copy in a WeldDrive PDF ({ fileId }; also `files:read`)
 *   PUT    /order             → reorder ({ documentIds })
 *   GET    /:documentId/content → the original PDF bytes
 *   DELETE /:documentId       → remove it and its fields
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { getStoredObject, isWorkspaceObjectKey } from '@weldsuite/worker-kit/storage';
import { addDocumentFromDriveSchema, reorderDocumentsSchema } from '@weldsuite/app-api-client/schemas/weldsign';
import type { Env, Variables } from '../../types';
import { toDocumentDto, touchEnvelope } from '../../services/envelopes';
import { addDocument, getDocument, removeDocument, reorderDocuments } from '../../services/documents';
import { invalid, notFound } from '../../services/errors';
import { visibleDriveFile } from '../../services/sources';
import type { DraftScope } from '../draft-scope';
import { handle } from './shared';

export function createDocumentsRoutes(scope: DraftScope) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.post('/', requirePermission(scope.update), (c) =>
    handle(c, async () => {
      const workspaceId = c.get('workspaceId');
      if (!workspaceId) return error.orgRequired(c);
      const db = c.get('tenantDb');
      const envelope = await scope.loadEditable(c);
      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) throw invalid('Send the PDF as a multipart "file" field');
      const doc = await addDocument(db, c.env.PRIVATE_STORAGE, {
        workspaceId,
        envelope,
        fileName: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      await touchEnvelope(db, envelope.id);
      scope.changed(c, envelope);
      return success(c, toDocumentDto(doc), 201);
    }),
  );

  // A WeldDrive PDF the member may open: its bytes are copied in, so later
  // edits or a delete in Drive never change what is signed.
  app.post('/from-drive', requirePermission(scope.update), requirePermission('files:read'), zValidator('json', addDocumentFromDriveSchema), (c) =>
    handle(c, async () => {
      const workspaceId = c.get('workspaceId');
      const userId = c.get('userId');
      if (!workspaceId) return error.orgRequired(c);
      if (!userId) return error.unauthorized(c);
      const db = c.get('tenantDb');
      const envelope = await scope.loadEditable(c);
      const { fileId } = c.req.valid('json');
      const file = await visibleDriveFile(db, userId, fileId);
      const key = file ? file.fileKey || file.storagePath : null;
      // A row's key is client-supplied: only ever read this workspace's objects.
      if (!file || !key || !isWorkspaceObjectKey(key, workspaceId)) throw notFound('File', fileId);
      if (file.mimeType !== 'application/pdf' && !file.fileName.toLowerCase().endsWith('.pdf')) throw invalid('Only PDF files can be signed');
      const object = await getStoredObject(c.env, key);
      if (!object) throw notFound('File', fileId);
      const doc = await addDocument(db, c.env.PRIVATE_STORAGE, {
        workspaceId,
        envelope,
        fileName: file.fileName,
        bytes: new Uint8Array(await object.arrayBuffer()),
      });
      await touchEnvelope(db, envelope.id);
      scope.changed(c, envelope);
      return success(c, toDocumentDto(doc), 201);
    }),
  );

  app.put('/order', requirePermission(scope.update), zValidator('json', reorderDocumentsSchema), (c) =>
    handle(c, async () => {
      const db = c.get('tenantDb');
      const envelope = await scope.loadEditable(c);
      const docs = await reorderDocuments(db, envelope.id, c.req.valid('json').documentIds);
      await touchEnvelope(db, envelope.id);
      scope.changed(c, envelope);
      return success(c, docs.map(toDocumentDto));
    }),
  );

  app.get('/:documentId/content', requirePermission(scope.read), (c) =>
    handle(c, async () => {
      const db = c.get('tenantDb');
      const envelope = await scope.loadReadable(c);
      const doc = await getDocument(db, envelope.id, c.req.param('documentId'));
      const object = await c.env.PRIVATE_STORAGE.get(doc.storageKey);
      if (!object) return error.notFound(c, 'Document file', doc.id);
      return new Response(object.body, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${doc.name.replaceAll('"', '')}"`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }),
  );

  app.delete('/:documentId', requirePermission(scope.update), (c) =>
    handle(c, async () => {
      const db = c.get('tenantDb');
      const envelope = await scope.loadEditable(c);
      const key = await removeDocument(db, envelope.id, c.req.param('documentId'));
      c.executionCtx.waitUntil(c.env.PRIVATE_STORAGE.delete(key));
      await touchEnvelope(db, envelope.id);
      scope.changed(c, envelope);
      return noContent(c);
    }),
  );

  return app;
}
