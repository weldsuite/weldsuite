
import { useSearchParams, Link } from '@/lib/router';
import { FileText, PlusCircle, Download, Eye } from 'lucide-react';
import { EntityPageHeader, type StatItem } from '@/components/entity-overview/entity-page-header';
import { Button } from '@weldsuite/ui/components/button';
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
  searchParams.forEach((value, key) => {
    currentParams[key] = value;
  });

  const { data, isLoading } = useChangelog({
    page,
    pageSize: 20,
    search,
  });

  if (isLoading) return <PageLoader fullScreen={false} />;

  const items = data?.data || [];
  const pagination = data?.pagination || {
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  };

  // Calculate stats from items
  const thisMonth = new Date();
  thisMonth.setDate(1);
  thisMonth.setHours(0, 0, 0, 0);

  const stats = {
    total: pagination.totalCount || pagination.total || items.length,
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

  const actions = (
    <div className="flex gap-2">
      <Button variant="outline" size="sm">
        <Download className="h-4 w-4 mr-0.5" />
        {t.common.actions.export}
      </Button>
      <Button size="sm" asChild>
        <Link href="/welddesk/changelog/new">
          <PlusCircle className="h-4 w-4 mr-0.5" />
          {tc.newEntry}
        </Link>
      </Button>
    </div>
  );

  const statusFilters = [
    { label: tc.all, value: 'all', count: stats.total },
    { label: tc.published, value: 'published', count: stats.published },
    { label: tc.draft, value: 'draft', count: stats.draft },
  ];

  const additionalFilters = [
    {
      key: 'type',
      label: tc.type,
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
