/**
 * Database moves and shard measurements, as server functions. The bodies are in
 * `./databases.server.ts`; each export here keeps that function's signature and
 * runs it on the server.
 */
import { createServerFn } from '@tanstack/react-start';
import { globalOnly } from '@/lib/edition';
import {
  startDatabaseMoveAction as startDatabaseMoveActionOnServer,
  cancelDatabaseMoveAction as cancelDatabaseMoveActionOnServer,
  recoverDatabaseMoveAction as recoverDatabaseMoveActionOnServer,
  loadDatabaseMoveAction as loadDatabaseMoveActionOnServer,
  measureShardSizesAction as measureShardSizesActionOnServer,
} from './databases.server';

type Server = typeof import('./databases.server');

const startDatabaseMoveActionFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['startDatabaseMoveAction']>) => args)
  .handler(({ data }) => startDatabaseMoveActionOnServer(...data));
export const startDatabaseMoveAction = (...args: Parameters<Server['startDatabaseMoveAction']>) =>
  startDatabaseMoveActionFn({ data: args });

const cancelDatabaseMoveActionFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['cancelDatabaseMoveAction']>) => args)
  .handler(({ data }) => cancelDatabaseMoveActionOnServer(...data));
export const cancelDatabaseMoveAction = (...args: Parameters<Server['cancelDatabaseMoveAction']>) =>
  cancelDatabaseMoveActionFn({ data: args });

const recoverDatabaseMoveActionFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['recoverDatabaseMoveAction']>) => args)
  .handler(({ data }) => recoverDatabaseMoveActionOnServer(...data));
export const recoverDatabaseMoveAction = (...args: Parameters<Server['recoverDatabaseMoveAction']>) =>
  recoverDatabaseMoveActionFn({ data: args });

const loadDatabaseMoveActionFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['loadDatabaseMoveAction']>) => args)
  .handler(({ data }) => loadDatabaseMoveActionOnServer(...data));
export const loadDatabaseMoveAction = (...args: Parameters<Server['loadDatabaseMoveAction']>) =>
  loadDatabaseMoveActionFn({ data: args });

const measureShardSizesActionFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['measureShardSizesAction']>) => args)
  .handler(({ data }) => measureShardSizesActionOnServer(...data));
export const measureShardSizesAction = (...args: Parameters<Server['measureShardSizesAction']>) =>
  measureShardSizesActionFn({ data: args });
