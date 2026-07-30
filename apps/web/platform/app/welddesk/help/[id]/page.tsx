
import { useParams, useRouter } from '@/lib/router';
import { useHelpArticle } from '@/hooks/queries/use-helpdesk-queries';
import { ArticleViewClient } from './article-view-client';
import { PageLoader } from '@/components/page-loader';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';

function toViewArticle(article: Helpdesk.Article) {
  return {
    id: article.id,
    title: article.title,
    content: article.content,
    excerpt: article.excerpt || '',
    category: article.categoryName || article.category || '',
    tags: article.tags || [],
    author: article.authorName || '',
    views: article.viewCount || 0,
    lastUpdated: article.updatedAt.toISOString(),
    createdAt: article.createdAt.toISOString(),
    status: article.status,
    helpful: article.helpfulCount || 0,
    notHelpful: article.notHelpfulCount || 0,
    coverImage: article.featuredImage,
  };
}

export default function ArticlePage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const { data: result, isLoading } = useHelpArticle(id);

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!result?.success) {
    router.push('/welddesk/help');
    return null;
  }

  return <ArticleViewClient article={toViewArticle(result.article)} />;
}
