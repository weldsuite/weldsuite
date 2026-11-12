/**
 * Media — POST /api/forms/media. An image for a question, a choice or a theme,
 * stored in the public bucket because respondents see it (PNG, JPEG, GIF, WebP
 * or AVIF, at most 5 MB). Answers its public URL. Stores a file, not an entity,
 * so it publishes no entity event (exempt in routes/_sweeps.test.ts).
 */

import { Hono } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import { success } from '@weldsuite/worker-kit/response';
import { FormsError, handle } from '../../lib/errors';
import { workspaceCtx } from '../../services/context';
import { uploadMedia } from '../../services/settings';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/', requirePermission('forms:update'), (c) =>
  handle(c, async () => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new FormsError(400, 'BAD_REQUEST', 'Send the image as multipart form data in the "file" field.');
    }
    const file = form.get('file');
    if (!file || typeof file === 'string') throw new FormsError(400, 'BAD_REQUEST', 'Send the image in the "file" field.');
    return success(c, await uploadMedia(workspaceCtx(c), file), 201);
  }),
);

export default app;
