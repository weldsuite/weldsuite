import { createServerFn } from '@tanstack/react-start';
import { loadPhonePricingPage } from './data';

/** The phone pricing page's data, on the server. */
export const getPhonePricingPage = createServerFn({ method: 'GET' })
  .handler(() => loadPhonePricingPage());
