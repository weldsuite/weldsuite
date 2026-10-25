/**
 * WeldSuite sheets-api — WeldSheets' API worker.
 *
 * REST routes for spreadsheet records (/api/sheets), and the room socket
 * every open spreadsheet is edited over: one SheetRoom Durable Object per
 * sheet orders all edits (ADR SHEETS-003). The prefixes it owns are listed
 * in @weldsuite/api-modules and checked by its ownership test.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import type { Env, Variables } from './types';
import sheetsRoutes from './routes/sheets';
import agentRoutes from './routes/internal/agent';
import { connectToRoom, isConnectRequest } from './room/connect';

export { SheetRoom } from './room/sheet-room';

const app = createModuleApi<Env, Variables>({ service: 'sheets-api' });

app.use('/api/*', ...apiAuth());

app.route('/api/sheets', sheetsRoutes);

// Internal entrypoint, bound as SHEETS_INTERNAL (entrypoint = "SheetsInternal") by
// the workers that run WeldAgent tools (agent-api, chat-api, app-api). A named
// entrypoint is only reachable over a service binding, so it is trusted by
// topology; its routes act for the person in `x-weld-user`.
const internalApp = createModuleApi<Env, Variables>({ service: 'sheets-api' });
internalApp.route('/internal/agent', agentRoutes);

export class SheetsInternal extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> | Response {
    return internalApp.fetch(request, this.env, this.ctx);
  }
}

export default {
  fetch(request: Request, env: Env, ctx?: ExecutionContext): Response | Promise<Response> {
    // The room socket authenticates with its own ticket (room/connect.ts).
    if (isConnectRequest(request)) return connectToRoom(request, env);
    return app.fetch(request, env, ctx);
  },
};
