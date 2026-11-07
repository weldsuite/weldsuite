/**
 * Partner (reseller) changes and lookups, as server functions. The bodies are
 * in `./partners.server.ts`; each export here keeps that function's signature
 * and runs it on the server.
 */
import { createServerFn } from '@tanstack/react-start';
import { globalOnly } from '@/lib/edition';
import {
  createPartner as createPartnerOnServer,
  updatePartnerProfile as updatePartnerProfileOnServer,
  createPartnerContract as createPartnerContractOnServer,
  savePartnerTerritories as savePartnerTerritoriesOnServer,
  invitePartnerMember as invitePartnerMemberOnServer,
  removePartnerMember as removePartnerMemberOnServer,
  overridePartnerStatus as overridePartnerStatusOnServer,
  attachPartnerWorkspace as attachPartnerWorkspaceOnServer,
  detachPartnerWorkspace as detachPartnerWorkspaceOnServer,
  updatePartnerWorkspaceLicence as updatePartnerWorkspaceLicenceOnServer,
  searchWorkspacesToAttach as searchWorkspacesToAttachOnServer,
  previewPartnerStatement as previewPartnerStatementOnServer,
  getPartnerStatement as getPartnerStatementOnServer,
  runPartnerStatement as runPartnerStatementOnServer,
  voidPartnerStatement as voidPartnerStatementOnServer,
} from './partners.server';

type Server = typeof import('./partners.server');

const createPartnerFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['createPartner']>) => args)
  .handler(({ data }) => createPartnerOnServer(...data));
export const createPartner = (...args: Parameters<Server['createPartner']>) =>
  createPartnerFn({ data: args });

const updatePartnerProfileFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['updatePartnerProfile']>) => args)
  .handler(({ data }) => updatePartnerProfileOnServer(...data));
export const updatePartnerProfile = (...args: Parameters<Server['updatePartnerProfile']>) =>
  updatePartnerProfileFn({ data: args });

const createPartnerContractFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['createPartnerContract']>) => args)
  .handler(({ data }) => createPartnerContractOnServer(...data));
export const createPartnerContract = (...args: Parameters<Server['createPartnerContract']>) =>
  createPartnerContractFn({ data: args });

const savePartnerTerritoriesFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['savePartnerTerritories']>) => args)
  .handler(({ data }) => savePartnerTerritoriesOnServer(...data));
export const savePartnerTerritories = (...args: Parameters<Server['savePartnerTerritories']>) =>
  savePartnerTerritoriesFn({ data: args });

const invitePartnerMemberFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['invitePartnerMember']>) => args)
  .handler(({ data }) => invitePartnerMemberOnServer(...data));
export const invitePartnerMember = (...args: Parameters<Server['invitePartnerMember']>) =>
  invitePartnerMemberFn({ data: args });

const removePartnerMemberFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['removePartnerMember']>) => args)
  .handler(({ data }) => removePartnerMemberOnServer(...data));
export const removePartnerMember = (...args: Parameters<Server['removePartnerMember']>) =>
  removePartnerMemberFn({ data: args });

const overridePartnerStatusFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['overridePartnerStatus']>) => args)
  .handler(({ data }) => overridePartnerStatusOnServer(...data));
export const overridePartnerStatus = (...args: Parameters<Server['overridePartnerStatus']>) =>
  overridePartnerStatusFn({ data: args });

const attachPartnerWorkspaceFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['attachPartnerWorkspace']>) => args)
  .handler(({ data }) => attachPartnerWorkspaceOnServer(...data));
export const attachPartnerWorkspace = (...args: Parameters<Server['attachPartnerWorkspace']>) =>
  attachPartnerWorkspaceFn({ data: args });

const detachPartnerWorkspaceFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['detachPartnerWorkspace']>) => args)
  .handler(({ data }) => detachPartnerWorkspaceOnServer(...data));
export const detachPartnerWorkspace = (...args: Parameters<Server['detachPartnerWorkspace']>) =>
  detachPartnerWorkspaceFn({ data: args });

const updatePartnerWorkspaceLicenceFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['updatePartnerWorkspaceLicence']>) => args)
  .handler(({ data }) => updatePartnerWorkspaceLicenceOnServer(...data));
export const updatePartnerWorkspaceLicence = (...args: Parameters<Server['updatePartnerWorkspaceLicence']>) =>
  updatePartnerWorkspaceLicenceFn({ data: args });

const searchWorkspacesToAttachFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['searchWorkspacesToAttach']>) => args)
  .handler(({ data }) => searchWorkspacesToAttachOnServer(...data));
export const searchWorkspacesToAttach = (...args: Parameters<Server['searchWorkspacesToAttach']>) =>
  searchWorkspacesToAttachFn({ data: args });

const previewPartnerStatementFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['previewPartnerStatement']>) => args)
  .handler(({ data }) => previewPartnerStatementOnServer(...data));
export const previewPartnerStatement = (...args: Parameters<Server['previewPartnerStatement']>) =>
  previewPartnerStatementFn({ data: args });

const getPartnerStatementFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['getPartnerStatement']>) => args)
  .handler(({ data }) => getPartnerStatementOnServer(...data));
export const getPartnerStatement = (...args: Parameters<Server['getPartnerStatement']>) =>
  getPartnerStatementFn({ data: args });

const runPartnerStatementFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['runPartnerStatement']>) => args)
  .handler(({ data }) => runPartnerStatementOnServer(...data));
export const runPartnerStatement = (...args: Parameters<Server['runPartnerStatement']>) =>
  runPartnerStatementFn({ data: args });

const voidPartnerStatementFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['voidPartnerStatement']>) => args)
  .handler(({ data }) => voidPartnerStatementOnServer(...data));
export const voidPartnerStatement = (...args: Parameters<Server['voidPartnerStatement']>) =>
  voidPartnerStatementFn({ data: args });
