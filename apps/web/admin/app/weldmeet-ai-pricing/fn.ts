import { createServerFn } from '@tanstack/react-start';
import { loadWeldmeetAiPricingPage } from './data';
import { globalOnly } from '@/lib/edition';

/** The WeldMeet AI pricing page's data, on the server. */
export const getWeldmeetAiPricingPage = createServerFn({ method: 'GET' }).middleware([globalOnly])
  .handler(() => loadWeldmeetAiPricingPage());
