
import { useSearchParams } from '@/lib/router';
import { ReviewsClient } from './reviews-client';
import { useHelpdeskReviews, type Review, type ApiReviewItem } from '@/hooks/queries/use-helpdesk-queries';
import { PageLoader } from '@/components/page-loader';

const REVIEW_SOURCES: Review['source'][] = ['email', 'chat', 'website', 'social'];
const REVIEW_STATUSES: Review['status'][] = ['pending', 'responded', 'resolved'];
const REVIEW_SENTIMENTS: Review['sentiment'][] = ['positive', 'neutral', 'negative'];

/** Map the app-api wire row onto the view shape `ReviewsClient` renders. */
function toViewReview(item: ApiReviewItem): Review {
  return {
    id: item.id,
    customerName: item.customerName || item.customerEmail || '',
    customerEmail: item.customerEmail || '',
    rating: item.rating ?? 0,
    comment: item.comment || item.body || '',
    date: item.createdAt ? new Date(item.createdAt) : new Date(),
    source: (REVIEW_SOURCES as string[]).includes(item.source || '')
      ? (item.source as Review['source'])
      : 'website',
    status: (REVIEW_STATUSES as string[]).includes(item.status || '')
      ? (item.status as Review['status'])
      : 'pending',
    sentiment: (REVIEW_SENTIMENTS as string[]).includes(item.sentiment || '')
      ? (item.sentiment as Review['sentiment'])
      : 'neutral',
    agentName: item.agentName,
    ticketId: item.ticketId,
    conversationId: item.conversationId,
    helpful: item.helpful,
    notHelpful: item.notHelpful,
  };
}

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

  return <ReviewsClient items={(data?.data || []).map(toViewReview)} />;
}
