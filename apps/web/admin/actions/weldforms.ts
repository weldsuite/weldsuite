/**
 * Staff moderation of public WeldForms forms, as server functions. The bodies
 * are in `./weldforms.server.ts`; each export here keeps that function's
 * signature and runs it on the server.
 */
import { createServerFn } from '@tanstack/react-start';
import {
  suspendForm as suspendFormOnServer,
  unsuspendForm as unsuspendFormOnServer,
  releaseHeldForm as releaseHeldFormOnServer,
  dismissReport as dismissReportOnServer,
  markReportActioned as markReportActionedOnServer,
  suspendWorkspaceForms as suspendWorkspaceFormsOnServer,
} from './weldforms.server';

type Server = typeof import('./weldforms.server');

const suspendFormFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['suspendForm']>) => args)
  .handler(({ data }) => suspendFormOnServer(...data));
export const suspendForm = (...args: Parameters<Server['suspendForm']>) => suspendFormFn({ data: args });

const unsuspendFormFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['unsuspendForm']>) => args)
  .handler(({ data }) => unsuspendFormOnServer(...data));
export const unsuspendForm = (...args: Parameters<Server['unsuspendForm']>) => unsuspendFormFn({ data: args });

const releaseHeldFormFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['releaseHeldForm']>) => args)
  .handler(({ data }) => releaseHeldFormOnServer(...data));
export const releaseHeldForm = (...args: Parameters<Server['releaseHeldForm']>) => releaseHeldFormFn({ data: args });

const dismissReportFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['dismissReport']>) => args)
  .handler(({ data }) => dismissReportOnServer(...data));
export const dismissReport = (...args: Parameters<Server['dismissReport']>) => dismissReportFn({ data: args });

const markReportActionedFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['markReportActioned']>) => args)
  .handler(({ data }) => markReportActionedOnServer(...data));
export const markReportActioned = (...args: Parameters<Server['markReportActioned']>) =>
  markReportActionedFn({ data: args });

const suspendWorkspaceFormsFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['suspendWorkspaceForms']>) => args)
  .handler(({ data }) => suspendWorkspaceFormsOnServer(...data));
export const suspendWorkspaceForms = (...args: Parameters<Server['suspendWorkspaceForms']>) =>
  suspendWorkspaceFormsFn({ data: args });
