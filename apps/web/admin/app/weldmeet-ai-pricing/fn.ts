import { createServerFn } from '@tanstack/react-start';
import { loadWeldmeetAiPricingPage } from './data';

/** The WeldMeet AI pricing page's data, on the server. */
export const getWeldmeetAiPricingPage = createServerFn({ method: 'GET' })
  .handler(() => loadWeldmeetAiPricingPage());
