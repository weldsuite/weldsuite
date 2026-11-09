import { createServerFn } from '@tanstack/react-start';
import { loadPlanPricingPage } from './data';
import { globalOnly } from '@/lib/edition';

/** The plan pricing page's data, on the server. */
export const getPlanPricingPage = createServerFn({ method: 'GET' }).middleware([globalOnly])
  .handler(() => loadPlanPricingPage());
