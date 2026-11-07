import { createServerFn } from '@tanstack/react-start';
import { loadPartnerContractDefaultsPage } from './data';
import { globalOnly } from '@/lib/edition';

/** The partner contract defaults page's data, on the server. */
export const getPartnerContractDefaultsPage = createServerFn({ method: 'GET' }).middleware([globalOnly])
  .handler(() => loadPartnerContractDefaultsPage());
