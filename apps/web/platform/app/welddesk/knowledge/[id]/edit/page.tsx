
import { useParams } from '@/lib/router';
import { useArticle } from '@/hooks/queries/use-helpdesk-queries';
import { useTranslations } from '@weldsuite/i18n/client';
import { ArticleEditor } from "../article-editor";
import { PageLoader } from '@/components/page-loader';
import { useRedirectWhenMissing } from '@/hooks/use-redirect-when-missing';

export default function ArticleEditPage() {
  const t = useTranslations();
  const params = useParams();
  const id = params.id as string;

  const query = useArticle(id);
  const articleData = query.data?.data;

  // Only leave the page once the fetch has settled and the article is really
  // gone. On a reload or direct open the query is still pending (disabled, or
  // waiting for the persisted cache to restore), which must not read as "not found".
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
    excerpt: articleData.excerpt || '',
    category: articleData.categoryName || '',
    categoryId: articleData.categoryId ?? null,
    tags: articleData.tags || [],
    author: articleData.authorName || t('sweep.welddesk.knowledge.unknownAuthor'),
    status: articleData.status,
    visibility: articleData.visibility,
    lastUpdated: articleData.updatedAt ? new Date(articleData.updatedAt) : new Date(),
  };

  return <ArticleEditor article={article} />;
}
