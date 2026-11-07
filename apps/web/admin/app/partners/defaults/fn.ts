import { createServerFn } from '@tanstack/react-start';
import { loadPartnerContractDefaultsPage } from './data';

/** The partner contract defaults page's data, on the server. */
export const getPartnerContractDefaultsPage = createServerFn({ method: 'GET' })
  .handler(() => loadPartnerContractDefaultsPage());
