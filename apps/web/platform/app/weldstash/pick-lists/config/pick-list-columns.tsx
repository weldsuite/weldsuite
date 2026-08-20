import { Badge } from '@weldsuite/ui/components/badge';
import type { ColumnDef } from '@/components/panel-entity-list';
import type { WeldstashPickList } from '@/hooks/queries/use-weldstash-queries';
import { getTranslations } from '@/lib/i18n';

export function buildPickListColumns(): ColumnDef<WeldstashPickList>[] {
  const t = getTranslations('common').weldstash.pickLists;
  return [
    {
      id: 'number',
      header: t.colNumber,
      width: 'w-[160px]',
      render: (row) => <span className="font-medium truncate block">{row.pickListNumber}</span>,
    },
    {
      id: 'status',
      header: t.colStatus,
      width: 'w-[140px]',
      render: (row) => (
        <Badge variant="outline" className="capitalize">
          {row.status.replace('_', ' ')}
        </Badge>
      ),
    },
    {
      id: 'progress',
      header: t.colProgress,
      width: 'w-[140px]',
      render: (row) => (
        <span className="text-muted-foreground">
          {row.pickedItems ?? 0}/{row.totalItems ?? 0}
        </span>
      ),
    },
    {
      id: 'assignee',
      header: t.colAssignee,
      width: 'flex-1',
      render: (row) => (
        <span className="text-muted-foreground truncate block">{row.assignedToName || row.assignedTo || '—'}</span>
      ),
    },
    {
      id: 'orders',
      header: t.colOrders,
      width: 'w-[80px]',
      render: (row) => <span className="text-muted-foreground">{row.orderIds?.length ?? row.orderCount ?? 0}</span>,
    },
  ];
}
