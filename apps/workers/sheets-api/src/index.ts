/**
 * WeldSuite sheets-api — WeldSheets' API worker.
 *
 * REST routes for spreadsheet records (/api/sheets), and the room socket
 * every open spreadsheet is edited over: one SheetRoom Durable Object per
 * sheet orders all edits (ADR SHEETS-003). The prefixes it owns are listed
 * in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import type { Env, Variables } from './types';
import sheetsRoutes from './routes/sheets';
import { connectToRoom, isConnectRequest } from './room/connect';

export { SheetRoom } from './room/sheet-room';

const app = createModuleApi<Env, Variables>({ service: 'sheets-api' });

app.use('/api/*', ...apiAuth());

app.route('/api/sheets', sheetsRoutes);

export default {
  fetch(request: Request, env: Env, ctx?: ExecutionContext): Response | Promise<Response> {
    // The room socket authenticates with its own ticket (room/connect.ts).
    if (isConnectRequest(request)) return connectToRoom(request, env);
    return app.fetch(request, env, ctx);
  },
};
