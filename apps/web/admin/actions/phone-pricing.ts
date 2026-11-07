/**
 * Phone number pricing changes, as server functions. The bodies are in
 * `./phone-pricing.server.ts`; each export here keeps that function's signature
 * and runs it on the server.
 */
import { createServerFn } from '@tanstack/react-start';
import { globalOnly } from '@/lib/edition';
import {
  updatePhonePricingMarkup as updatePhonePricingMarkupOnServer,
  applyPhonePricingMarkup as applyPhonePricingMarkupOnServer,
  updatePhonePricingWholesale as updatePhonePricingWholesaleOnServer,
  createPhonePricing as createPhonePricingOnServer,
  seedPhonePricing as seedPhonePricingOnServer,
} from './phone-pricing.server';

type Server = typeof import('./phone-pricing.server');

const updatePhonePricingMarkupFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['updatePhonePricingMarkup']>) => args)
  .handler(({ data }) => updatePhonePricingMarkupOnServer(...data));
export const updatePhonePricingMarkup = (...args: Parameters<Server['updatePhonePricingMarkup']>) =>
  updatePhonePricingMarkupFn({ data: args });

const applyPhonePricingMarkupFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['applyPhonePricingMarkup']>) => args)
  .handler(({ data }) => applyPhonePricingMarkupOnServer(...data));
export const applyPhonePricingMarkup = (...args: Parameters<Server['applyPhonePricingMarkup']>) =>
  applyPhonePricingMarkupFn({ data: args });

const updatePhonePricingWholesaleFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['updatePhonePricingWholesale']>) => args)
  .handler(({ data }) => updatePhonePricingWholesaleOnServer(...data));
export const updatePhonePricingWholesale = (...args: Parameters<Server['updatePhonePricingWholesale']>) =>
  updatePhonePricingWholesaleFn({ data: args });

const createPhonePricingFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['createPhonePricing']>) => args)
  .handler(({ data }) => createPhonePricingOnServer(...data));
export const createPhonePricing = (...args: Parameters<Server['createPhonePricing']>) =>
  createPhonePricingFn({ data: args });

const seedPhonePricingFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .handler(() => seedPhonePricingOnServer());
export const seedPhonePricing = () => seedPhonePricingFn();
