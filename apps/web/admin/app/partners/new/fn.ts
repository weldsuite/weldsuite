import { redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { loadNewPartnerPage } from './data';
import { globalOnly } from '@/lib/edition';

/** The new partner form's data, on the server. Viewers can't add partners and go back to the list. */
export const getNewPartnerPage = createServerFn({ method: 'GET' }).middleware([globalOnly])
  .handler(async () => {
    const page = await loadNewPartnerPage();
    if (!page.canWrite) throw redirect({ href: '/partners' });
    return page;
  });
