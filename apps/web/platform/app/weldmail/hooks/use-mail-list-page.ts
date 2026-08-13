import { useEffect, useState } from 'react';
import { useParams, usePathname, useSearchParams } from '@/lib/router';

/**
 * Page number for the WeldMail thread list.
 *
 * The list lives in the label layout, which stays mounted when a message opens.
 * If `page` disappears from the URL (a child route that did not keep the query),
 * keep showing the same page instead of jumping back to page 1.
 */
export function useMailListPage(): number {
  const searchParams = useSearchParams();
  const params = useParams<{ messageId?: string }>();
  const pathname = usePathname();
  const pageFromUrl = Math.max(1, Number(searchParams?.get('page')) || 1);
  const hasPageParam = Boolean(searchParams?.get('page'));
  const isChildView = Boolean(params.messageId) || /\/compose\/?$/.test(pathname);

  const [stickyPage, setStickyPage] = useState(pageFromUrl);

  useEffect(() => {
    if (hasPageParam) {
      setStickyPage(pageFromUrl);
    } else if (!isChildView) {
      setStickyPage(1);
    }
  }, [hasPageParam, pageFromUrl, isChildView]);

  if (hasPageParam) return pageFromUrl;
  if (isChildView) return stickyPage;
  return 1;
}
