import { redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { loadNewPartnerPage } from './data';

/** The new partner form's data, on the server. Viewers can't add partners and go back to the list. */
export const getNewPartnerPage = createServerFn({ method: 'GET' })
  .handler(async () => {
    const page = await loadNewPartnerPage();
    if (!page.canWrite) throw redirect({ href: '/partners' });
    return page;
  });
