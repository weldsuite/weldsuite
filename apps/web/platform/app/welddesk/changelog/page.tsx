
import { useSearchParams } from '@/lib/router';
import { FileText, PlusCircle, Download, Eye } from 'lucide-react';
import { EntityPageHeader, type StatItem, type ActionButton } from '@/components/entity-overview/entity-page-header';
import { useChangelog } from '@/hooks/queries/use-helpdesk-queries';
import { ChangelogClient } from './changelog-client';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function ChangelogPage() {
  const { t } = useI18n();
  const tc = t.helpdesk.changelog;
  const searchParams = useSearchParams();
  const page = searchParams.get('page') ? parseInt(searchParams.get('page')!) : 1;
  const search = searchParams.get('search') || undefined;

  const currentParams: Record<string, string> = {};
  searchParams.forEach((value: string, key: string) => {
    currentParams[key] = value;
  });

  const { data, isLoading } = useChangelog({
    page,
    pageSize: 20,
    search,
  });

  if (isLoading) return <PageLoader fullScreen={false} />;

  const items = data?.data || [];
  const pagination = {
    page: data?.pagination?.page ?? 1,
    pageSize: data?.pagination?.pageSize ?? 20,
    totalCount: data?.pagination?.totalCount ?? 0,
    totalPages: data?.pagination?.totalPages ?? 0,
    hasMore: data?.pagination?.hasMore ?? false,
  };

  // Calculate stats from items
  const thisMonth = new Date();
  thisMonth.setDate(1);
  thisMonth.setHours(0, 0, 0, 0);

  const stats = {
    total: pagination.totalCount || items.length,
    published: items.filter((item) => item.status === 'published').length,
    draft: items.filter((item) => item.status === 'draft').length,
    thisMonth: items.filter((item) => new Date(item.createdAt) >= thisMonth).length,
  };

  const headerStats: StatItem[] = [
    { icon: FileText, label: tc.totalEntries, count: stats.total, color: 'text-blue-600' },
    { icon: Eye, label: tc.published, count: stats.published, color: 'text-green-600' },
    { icon: FileText, label: tc.drafts, count: stats.draft, color: 'text-yellow-600' },
    { icon: FileText, label: tc.thisMonth, count: stats.thisMonth, color: 'text-purple-600' },
  ];

  const actions: ActionButton[] = [
    { label: t.common.actions.export, icon: Download, variant: 'outline' },
    { label: tc.newEntry, icon: PlusCircle, href: '/welddesk/changelog/new' },
  ];

  const statusFilters = [
    { key: 'all', label: tc.all, value: 'all', count: stats.total },
    { key: 'published', label: tc.published, value: 'published', count: stats.published },
    { key: 'draft', label: tc.draft, value: 'draft', count: stats.draft },
  ];

  const additionalFilters = [
    {
      key: 'type',
      label: tc.type,
      type: 'select' as const,
      options: [
        { label: tc.allTypes, value: 'all' },
        { label: tc.feature, value: 'feature' },
        { label: tc.improvement, value: 'improvement' },
        { label: tc.bugFix, value: 'bugfix' },
        { label: tc.breakingChange, value: 'breaking' },
      ],
    },
  ];

  const counts = {
    total: stats.total,
    published: stats.published,
    draft: stats.draft,
  };

  return (
    <EntityPageHeader
      title={tc.title}
      stats={headerStats}
      actions={actions}
    >
      <ChangelogClient
        items={items}
        pagination={pagination}
        params={currentParams}
        statusFilters={statusFilters}
        additionalFilters={additionalFilters}
        counts={counts}
      />
    </EntityPageHeader>
  );
}
