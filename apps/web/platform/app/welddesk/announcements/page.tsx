
import { useSearchParams, Link } from '@/lib/router';
import { Megaphone, PlusCircle, Download, Eye, TrendingUp } from 'lucide-react';
import { EntityPageHeader, type StatItem } from '@/components/entity-overview/entity-page-header';
import { Button } from '@weldsuite/ui/components/button';
import { useAnnouncements } from '@/hooks/queries/use-helpdesk-queries';
import { AnnouncementsClient } from './announcements-client';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function AnnouncementsPage() {
  const { t } = useI18n();
  const ta = t.helpdesk.announcements;
  const searchParams = useSearchParams();
  const page = searchParams.get('page') ? parseInt(searchParams.get('page')!) : 1;

  const currentParams: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    currentParams[key] = value;
  });

  const { data, isLoading } = useAnnouncements({
    page,
    pageSize: 20,
  });

  if (isLoading) return <PageLoader fullScreen={false} />;

  // Transform API items to Announcement format
  const rawItems = data?.data || [];
  const items = rawItems.map((item: any) => ({
    id: item.id || '',
    title: item.title || '',
    message: item.content || '',
    type: (item.type || 'info') as 'info' | 'warning' | 'success' | 'error',
    priority: 'medium' as 'low' | 'medium' | 'high' | 'critical',
    startDate: new Date(item.publishedAt || item.createdAt || Date.now()),
    endDate: item.expiresAt ? new Date(item.expiresAt) : null,
    published: item.status === 'published',
    targetAudience: (item.audience || 'all') as 'all' | 'customers' | 'internal' | 'vip',
    author: item.authorName || 'Unknown',
    views: 0,
    clicks: 0,
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
    published: items.filter((item: any) => item.published).length,
    draft: items.filter((item: any) => !item.published).length,
    active: items.filter((item: any) => item.published && (!item.endDate || new Date(item.endDate) > new Date())).length,
  };

  /* eslint-disable */
  const headerStats: StatItem[] = [
    { icon: Megaphone, label: ta.totalAnnouncements, count: stats.total, color: 'text-blue-600' },
    { icon: Eye, label: ta.published, count: stats.published, color: 'text-green-600' },
    { icon: Megaphone, label: ta.drafts, count: stats.draft, color: 'text-yellow-600' },
    { icon: TrendingUp, label: ta.active, count: stats.active, color: 'text-purple-600' },
  ];

  const actions = (
    <div className="flex gap-2">
      <Button variant="outline" size="sm">
        <Download className="h-4 w-4 mr-0.5" />
        {t.common.actions.export}
      </Button>
      <Button size="sm" asChild>
        <Link href="/welddesk/announcements/new">
          <PlusCircle className="h-4 w-4 mr-0.5" />
          {ta.newAnnouncement}
        </Link>
      </Button>
    </div>
  );

  const statusFilters = [
    { label: ta.all, value: 'all', count: stats.total },
    { label: ta.published, value: 'published', count: stats.published },
    { label: ta.draft, value: 'draft', count: stats.draft },
  ];

  const additionalFilters = [
    {
      key: 'type',
      label: ta.type,
      options: [
        { label: ta.allTypes, value: 'all' },
        { label: ta.info, value: 'info' },
        { label: ta.warning, value: 'warning' },
        { label: ta.success, value: 'success' },
        { label: ta.error, value: 'error' },
      ],
    },
    {
      key: 'priority',
      label: ta.priority,
      options: [
        { label: ta.allPriorities, value: 'all' },
        { label: ta.critical, value: 'critical' },
        { label: ta.high, value: 'high' },
        { label: ta.medium, value: 'medium' },
        { label: ta.low, value: 'low' },
      ],
    },
  ];
  /* eslint-enable */

  return (
    <EntityPageHeader
      title={ta.title}
      stats={headerStats}
      actions={actions}
    >
      <AnnouncementsClient
        items={items}
        pagination={pagination}
        params={currentParams}
        statusFilters={statusFilters}
        additionalFilters={additionalFilters}
      />
    </EntityPageHeader>
  );
}
