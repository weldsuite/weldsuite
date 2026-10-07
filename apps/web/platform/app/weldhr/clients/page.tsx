/** WeldHR client accounts: headcount/FTE per CRM company, and "Assign employee". */

import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Building2 } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrClientAccount } from '@weldsuite/app-api-client/domains/weldhr';
import type { Company } from '@weldsuite/app-api-client/schemas/companies';
import { getCompanyAvatar } from '@/app/weldcrm/companies/config/company-grid-config';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { useHrClients } from '@/hooks/queries/use-weldhr-queries';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { emptyIcon, useHrBreadcrumbs } from '../components/page-kit';
import { AssignEmployeeDialog } from './components/assign-employee-dialog';

interface ClientRow extends HrClientAccount {
  id: string;
}

type CompanyLogoSource = Pick<Company, 'avatarUrl' | 'website' | 'email'> & { id: string };

export default function WeldHrClientsPage() {
  const t = useTranslations();
  useHrBreadcrumbs({ label: t('weldhr.clients.title') });
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canAssign = can('employees:update') || can('employees:manage');
  const { data: clients, isLoading, error } = useHrClients();
  const [assigning, setAssigning] = useState(false);
  const [search, setSearch] = useState('');

  // The client-accounts endpoint returns names only; the logo comes from the
  // CRM company record, the same way the Companies list derives it.
  const { getClient } = useAppApiClient();
  const { data: companiesData } = useQuery({
    queryKey: ['weldhr', 'clients', 'company-logos'],
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: CompanyLogoSource[] }>('/companies?limit=100');
    },
    staleTime: 60_000,
  });
  const logos = useMemo(
    () => new Map((companiesData?.data ?? []).map((c) => [c.id, getCompanyAvatar(c)])),
    [companiesData],
  );

  // The client-accounts endpoint returns the full list in one call — filter
  // client-side rather than round-tripping a search param that doesn't exist.
  const filtered: ClientRow[] = useMemo(() => {
    const rows = (clients ?? []).map((c) => ({ ...c, id: c.companyId }));
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((c) => (c.companyName ?? c.companyId).toLowerCase().includes(query));
  }, [clients, search]);

  const columns: ColumnDef<ClientRow>[] = [
    {
      id: 'company',
      header: t('weldhr.clients.table.company'),
      width: 'flex-1',
      render: (c) => {
        const name = c.companyName ?? c.companyId;
        return (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar className="h-[22px] w-[22px] shrink-0 rounded-md border border-border">
              <AvatarImage src={logos.get(c.companyId)} alt="" className="rounded-[inherit] object-cover" />
              <AvatarFallback className="rounded-md bg-muted text-[10px] font-medium">
                {name.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="truncate font-medium">{name}</span>
          </span>
        );
      },
    },
    {
      id: 'active',
      header: t('weldhr.clients.table.active'),
      width: 'w-[120px]',
      render: (c) => <span>{c.activeCount}</span>,
    },
    {
      id: 'fte',
      header: t('weldhr.clients.table.fte'),
      width: 'w-[120px]',
      render: (c) => <span>{c.fte.toFixed(1)}</span>,
    },
    {
      id: 'total',
      header: t('weldhr.clients.table.total'),
      width: 'w-[160px]',
      render: (c) => <span className="text-muted-foreground">{c.totalCount}</span>,
    },
  ];

  const createButton = canAssign ? { label: t('weldhr.clients.assignEmployee'), onClick: () => setAssigning(true) } : undefined;

  return (
    <>
      <PanelEntityList<ClientRow>
        items={filtered}
        isLoading={isLoading}
        error={error as Error | null}
        columns={columns}
        onRowClick={(c) => navigate({ to: '/weldhr/clients/$companyId', params: { companyId: c.companyId } })}
        searchQuery={search}
        onSearchChange={setSearch}
        searchPlaceholder={t('weldhr.clients.searchPlaceholder')}
        createButton={createButton}
        emptyState={{
          icon: emptyIcon(Building2),
          title: t('weldhr.clients.empty.title'),
          description: t('weldhr.clients.empty.description'),
          action: createButton,
        }}
      />

      {assigning && <AssignEmployeeDialog onClose={() => setAssigning(false)} />}
    </>
  );
}
