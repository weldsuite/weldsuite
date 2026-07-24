
import { useSearchParams, Link } from '@/lib/router';
import { Newspaper, PlusCircle, Download, Eye, BarChart } from 'lucide-react';
import { EntityPageHeader, type StatItem } from '@/components/entity-overview/entity-page-header';
import { Button } from '@weldsuite/ui/components/button';
import { useHelpdeskNews, type NewsArticle } from '@/hooks/queries/use-helpdesk-queries';
import { NewsClient } from './news-client';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

/** Raw row shape returned by `GET /helpdesk-news` (app-api). */
interface RawNewsItem {
  id?: string;
  title?: string;
  excerpt?: string;
  content?: string;
  authorName?: string;
  category?: 'company' | 'product' | 'industry' | 'announcement';
  status?: 'draft' | 'published' | 'scheduled';
  publishedAt?: string | Date;
  createdAt?: string | Date;
  viewCount?: number;
  featuredImage?: string;
  tags?: string[];
}

export default function NewsPage() {
  const { t } = useI18n();
  const np = t.helpdesk.newsPage;
  const searchParams = useSearchParams();
  const page = searchParams.get('page') ? parseInt(searchParams.get('page')!) : 1;
  const search = searchParams.get('search') || undefined;

  const currentParams: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    currentParams[key] = value;
  });

  const { data, isLoading } = useHelpdeskNews({
    page,
    pageSize: 20,
    search,
  });

  if (isLoading) return <PageLoader fullScreen={false} />;

  // Transform API items to NewsArticle format
  const rawItems: RawNewsItem[] = data?.data || [];
  const items: NewsArticle[] = rawItems.map((item) => ({
    id: item.id || '',
    title: item.title || '',
    excerpt: item.excerpt || '',
    content: item.content || '',
    author: item.authorName || 'Unknown',
    category: item.category || 'company',
    status: item.status || 'draft',
    publishDate: new Date(item.publishedAt || item.createdAt || Date.now()),
    views: item.viewCount || 0,
    featured: false,
    coverImage: item.featuredImage,
    tags: item.tags || [],
  }));

  const pagination = data?.pagination || {
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  };

  // Calculate stats from items
  const stats = {
    total: pagination.totalCount || pagination.total || items.length,
    published: items.filter((item) => item.status === 'published').length,
    draft: items.filter((item) => item.status === 'draft').length,
    scheduled: items.filter((item) => item.status === 'scheduled').length,
    totalViews: items.reduce((sum, item) => sum + (item.views || 0), 0),
  };

  const headerStats: StatItem[] = [
    { icon: Newspaper, label: np.totalArticles, count: stats.total, color: 'text-blue-600' },
    { icon: Eye, label: np.published, count: stats.published, color: 'text-green-600' },
    { icon: Newspaper, label: np.drafts, count: stats.draft, color: 'text-yellow-600' },
    { icon: BarChart, label: np.totalViews, count: stats.totalViews, color: 'text-purple-600' },
  ];

  const actions = (
    <div className="flex gap-2">
      <Button variant="outline" size="sm">
        <Download className="h-4 w-4 mr-0.5" />
        {np.exportButton}
      </Button>
      <Button size="sm" asChild>
        <Link href="/welddesk/news/new">
          <PlusCircle className="h-4 w-4 mr-0.5" />
          {np.newArticle}
        </Link>
      </Button>
    </div>
  );

  const statusFilters = [
    { label: np.filterAll, value: 'all', count: stats.total },
    { label: np.filterPublished, value: 'published', count: stats.published },
    { label: np.filterDraft, value: 'draft', count: stats.draft },
    { label: np.filterScheduled, value: 'scheduled', count: stats.scheduled },
  ];

  const additionalFilters = [
    {
      key: 'category',
      label: np.filterCategoryLabel,
      options: [
        { label: np.filterAllCategories, value: 'all' },
        { label: np.filterCompany, value: 'company' },
        { label: np.filterProduct, value: 'product' },
        { label: np.filterIndustry, value: 'industry' },
        { label: np.filterAnnouncement, value: 'announcement' },
      ],
    },
  ];

  return (
    <EntityPageHeader
      title={np.title}
      stats={headerStats}
      actions={actions}
    >
      <NewsClient
        items={items}
        pagination={pagination}
        params={currentParams}
        statusFilters={statusFilters}
        additionalFilters={additionalFilters}
      />
    </EntityPageHeader>
  );
}
