/**
 * Fields of a draft or a template — /api/sign/{envelopes,templates}/:id/fields.
 *
 *   PUT /   → replace the whole field set ({ fields }); returns it with ids
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { success } from '@weldsuite/worker-kit/response';
import { replaceFieldsSchema } from '@weldsuite/app-api-client/schemas/weldsign';
import type { Env, Variables } from '../../types';
import { toFieldDto, touchEnvelope } from '@weldsuite/sign-domain/envelopes';
import { replaceFields } from '@weldsuite/sign-domain/fields';
import type { DraftScope } from '../draft-scope';
import { handle } from './shared';

export function createFieldsRoutes(scope: DraftScope) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();

  app.put('/', requirePermission(scope.update), zValidator('json', replaceFieldsSchema), (c) =>
    handle(c, async () => {
      const db = c.get('tenantDb');
      const envelope = await scope.loadEditable(c);
      const fields = await replaceFields(db, envelope.id, c.req.valid('json').fields);
      await touchEnvelope(db, envelope.id);
      scope.changed(c, envelope);
      return success(c, fields.map(toFieldDto));
    }),
  );

  return app;
}
