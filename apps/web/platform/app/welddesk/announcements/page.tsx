
import { useSearchParams } from '@/lib/router';
import { Megaphone, PlusCircle, Download, Eye, TrendingUp } from 'lucide-react';
import { EntityPageHeader, type StatItem, type ActionButton } from '@/components/entity-overview/entity-page-header';
import { useAnnouncements, type Announcement } from '@/hooks/queries/use-helpdesk-queries';
import { AnnouncementsClient } from './announcements-client';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

/** Raw row shape returned by `GET /helpdesk-announcements` (app-api). */
interface RawAnnouncement {
  id?: string;
  title?: string;
  content?: string;
  type?: 'info' | 'warning' | 'success' | 'error';
  publishedAt?: string | Date;
  createdAt?: string | Date;
  expiresAt?: string | Date | null;
  status?: string;
  audience?: string;
  authorName?: string;
}

export default function AnnouncementsPage() {
  const { t } = useI18n();
  const ta = t.helpdesk.announcements;
  const searchParams = useSearchParams();
  const page = searchParams.get('page') ? parseInt(searchParams.get('page')!) : 1;

  const currentParams: Record<string, string> = {};
  searchParams.forEach((value: string, key: string) => {
    currentParams[key] = value;
  });

  const { data, isLoading } = useAnnouncements({
    page,
    pageSize: 20,
  });

  if (isLoading) return <PageLoader fullScreen={false} />;

  // Transform API items to Announcement format
  const rawItems: RawAnnouncement[] = data?.data || [];
  const items: Announcement[] = rawItems.map((item) => ({
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

  const pagination = {
    page: data?.pagination?.page ?? 1,
    pageSize: data?.pagination?.pageSize ?? 20,
    totalCount: data?.pagination?.totalCount ?? 0,
    totalPages: data?.pagination?.totalPages ?? 0,
    hasMore: data?.pagination?.hasMore ?? false,
  };

  // Calculate stats from items
  const stats = {
    total: pagination.totalCount || items.length,
    published: items.filter((item) => item.published).length,
    draft: items.filter((item) => !item.published).length,
    active: items.filter((item) => item.published && (!item.endDate || new Date(item.endDate) > new Date())).length,
  };

  const headerStats: StatItem[] = [
    { icon: Megaphone, label: ta.totalAnnouncements, count: stats.total, color: 'text-blue-600' },
    { icon: Eye, label: ta.published, count: stats.published, color: 'text-green-600' },
    { icon: Megaphone, label: ta.drafts, count: stats.draft, color: 'text-yellow-600' },
    { icon: TrendingUp, label: ta.active, count: stats.active, color: 'text-purple-600' },
  ];

  const actions: ActionButton[] = [
    { label: t.common.actions.export, icon: Download, variant: 'outline' },
    { label: ta.newAnnouncement, icon: PlusCircle, href: '/welddesk/announcements/new' },
  ];

  const statusFilters = [
    { key: 'all', label: ta.all, value: 'all', count: stats.total },
    { key: 'published', label: ta.published, value: 'published', count: stats.published },
    { key: 'draft', label: ta.draft, value: 'draft', count: stats.draft },
  ];

  const additionalFilters = [
    {
      key: 'type',
      label: ta.type,
      type: 'select' as const,
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
      type: 'select' as const,
      options: [
        { label: ta.allPriorities, value: 'all' },
        { label: ta.critical, value: 'critical' },
        { label: ta.high, value: 'high' },
        { label: ta.medium, value: 'medium' },
        { label: ta.low, value: 'low' },
      ],
    },
  ];

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
