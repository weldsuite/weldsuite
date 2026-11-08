/**
 * Workspace deletion scheduling and cancelling, as server functions. The bodies
 * are in `./workspaces.server.ts`; each export here keeps that function's
 * signature and runs it on the server.
 */
import { createServerFn } from '@tanstack/react-start';
import {
  scheduleWorkspaceDeletion as scheduleWorkspaceDeletionOnServer,
  cancelWorkspaceDeletion as cancelWorkspaceDeletionOnServer,
} from './workspaces.server';

export type { ActionResult, JsonValue } from './workspaces.server';

type Server = typeof import('./workspaces.server');

const scheduleWorkspaceDeletionFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['scheduleWorkspaceDeletion']>) => args)
  .handler(({ data }) => scheduleWorkspaceDeletionOnServer(...data));
export const scheduleWorkspaceDeletion = (...args: Parameters<Server['scheduleWorkspaceDeletion']>) =>
  scheduleWorkspaceDeletionFn({ data: args });

const cancelWorkspaceDeletionFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['cancelWorkspaceDeletion']>) => args)
  .handler(({ data }) => cancelWorkspaceDeletionOnServer(...data));
export const cancelWorkspaceDeletion = (...args: Parameters<Server['cancelWorkspaceDeletion']>) =>
  cancelWorkspaceDeletionFn({ data: args });
