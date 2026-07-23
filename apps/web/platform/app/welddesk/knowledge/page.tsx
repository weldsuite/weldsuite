
import { useSearchParams } from '@/lib/router';
import { KnowledgeClient } from "./knowledge-client";
import { useArticles } from '@/hooks/queries/use-helpdesk-queries';
import { PageLoader } from '@/components/page-loader';

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

  if (isLoading) return <PageLoader fullScreen={false} />;

  // Map response to expected format
  const rawItems = data?.data || [];
  const items = rawItems.map((article: any) => ({
    id: article.id,
    title: article.title,
    excerpt: article.excerpt || article.summary || '',
    category: article.categoryName || '',
    categoryId: article.categoryId || undefined,
    tags: article.tags || [],
    author: article.authorName || '',
    views: article.viewCount || 0,
    lastUpdated: new Date(article.updatedAt || Date.now()),
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
    published: items.filter((item: any) => item.status === 'published').length,
    draft: items.filter((item: any) => item.status === 'draft').length,
    archived: items.filter((item: any) => item.status === 'archived').length,
  };

  return (
    <KnowledgeClient
      items={items}
      pagination={mappedPagination}
      params={currentParams}
      statusFilters={[]}
      additionalFilters={[]}
      counts={counts}
    />
  );
}
