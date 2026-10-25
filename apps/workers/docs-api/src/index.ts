/**
 * WeldSuite docs-api — WeldDocs' API worker.
 *
 * REST routes for document records (/api/docs), and the room socket every
 * open document is edited over: one DocRoom Durable Object per document
 * orders all edits (docs/plans/welddocs.md). The prefixes it owns are listed
 * in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import type { Env, Variables } from './types';
import docsRoutes from './routes/docs';
import { connectToRoom, isConnectRequest } from './room/connect';

export { DocRoom } from './room/doc-room';

const app = createModuleApi<Env, Variables>({ service: 'docs-api' });

app.use('/api/*', ...apiAuth());

app.route('/api/docs', docsRoutes);

export default {
  fetch(request: Request, env: Env, ctx?: ExecutionContext): Response | Promise<Response> {
    // The room socket authenticates with its own ticket (room/connect.ts).
    if (isConnectRequest(request)) return connectToRoom(request, env);
    return app.fetch(request, env, ctx);
  },
};
