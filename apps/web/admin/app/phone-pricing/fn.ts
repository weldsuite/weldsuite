import { createServerFn } from '@tanstack/react-start';
import { loadPhonePricingPage } from './data';
import { globalOnly } from '@/lib/edition';

/** The phone pricing page's data, on the server. */
export const getPhonePricingPage = createServerFn({ method: 'GET' }).middleware([globalOnly])
  .handler(() => loadPhonePricingPage());
