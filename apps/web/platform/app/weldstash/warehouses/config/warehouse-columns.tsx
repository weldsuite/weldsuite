import { Badge } from '@weldsuite/ui/components/badge';
import type { WeldstashWarehouse } from '@weldsuite/core-api-client/schemas/weldstash';
import type { ColumnDef } from '@/components/panel-entity-list';
import { getTranslations } from '@/lib/i18n';

export function buildWarehouseColumns(): ColumnDef<WeldstashWarehouse>[] {
  const t = getTranslations('commerce').module;
  return [
    {
      id: 'name',
      header: t.fields.name,
      width: 'flex-1',
      render: (w) => (
        <span className="font-medium truncate block">
          {w.name}
          {w.isDefault && (
            <Badge variant="outline" className="ml-2 align-middle">
              {t.fields.isDefault}
            </Badge>
          )}
        </span>
      ),
    },
    {
      id: 'code',
      header: t.fields.code,
      width: 'w-[120px]',
      render: (w) => <span className="text-muted-foreground">{w.code ?? '—'}</span>,
    },
    {
      id: 'city',
      header: t.fields.city,
      width: 'w-[160px]',
      render: (w) => <span className="text-muted-foreground truncate block">{w.city ?? '—'}</span>,
    },
    {
      id: 'country',
      header: t.fields.country,
      width: 'w-[130px]',
      render: (w) => <span className="text-muted-foreground">{w.country ?? '—'}</span>,
    },
    {
      id: 'contact',
      header: t.fields.contact,
      width: 'w-[170px]',
      render: (w) => (
        <span className="text-muted-foreground truncate block">{w.contactName ?? '—'}</span>
      ),
    },
    {
      id: 'status',
      header: t.fields.status,
      width: 'w-[120px]',
      render: (w) => (
        <Badge variant={w.isActive === false ? 'secondary' : 'default'}>
          {w.isActive === false ? t.status.inactive : t.status.active}
        </Badge>
      ),
    },
  ];
}
