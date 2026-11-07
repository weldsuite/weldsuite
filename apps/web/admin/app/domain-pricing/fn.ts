import { createServerFn } from '@tanstack/react-start';
import { loadDomainPricingPage } from './data';

/** The domain pricing page's data, on the server. */
export const getDomainPricingPage = createServerFn({ method: 'GET' })
  .handler(() => loadDomainPricingPage());
