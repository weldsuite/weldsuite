
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

  const currentParams: Record<string, string> = {};
  searchParams.forEach((value: string, key: string) => {
    currentParams[key] = value;
  });

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

  // app-api uses cursor pagination ({ totalCount, hasMore, cursor }); the list
  // view renders a tree of all loaded items, so page numbers are cosmetic.
  const totalCount = data?.pagination?.totalCount ?? items.length;
  const mappedPagination = {
    page: 1,
    pageSize: 100,
    totalItems: totalCount,
    totalCount,
    totalPages: 1,
    hasMore: data?.pagination?.hasMore ?? false,
  };

  // Calculate counts for status filters
  const counts = {
    total: items.length,
    published: items.filter((item) => item.status === 'published').length,
    draft: items.filter((item) => item.status === 'draft').length,
    archived: items.filter((item) => item.status === 'archived').length,
  };

  return (
    <KnowledgeClient
      items={items}
      pagination={mappedPagination}
      params={currentParams}
      statusFilters={[]}
      additionalFilters={[]}
      counts={counts}
      isLoading={isLoading}
    />
  );
}
