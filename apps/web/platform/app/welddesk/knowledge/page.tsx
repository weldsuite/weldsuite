
import { useSearchParams } from '@/lib/router';
import { KnowledgeClient } from "./knowledge-client";
import { useArticles, type KnowledgeArticle } from '@/hooks/queries/use-helpdesk-queries';

interface RawArticle {
  id: string;
  title: string;
  excerpt?: string;
  summary?: string;
  categoryName?: string;
  categoryId?: string;
  tags?: string[];
  authorName?: string;
  viewCount?: number;
  updatedAt?: Date;
  status?: KnowledgeArticle['status'];
  visibility?: KnowledgeArticle['visibility'];
  helpfulCount?: number;
  notHelpfulCount?: number;
}

export default function KnowledgePage() {
  const searchParams = useSearchParams();
  const search = searchParams.get('search') || undefined;
  const status = searchParams.get('status') || undefined;

  const { data, isLoading } = useArticles({
    limit: 100,
    search,
    status,
  });

  // Map response to expected format
  const rawItems = data?.data || [];
  const items = rawItems.map((article: RawArticle) => ({
    id: article.id,
    title: article.title,
    excerpt: article.excerpt || article.summary || '',
    category: article.categoryName || '',
    categoryId: article.categoryId || undefined,
    tags: article.tags || [],
    author: article.authorName || '',
    views: article.viewCount || 0,
    lastUpdated: article.updatedAt ?? new Date(),
    status: article.status || 'draft',
    visibility: article.visibility || 'public',
    helpful: article.helpfulCount || 0,
    notHelpful: article.notHelpfulCount || 0,
  }));

  return (
    <KnowledgeClient
      items={items}
      isLoading={isLoading}
    />
  );
}
