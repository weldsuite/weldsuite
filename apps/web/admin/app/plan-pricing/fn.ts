import { createServerFn } from '@tanstack/react-start';
import { loadPlanPricingPage } from './data';

/** The plan pricing page's data, on the server. */
export const getPlanPricingPage = createServerFn({ method: 'GET' })
  .handler(() => loadPlanPricingPage());
