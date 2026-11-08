/**
 * App catalog changes, as server functions. The bodies are in
 * `./apps.server.ts`; each export here keeps that function's signature and runs
 * it on the server.
 */
import { createServerFn } from '@tanstack/react-start';
import {
  createApp as createAppOnServer,
  updateApp as updateAppOnServer,
  deleteApp as deleteAppOnServer,
  seedApps as seedAppsOnServer,
} from './apps.server';

type Server = typeof import('./apps.server');

const createAppFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['createApp']>) => args)
  .handler(({ data }) => createAppOnServer(...data));
export const createApp = (...args: Parameters<Server['createApp']>) =>
  createAppFn({ data: args });

const updateAppFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['updateApp']>) => args)
  .handler(({ data }) => updateAppOnServer(...data));
export const updateApp = (...args: Parameters<Server['updateApp']>) =>
  updateAppFn({ data: args });

const deleteAppFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['deleteApp']>) => args)
  .handler(({ data }) => deleteAppOnServer(...data));
export const deleteApp = (...args: Parameters<Server['deleteApp']>) =>
  deleteAppFn({ data: args });

const seedAppsFn = createServerFn({ method: 'POST' })
  .validator((mode: Parameters<Server['seedApps']>[0]) => mode)
  .handler(({ data }) => seedAppsOnServer(data));
export const seedApps = (...args: Parameters<Server['seedApps']>) =>
  seedAppsFn({ data: args[0] });
