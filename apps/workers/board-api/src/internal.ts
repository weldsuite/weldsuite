/**
 * BoardsInternal: board-api's named entrypoint, bound as BOARDS_INTERNAL
 * (entrypoint = "BoardsInternal") by the workers that read or write boards
 * for someone: flow-api's and external-api's deprecated whiteboard routes,
 * the MCP server, and the workers that run WeldAgent tools. A named
 * entrypoint is only reachable over a service binding, so it is trusted by
 * topology; its routes act for the person in `x-weld-user`
 * (routes/internal/boards.ts).
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { createModuleApi } from '@weldsuite/worker-kit';
import type { Env, Variables } from './types';
import internalRoutes from './routes/internal/boards';

const internalApp = createModuleApi<Env, Variables>({ service: 'board-api' });
internalApp.route('/internal/boards', internalRoutes);

export class BoardsInternal extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> | Response {
    return internalApp.fetch(request, this.env, this.ctx);
  }
}
