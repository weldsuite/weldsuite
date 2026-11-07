/**
 * Domain pricing changes, as server functions. The bodies are in
 * `./domain-pricing.server.ts`; each export here keeps that function's
 * signature and runs it on the server.
 */
import { createServerFn } from '@tanstack/react-start';
import { globalOnly } from '@/lib/edition';
import {
  backfillDomainPricing as backfillDomainPricingOnServer,
  updateDomainPricingMarkup as updateDomainPricingMarkupOnServer,
  applyDomainPricingMarkup as applyDomainPricingMarkupOnServer,
  updateDomainPricingRenewal as updateDomainPricingRenewalOnServer,
  createDomainPricing as createDomainPricingOnServer,
} from './domain-pricing.server';

type Server = typeof import('./domain-pricing.server');

const backfillDomainPricingFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .handler(() => backfillDomainPricingOnServer());
export const backfillDomainPricing = () => backfillDomainPricingFn();

const updateDomainPricingMarkupFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['updateDomainPricingMarkup']>) => args)
  .handler(({ data }) => updateDomainPricingMarkupOnServer(...data));
export const updateDomainPricingMarkup = (...args: Parameters<Server['updateDomainPricingMarkup']>) =>
  updateDomainPricingMarkupFn({ data: args });

const applyDomainPricingMarkupFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['applyDomainPricingMarkup']>) => args)
  .handler(({ data }) => applyDomainPricingMarkupOnServer(...data));
export const applyDomainPricingMarkup = (...args: Parameters<Server['applyDomainPricingMarkup']>) =>
  applyDomainPricingMarkupFn({ data: args });

const updateDomainPricingRenewalFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['updateDomainPricingRenewal']>) => args)
  .handler(({ data }) => updateDomainPricingRenewalOnServer(...data));
export const updateDomainPricingRenewal = (...args: Parameters<Server['updateDomainPricingRenewal']>) =>
  updateDomainPricingRenewalFn({ data: args });

const createDomainPricingFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['createDomainPricing']>) => args)
  .handler(({ data }) => createDomainPricingOnServer(...data));
export const createDomainPricing = (...args: Parameters<Server['createDomainPricing']>) =>
  createDomainPricingFn({ data: args });
