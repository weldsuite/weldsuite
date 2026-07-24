
import { Link, useRouter } from '@/lib/router';
import { format, isValid } from 'date-fns';
import { useI18n } from '@/lib/i18n/provider';
import { EntityDataTable, type Column, type PaginationData, type StatusFilter, type FilterOption } from '@/components/entity-overview/entity-data-table';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EllipsisVertical, Eye, Edit, Trash2, Copy, Star } from 'lucide-react';
import type { NewsArticle } from '@/hooks/queries/use-helpdesk-queries';
function formatDate(date: Date | string | undefined, formatStr: string, fallback: string = '-'): string {
  if (!date) return fallback;
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  return isValid(dateObj) ? format(dateObj, formatStr) : fallback;
}


interface NewsClientProps {
  items: NewsArticle[];
  pagination: PaginationData;
  params: Record<string, string>;
  statusFilters: StatusFilter[];
  additionalFilters: FilterOption[];
}

export function NewsClient({
  items,
  pagination,
  params,
  statusFilters,
  additionalFilters,
}: NewsClientProps) {
  const { t } = useI18n();
  const nc = t.helpdesk.newsClient;
  const router = useRouter();
  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'company':
        return 'bg-blue-500/10 text-blue-600 border-blue-500/20';
      case 'product':
        return 'bg-green-500/10 text-green-600 border-green-500/20';
      case 'industry':
        return 'bg-purple-500/10 text-purple-600 border-purple-500/20';
      case 'announcement':
        return 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20';
      default:
        return 'bg-gray-500/10 text-gray-600 border-gray-500/20';
    }
  };

  const getStatusColor = (status: string): 'default' | 'secondary' | 'outline' => {
    switch (status) {
      case 'published':
        return 'default';
      case 'draft':
        return 'secondary';
      case 'scheduled':
        return 'outline';
      default:
        return 'secondary';
    }
  };

  const columns: Column<NewsArticle>[] = [
    {
      key: 'title',
      label: nc.titleColumn,
      sortable: true,
      width: '350px',
      render: (item) => (
        <div>
          <div className="font-medium mb-1 block">
            <div className="flex items-center gap-2">
              {item.title}
              {item.featured && <Star className="h-4 w-4 fill-yellow-500 text-yellow-500" />}
            </div>
          </div>
          <p className="text-sm text-muted-foreground line-clamp-1">{item.excerpt}</p>
        </div>
      ),
    },
    {
      key: 'category',
      label: nc.categoryColumn,
      sortable: true,
      width: '130px',
      render: (item) => (
        <Badge variant="outline" className={getCategoryColor(item.category)}>
          {item.category}
        </Badge>
      ),
    },
    {
      key: 'author',
      label: nc.authorColumn,
      sortable: true,
      width: '150px',
      render: (item) => <span className="text-sm">{item.author}</span>,
    },
    {
      key: 'publishDate',
      label: nc.publishDateColumn,
      sortable: true,
      width: '120px',
      render: (item) => (
        <span className="text-sm">{formatDate(item.publishDate, 'MMM dd, yyyy')}</span>
      ),
    },
    {
      key: 'status',
      label: nc.statusColumn,
      sortable: true,
      width: '100px',
      render: (item) => (
        <Badge variant={getStatusColor(item.status)}>
          {item.status}
        </Badge>
      ),
    },
    {
      key: 'views',
      label: nc.viewsColumn,
      sortable: true,
      width: '100px',
      render: (item) => (
        <span className="text-sm font-medium">{item.views.toLocaleString()}</span>
      ),
    },
    {
      key: 'tags',
      label: nc.tagsColumn,
      width: '180px',
      render: (item) => (
        <div className="flex flex-wrap gap-1">
          {item.tags.slice(0, 2).map(tag => (
            <Badge key={tag} variant="outline" className="text-xs">
              {tag}
            </Badge>
          ))}
          {item.tags.length > 2 && (
            <Badge variant="outline" className="text-xs">
              +{item.tags.length - 2}
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
          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
              <EllipsisVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href={`/welddesk/news/${item.id}`}>
                <Eye className="h-4 w-4 mr-0.5" />
                {nc.viewAction}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={`/welddesk/news/${item.id}/edit`}>
                <Edit className="h-4 w-4 mr-0.5" />
                {nc.editAction}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Copy className="h-4 w-4 mr-0.5" />
              {nc.duplicateAction}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-red-600">
              <Trash2 className="h-4 w-4 mr-0.5 text-red-600 dark:text-red-400" />
              {nc.deleteAction}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  const handleRowClick = (item: NewsArticle) => {
    router.push(`/welddesk/news/${item.id}/edit`);
  };

  return (
    <EntityDataTable
      columns={columns}
      data={items}
      pagination={pagination}
      searchParams={params}
      statusFilters={statusFilters}
      additionalFilters={additionalFilters}
      onRowClick={handleRowClick}
    />
  );
}
