/**
 * Legacy URL — redirects to the canonical unified list page
 * `/weldcrm/lists/:listId`. Kept as a tiny shim so any bookmarked or
 * pasted `/weldcrm/companies/lists/:id` link still lands somewhere useful.
 */

import { useEffect } from 'react';
import { useParams, useRouter } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';

export default function CompanyListDetailRedirect() {
  const { id } = useParams() as { id: string };
  const router = useRouter();

  useEffect(() => {
    if (id) router.replace(`/weldcrm/lists/${id}`);
  }, [id, router]);

  return <PageLoader fullScreen={false} />;
}
