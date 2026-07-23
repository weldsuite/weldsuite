
import { useParams, useRouter } from '@/lib/router';
import { useHelpArticle } from '@/hooks/queries/use-helpdesk-queries';
import { ArticleViewClient } from './article-view-client';
import { PageLoader } from '@/components/page-loader';

export default function ArticlePage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const { data: result, isLoading } = useHelpArticle(id);

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!result?.success || !result?.article) {
    router.push('/welddesk/help');
    return null;
  }

  return <ArticleViewClient article={result.article} />;
}
