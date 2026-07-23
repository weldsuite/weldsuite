
import { useParams, useRouter } from '@/lib/router';
import { useArticle } from '@/hooks/queries/use-helpdesk-queries';
import { useTranslations } from '@weldsuite/i18n/client';
import { ArticleEditor } from "../article-editor";
import { PageLoader } from '@/components/page-loader';

export default function ArticleEditPage() {
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
