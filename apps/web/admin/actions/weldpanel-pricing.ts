/**
 * WeldPanel pricing changes, as a server function. The body is in
 * `./weldpanel-pricing.server.ts`; the export here keeps that function's
 * signature and runs it on the server.
 */
import { createServerFn } from '@tanstack/react-start';
import { globalOnly } from '@/lib/edition';
import {
  saveWeldpanelPricing as saveWeldpanelPricingOnServer,
} from './weldpanel-pricing.server';

type Server = typeof import('./weldpanel-pricing.server');

const saveWeldpanelPricingFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['saveWeldpanelPricing']>) => args)
  .handler(({ data }) => saveWeldpanelPricingOnServer(...data));
export const saveWeldpanelPricing = (...args: Parameters<Server['saveWeldpanelPricing']>) =>
  saveWeldpanelPricingFn({ data: args });
