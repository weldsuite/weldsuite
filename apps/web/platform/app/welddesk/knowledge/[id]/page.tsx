
import { useParams, useRouter } from '@/lib/router';
import { useArticle } from '@/hooks/queries/use-helpdesk-queries';
import { useTranslations } from '@weldsuite/i18n/client';
import { ArticleViewer } from "./article-viewer";
import { PageLoader } from '@/components/page-loader';

export default function ArticlePage() {
  const t = useTranslations();
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const { data: result, isLoading } = useArticle(id);

  if (isLoading) return <PageLoader fullScreen={false} />;

  const articleData = result?.data;

  if (!articleData) {
    router.push('/welddesk/knowledge');
    return null;
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
