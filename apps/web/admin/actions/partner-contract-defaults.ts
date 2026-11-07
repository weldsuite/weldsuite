/**
 * The default contract terms for new partners, as a server function. The body
 * is in `./partner-contract-defaults.server.ts`; the export here keeps that
 * function's signature and runs it on the server.
 */
import { createServerFn } from '@tanstack/react-start';
import { globalOnly } from '@/lib/edition';
import {
  savePartnerContractDefaults as savePartnerContractDefaultsOnServer,
} from './partner-contract-defaults.server';

type Server = typeof import('./partner-contract-defaults.server');

const savePartnerContractDefaultsFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['savePartnerContractDefaults']>) => args)
  .handler(({ data }) => savePartnerContractDefaultsOnServer(...data));
export const savePartnerContractDefaults = (...args: Parameters<Server['savePartnerContractDefaults']>) =>
  savePartnerContractDefaultsFn({ data: args });
