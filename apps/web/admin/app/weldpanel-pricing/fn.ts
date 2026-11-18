import { createServerFn } from '@tanstack/react-start';
import { loadWeldpanelPricingPage } from './data';
import { globalOnly } from '@/lib/edition';

/** The WeldPanel pricing page's data, on the server. */
export const getWeldpanelPricingPage = createServerFn({ method: 'GET' }).middleware([globalOnly])
  .handler(() => loadWeldpanelPricingPage());
