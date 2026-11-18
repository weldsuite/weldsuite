import { Badge } from '@weldsuite/ui/components/badge';
import { Building2, User } from 'lucide-react';
import type { ColumnDef } from '@/components/panel-entity-list';
import { LIST_PRIMARY_COLUMN } from '@/app/weldcommerce/products/config/product-columns';
import { getTranslations } from '@/lib/i18n';
import type { CustomerRow } from './customer-row';

export function buildCustomerColumns(): ColumnDef<CustomerRow>[] {
  const t = getTranslations('commerce').module;
  return [
    {
      id: 'name',
      header: t.fields.name,
      width: LIST_PRIMARY_COLUMN,
      render: (c) => (
        <span className="flex items-center gap-2 min-w-0">
          {c.kind === 'company' ? (
            <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <User className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="font-medium truncate">{c.displayName}</span>
        </span>
      ),
    },
    {
      id: 'kind',
      header: t.fields.type,
      width: 'hidden @5xl/list:block w-[120px]',
      render: (c) => (
        <Badge variant="outline">
          {c.kind === 'company' ? t.customers.kindCompany : t.customers.kindPerson}
        </Badge>
      ),
    },
    {
      id: 'email',
      header: t.fields.email,
      width: 'hidden @lg/list:block w-[220px]',
      render: (c) => <span className="text-muted-foreground truncate block">{c.email ?? '—'}</span>,
    },
    {
      id: 'phone',
      header: t.fields.phone,
      width: 'hidden @4xl/list:block w-[150px]',
      render: (c) => <span className="text-muted-foreground">{c.phone ?? '—'}</span>,
    },
    {
      id: 'subtitle',
      header: t.customers.roleOrIndustry,
      width: 'hidden @6xl/list:block w-[170px]',
      render: (c) => (
        <span className="text-muted-foreground truncate block">{c.subtitle ?? '—'}</span>
      ),
    },
    {
      id: 'status',
      header: t.fields.status,
      width: 'hidden @2xl/list:block w-[130px]',
      render: (c) =>
        c.status ? (
          <Badge variant="outline" className="capitalize">
            {c.status}
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];
}
