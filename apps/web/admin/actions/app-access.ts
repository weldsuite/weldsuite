/**
 * Staff decisions on access to apps that are on request only, as server
 * functions. The bodies are in `./app-access.server.ts`; each export here keeps
 * that function's signature and runs it on the server.
 */
import { createServerFn } from '@tanstack/react-start';
import {
  approveAppAccess as approveAppAccessOnServer,
  rejectAppAccess as rejectAppAccessOnServer,
  suspendAppAccess as suspendAppAccessOnServer,
  unsuspendAppAccess as unsuspendAppAccessOnServer,
  revokeAppAccess as revokeAppAccessOnServer,
  updateAppAccessLimits as updateAppAccessLimitsOnServer,
  updateAppAccessNotes as updateAppAccessNotesOnServer,
} from './app-access.server';

export type { AppAccessActionData } from './app-access.server';

type Server = typeof import('./app-access.server');

const approveAppAccessFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['approveAppAccess']>) => args)
  .handler(({ data }) => approveAppAccessOnServer(...data));
export const approveAppAccess = (...args: Parameters<Server['approveAppAccess']>) =>
  approveAppAccessFn({ data: args });

const rejectAppAccessFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['rejectAppAccess']>) => args)
  .handler(({ data }) => rejectAppAccessOnServer(...data));
export const rejectAppAccess = (...args: Parameters<Server['rejectAppAccess']>) =>
  rejectAppAccessFn({ data: args });

const suspendAppAccessFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['suspendAppAccess']>) => args)
  .handler(({ data }) => suspendAppAccessOnServer(...data));
export const suspendAppAccess = (...args: Parameters<Server['suspendAppAccess']>) =>
  suspendAppAccessFn({ data: args });

const unsuspendAppAccessFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['unsuspendAppAccess']>) => args)
  .handler(({ data }) => unsuspendAppAccessOnServer(...data));
export const unsuspendAppAccess = (...args: Parameters<Server['unsuspendAppAccess']>) =>
  unsuspendAppAccessFn({ data: args });

const revokeAppAccessFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['revokeAppAccess']>) => args)
  .handler(({ data }) => revokeAppAccessOnServer(...data));
export const revokeAppAccess = (...args: Parameters<Server['revokeAppAccess']>) =>
  revokeAppAccessFn({ data: args });

const updateAppAccessLimitsFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['updateAppAccessLimits']>) => args)
  .handler(({ data }) => updateAppAccessLimitsOnServer(...data));
export const updateAppAccessLimits = (...args: Parameters<Server['updateAppAccessLimits']>) =>
  updateAppAccessLimitsFn({ data: args });

const updateAppAccessNotesFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['updateAppAccessNotes']>) => args)
  .handler(({ data }) => updateAppAccessNotesOnServer(...data));
export const updateAppAccessNotes = (...args: Parameters<Server['updateAppAccessNotes']>) =>
  updateAppAccessNotesFn({ data: args });
