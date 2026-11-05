/**
 * WeldSuite board-api — WeldBoard's API worker.
 *
 * REST routes for board records (/api/boards), and the room socket every open
 * board is edited over: one BoardRoom Durable Object per board orders all
 * edits (docs/plans/weldboard.md). The prefixes it owns are listed in
 * @weldsuite/api-modules and checked by its ownership test.
 *
 * `BoardsInternal` (a WorkerEntrypoint) lets other workers read boards and
 * apply ops through their rooms: flow-api's and external-api's deprecated
 * whiteboard façades, and the WeldAgent tools.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import type { Env, Variables } from './types';
import boardRoutes from './routes/boards';
import { connectToRoom, isConnectRequest } from './room/connect';

export { BoardRoom } from './room/board-room';
export { BoardsInternal } from './internal';

const app = createModuleApi<Env, Variables>({ service: 'board-api' });

app.use('/api/*', ...apiAuth());

app.route('/api/boards', boardRoutes);

export default {
  fetch(request: Request, env: Env, ctx?: ExecutionContext): Response | Promise<Response> {
    // The room socket authenticates with its own ticket (room/connect.ts).
    if (isConnectRequest(request)) return connectToRoom(request, env);
    return app.fetch(request, env, ctx);
  },
};
