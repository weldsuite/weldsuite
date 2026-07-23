import { useParams } from '@tanstack/react-router';
import PageView from './page-view';

export default function WeldKnowPagePage() {
  const { pageId } = useParams({ from: '/weldknow/page/$pageId/' });
  return <PageView pageId={pageId} />;
}
