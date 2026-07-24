
import { Link } from '@/lib/router';
import { format, isValid } from 'date-fns';
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
import type { Announcement } from '@/hooks/queries/use-helpdesk-queries';
import { useI18n } from '@/lib/i18n/provider';
function formatDate(date: Date | string | undefined, formatStr: string, fallback: string = '-'): string {
  if (!date) return fallback;
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  return isValid(dateObj) ? format(dateObj, formatStr) : fallback;
}


interface AnnouncementsClientProps {
  items: Announcement[];
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
}

export function AnnouncementsClient({
  items,
  pagination,
  params,
  statusFilters,
  additionalFilters,
}: AnnouncementsClientProps) {
  const { t } = useI18n();
  const ta = t.helpdesk.announcements;
  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: ta.title },
  ]);

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'success':
        return 'bg-green-500/10 text-green-600 border-green-500/20';
      case 'warning':
        return 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20';
      case 'error':
        return 'bg-red-500/10 text-red-600 border-red-500/20';
      case 'info':
        return 'bg-blue-500/10 text-blue-600 border-blue-500/20';
      default:
        return 'bg-gray-500/10 text-gray-600 border-gray-500/20';
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'critical':
        return 'bg-red-500/10 text-red-600 border-red-500/20';
      case 'high':
        return 'bg-orange-500/10 text-orange-600 border-orange-500/20';
      case 'medium':
        return 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20';
      case 'low':
        return 'bg-blue-500/10 text-blue-600 border-blue-500/20';
      default:
        return 'bg-gray-500/10 text-gray-600 border-gray-500/20';
    }
  };

  const columns: Column<Announcement>[] = [
    {
      key: 'title',
      label: ta.announcementTitle,
      sortable: true,
      width: '300px',
      render: (item) => (
        <div>
          <Link href={`/welddesk/announcements/${item.id}`} className="font-medium mb-1 hover:underline block">
            {item.title}
          </Link>
          <p className="text-sm text-muted-foreground line-clamp-1">{item.message}</p>
        </div>
      ),
    },
    {
      key: 'type',
      label: ta.type,
      sortable: true,
      width: '110px',
      render: (item) => (
        <Badge variant="outline" className={getTypeColor(item.type)}>
          {item.type}
        </Badge>
      ),
    },
    {
      key: 'priority',
      label: ta.priority,
      sortable: true,
      width: '110px',
      render: (item) => (
        <Badge variant="outline" className={getPriorityColor(item.priority)}>
          {item.priority}
        </Badge>
      ),
    },
    {
      key: 'targetAudience',
      label: ta.audience,
      sortable: true,
      width: '120px',
      render: (item) => (
        <span className="text-sm capitalize">{item.targetAudience}</span>
      ),
    },
    {
      key: 'startDate',
      label: ta.startDate,
      sortable: true,
      width: '120px',
      render: (item) => (
        <span className="text-sm">{formatDate(item.startDate, 'MMM dd, yyyy')}</span>
      ),
    },
    {
      key: 'endDate',
      label: ta.endDate,
      sortable: true,
      width: '120px',
      render: (item) => (
        <span className="text-sm">
          {item.endDate ? format(new Date(item.endDate), 'MMM dd, yyyy') : ta.noEndDate}
        </span>
      ),
    },
    {
      key: 'published',
      label: ta.status,
      sortable: true,
      width: '100px',
      render: (item) => (
        <Badge variant={item.published ? 'default' : 'secondary'}>
          {item.published ? ta.published : ta.draft}
        </Badge>
      ),
    },
    {
      key: 'views',
      label: ta.engagement,
      sortable: true,
      width: '120px',
      render: (item) => (
        <div className="text-sm">
          <div>{item.views.toLocaleString()} {ta.views}</div>
          <div className="text-muted-foreground">{item.clicks.toLocaleString()} {ta.clicks}</div>
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
              <Link href={`/welddesk/announcements/${item.id}`}>
                <Eye className="h-4 w-4 mr-0.5" />
                {ta.view}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/welddesk/announcements/${item.id}/edit`}>
                <Edit className="h-4 w-4 mr-0.5" />
                {t.helpdesk.actions.edit}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Copy className="h-4 w-4 mr-0.5" />
              {ta.duplicate}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-red-600">
              <Trash2 className="h-4 w-4 mr-0.5 text-red-600 dark:text-red-400" />
              {t.helpdesk.actions.delete}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

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
