
import { useParams } from '@/lib/router';
import { useArticle } from '@/hooks/queries/use-helpdesk-queries';
import { useTranslations } from '@weldsuite/i18n/client';
import { ArticleViewer } from "./article-viewer";
import { PageLoader } from '@/components/page-loader';
import { useRedirectWhenMissing } from '@/hooks/use-redirect-when-missing';

export default function ArticlePage() {
  const t = useTranslations();
  const params = useParams();
  const id = params.id as string;

  const query = useArticle(id);
  const articleData = query.data?.data;

  // Redirect only once the fetch has settled and the article is really gone,
  // never while the query is still pending (see useRedirectWhenMissing).
  const status = useRedirectWhenMissing(query, !!articleData, '/welddesk/help-center/articles');

  if (!articleData) {
    if (status === 'error') {
      return <p className="p-6 text-sm text-muted-foreground">{t('common.toast.failedToLoad')}</p>;
    }
    return <PageLoader fullScreen={false} />;
  }

  const article = {
    id: articleData.id,
    title: articleData.title,
    content: articleData.content,
    excerpt: articleData.excerpt,
    category: articleData.categoryName || '',
    tags: articleData.tags || [],
    author: articleData.authorName || t('sweep.welddesk.knowledge.unknownAuthor'),
    status: articleData.status,
    visibility: articleData.visibility,
    lastUpdated: new Date(articleData.updatedAt),
    views: articleData.viewCount || 0,
    helpful: articleData.helpfulCount || 0,
    notHelpful: articleData.notHelpfulCount || 0,
  };

  return <ArticleViewer article={article} />;
}
