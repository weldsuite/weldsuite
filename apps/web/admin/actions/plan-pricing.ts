/**
 * Per-country plan pricing changes, as server functions. The bodies are in
 * `./plan-pricing.server.ts`; each export here keeps that function's signature
 * and runs it on the server.
 */
import { createServerFn } from '@tanstack/react-start';
import {
  saveCountryPlanPricing as saveCountryPlanPricingOnServer,
  removeCountryPlanPricing as removeCountryPlanPricingOnServer,
} from './plan-pricing.server';

type Server = typeof import('./plan-pricing.server');

const saveCountryPlanPricingFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['saveCountryPlanPricing']>) => args)
  .handler(({ data }) => saveCountryPlanPricingOnServer(...data));
export const saveCountryPlanPricing = (...args: Parameters<Server['saveCountryPlanPricing']>) =>
  saveCountryPlanPricingFn({ data: args });

const removeCountryPlanPricingFn = createServerFn({ method: 'POST' })
  .validator((args: Parameters<Server['removeCountryPlanPricing']>) => args)
  .handler(({ data }) => removeCountryPlanPricingOnServer(...data));
export const removeCountryPlanPricing = (...args: Parameters<Server['removeCountryPlanPricing']>) =>
  removeCountryPlanPricingFn({ data: args });
