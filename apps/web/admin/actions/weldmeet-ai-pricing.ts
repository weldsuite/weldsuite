/**
 * WeldMeet AI pricing changes, as a server function. The body is in
 * `./weldmeet-ai-pricing.server.ts`; the export here keeps that function's
 * signature and runs it on the server.
 */
import { createServerFn } from '@tanstack/react-start';
import { globalOnly } from '@/lib/edition';
import {
  saveWeldmeetAiPricing as saveWeldmeetAiPricingOnServer,
} from './weldmeet-ai-pricing.server';

type Server = typeof import('./weldmeet-ai-pricing.server');

const saveWeldmeetAiPricingFn = createServerFn({ method: 'POST' }).middleware([globalOnly])
  .validator((args: Parameters<Server['saveWeldmeetAiPricing']>) => args)
  .handler(({ data }) => saveWeldmeetAiPricingOnServer(...data));
export const saveWeldmeetAiPricing = (...args: Parameters<Server['saveWeldmeetAiPricing']>) =>
  saveWeldmeetAiPricingFn({ data: args });
