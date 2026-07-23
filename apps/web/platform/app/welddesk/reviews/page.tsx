
import { useSearchParams } from '@/lib/router';
import { ReviewsClient } from './reviews-client';
import { useHelpdeskReviews } from '@/hooks/queries/use-helpdesk-queries';
import { PageLoader } from '@/components/page-loader';

export default function ReviewsPage() {
  const searchParams = useSearchParams();
  const page = searchParams.get('page') ? parseInt(searchParams.get('page')!) : 1;
  const search = searchParams.get('search') || undefined;
  const status = searchParams.get('status') || undefined;

  const { data, isLoading } = useHelpdeskReviews({
    page,
    pageSize: 20,
    search,
    status,
  });

  if (isLoading) return <PageLoader fullScreen={false} />;

  return <ReviewsClient items={data?.data || []} />;
}
