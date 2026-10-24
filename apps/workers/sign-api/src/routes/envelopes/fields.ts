/**
 * Fields of a draft — /api/sign/envelopes/:id/fields.
 *
 *   PUT /   → replace the whole field set ({ fields }); returns it with ids
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { success } from '@weldsuite/worker-kit/response';
import { replaceFieldsSchema } from '@weldsuite/app-api-client/schemas/weldsign';
import type { Env, Variables } from '../../types';
import { loadDraft, toFieldDto, touchEnvelope } from '../../services/envelopes';
import { replaceFields } from '../../services/fields';
import { handle, publishEnvelopeUpdated, viewerOf } from './shared';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.put('/', requirePermission('sign_envelopes:update'), zValidator('json', replaceFieldsSchema), (c) =>
  handle(c, async () => {
    const db = c.get('tenantDb');
    const envelope = await loadDraft(db, c.req.param('id')!, await viewerOf(c));
    const fields = await replaceFields(db, envelope.id, c.req.valid('json').fields);
    await touchEnvelope(db, envelope.id);
    publishEnvelopeUpdated(c, envelope);
    return success(c, fields.map(toFieldDto));
  }),
);

export default app;
