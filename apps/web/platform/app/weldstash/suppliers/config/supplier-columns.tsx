import { Badge } from '@weldsuite/ui/components/badge';
import type { ColumnDef } from '@/components/panel-entity-list';
import type { WmsSupplier } from '@/hooks/queries/use-weldstash-queries';
import { getTranslations } from '@/lib/i18n';

export function buildSupplierColumns(): ColumnDef<WmsSupplier>[] {
  const t = getTranslations('commerce').module;
  return [
    {
      id: 'name',
      header: t.fields.name,
      width: 'flex-1',
      render: (s) => <span className="font-medium truncate block">{s.name}</span>,
    },
    {
      id: 'code',
      header: t.fields.code,
      width: 'w-[120px]',
      render: (s) => <span className="text-muted-foreground">{s.code ?? '—'}</span>,
    },
    {
      id: 'email',
      header: t.fields.email,
      width: 'w-[220px]',
      render: (s) => <span className="text-muted-foreground truncate block">{s.email ?? '—'}</span>,
    },
    {
      id: 'phone',
      header: t.fields.phone,
      width: 'w-[150px]',
      render: (s) => <span className="text-muted-foreground">{s.phone ?? '—'}</span>,
    },
    {
      id: 'leadTime',
      header: t.fields.leadTime,
      width: 'w-[140px]',
      render: (s) => (
        <span className="text-muted-foreground">{s.defaultLeadTimeDays ?? '—'}</span>
      ),
    },
    {
      id: 'status',
      header: t.fields.status,
      width: 'w-[120px]',
      render: (s) => (
        <Badge variant={s.isActive === false ? 'secondary' : 'default'} className="capitalize">
          {s.status}
        </Badge>
      ),
    },
  ];
}
