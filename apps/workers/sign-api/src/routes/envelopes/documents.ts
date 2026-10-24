/**
 * Documents of a draft or a template — /api/sign/{envelopes,templates}/:id/documents/*.
 *
 *   POST   /                  → upload a PDF (multipart field `file`)
 *   PUT    /order             → reorder ({ documentIds })
 *   GET    /:documentId/content → the original PDF bytes
 *   DELETE /:documentId       → remove it and its fields
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { reorderDocumentsSchema } from '@weldsuite/app-api-client/schemas/weldsign';
import type { Env, Variables } from '../../types';
import { toDocumentDto, touchEnvelope } from '../../services/envelopes';
import { addDocument, getDocument, removeDocument, reorderDocuments } from '../../services/documents';
import { invalid } from '../../services/errors';
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
