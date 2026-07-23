
import { useParams, useRouter } from '@/lib/router';
import { useNewsArticle } from '@/hooks/queries/use-helpdesk-queries';
import { NewsViewer } from './news-viewer';
import { PageLoader } from '@/components/page-loader';

export default function NewsPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const { data: article, isLoading } = useNewsArticle(id, !!id);

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!article) {
    router.push('/welddesk/news');
    return null;
  }

  return <NewsViewer article={article} />;
}
