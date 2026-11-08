import { createServerFn } from '@tanstack/react-start';
import { loadDomainPricingPage } from './data';
import { globalOnly } from '@/lib/edition';

/** The domain pricing page's data, on the server. */
export const getDomainPricingPage = createServerFn({ method: 'GET' }).middleware([globalOnly])
  .handler(() => loadDomainPricingPage());
