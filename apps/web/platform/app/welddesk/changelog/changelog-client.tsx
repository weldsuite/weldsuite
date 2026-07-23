
import { useState } from 'react';
import { Link } from '@/lib/router';
import { format } from 'date-fns';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { EntityDataTable, type Column } from '@/components/entity-overview/entity-data-table';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EllipsisVertical, Eye, Edit, Trash2, Copy } from 'lucide-react';
import type { ChangelogEntry } from '@/hooks/queries/use-helpdesk-queries';
import { useI18n } from '@/lib/i18n/provider';

interface ChangelogClientProps {
  items: ChangelogEntry[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  params: Record<string, string>;
  statusFilters: Array<{ label: string; value: string; count: number }>;
  additionalFilters: Array<{
    key: string;
    label: string;
    options: Array<{ label: string; value: string }>;
  }>;
  counts: {
    total: number;
    published: number;
    draft: number;
  };
}

export function ChangelogClient({
  items,
  pagination,
  params,
  statusFilters,
  additionalFilters,
  counts,
}: ChangelogClientProps) {
  const { t } = useI18n();
  const tc = t.helpdesk.changelog;
  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: tc.title },
  ]);

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'feature':
        return 'bg-green-500/10 text-green-600 border-green-500/20';
      case 'improvement':
        return 'bg-blue-500/10 text-blue-600 border-blue-500/20';
      case 'bugfix':
        return 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20';
      case 'breaking':
        return 'bg-red-500/10 text-red-600 border-red-500/20';
      default:
        return 'bg-gray-500/10 text-gray-600 border-gray-500/20';
    }
  };

  /* eslint-disable */
  const columns: Column<ChangelogEntry>[] = [
    {
      key: 'version',
      label: tc.version,
      sortable: true,
      width: '120px',
      render: (item) => (
        <Link href={`/welddesk/changelog/${item.id}`} className="font-mono font-semibold hover:underline">
          v{item.version}
        </Link>
      ),
    },
    {
      key: 'title',
      label: t.helpdesk.announcements.announcementTitle,
      sortable: true,
      width: '300px',
      render: (item) => (
        <div>
          <Link href={`/welddesk/changelog/${item.id}`} className="font-medium mb-1 hover:underline block">
            {item.title}
          </Link>
          <p className="text-sm text-muted-foreground line-clamp-1">{item.description}</p>
        </div>
      ),
    },
    {
      key: 'type',
      label: tc.type,
      sortable: true,
      width: '130px',
      render: (item) => (
        <Badge variant="outline" className={getTypeColor(item.type)}>
          {item.type}
        </Badge>
      ),
    },
    {
      key: 'date',
      label: tc.date,
      sortable: true,
      width: '120px',
      render: (item) => (
        <span className="text-sm">{format(new Date(item.date), 'MMM dd, yyyy')}</span>
      ),
    },
    {
      key: 'published',
      label: tc.status,
      sortable: true,
      width: '100px',
      render: (item) => (
        <Badge variant={item.published ? 'default' : 'secondary'}>
          {item.published ? tc.published : tc.draft}
        </Badge>
      ),
    },
    {
      key: 'author',
      label: tc.author,
      sortable: true,
      width: '150px',
      render: (item) => <span className="text-sm">{item.author}</span>,
    },
    {
      key: 'tags',
      label: tc.tags,
      width: '200px',
      render: (item) => (
        <div className="flex flex-wrap gap-1">
          {item.tags.slice(0, 3).map(tag => (
            <Badge key={tag} variant="outline" className="text-xs">
              {tag}
            </Badge>
          ))}
          {item.tags.length > 3 && (
            <Badge variant="outline" className="text-xs">
              +{item.tags.length - 3}
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      label: '',
      width: '50px',
      render: (item) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
              <EllipsisVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href={`/welddesk/changelog/${item.id}`}>
                <Eye className="h-4 w-4 mr-0.5" />
                {tc.view}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/welddesk/changelog/${item.id}/edit`}>
                <Edit className="h-4 w-4 mr-0.5" />
                {t.common.actions.edit}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Copy className="h-4 w-4 mr-0.5" />
              {tc.duplicate}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-red-600">
              <Trash2 className="h-4 w-4 mr-0.5 text-red-600 dark:text-red-400" />
              {t.common.actions.delete}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];
  /* eslint-enable */

  return (
    <EntityDataTable
      columns={columns}
      data={items}
      pagination={pagination}
      params={params}
      statusFilters={statusFilters}
      additionalFilters={additionalFilters}
    />
  );
}
