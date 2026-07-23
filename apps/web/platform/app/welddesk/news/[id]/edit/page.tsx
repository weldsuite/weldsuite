
import { useParams, useRouter } from '@/lib/router';
import { NewsEditorClient } from './news-editor-client';
import { useNewsArticle } from '@/hooks/queries/use-helpdesk-queries';
import { PageLoader } from '@/components/page-loader';

export default function NewsEditorPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const { data: article, isLoading } = useNewsArticle(id, !!id);

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!article) {
    router.push('/welddesk/news');
    return null;
  }

  return <NewsEditorClient newsId={id} initialData={article} />;
}
