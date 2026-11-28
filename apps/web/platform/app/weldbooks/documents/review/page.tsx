import { useParams } from '@/lib/router';
import { useObjectPanelUrlSyncHere } from '@/components/object-panel';
import { ReviewScreen } from './review-screen';

/** `/weldbooks/documents/{id}/review`. Bills, payments and bank lines the booking made open as stacked panels (`?stack=`). */
export default function DocumentReviewPage() {
  const { id } = useParams<{ id: string }>();
  useObjectPanelUrlSyncHere();
  return <ReviewScreen key={id} documentId={id} />;
}
