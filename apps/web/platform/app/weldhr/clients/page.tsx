/** WeldHR client accounts: headcount/FTE per CRM company, and "Assign employee". */

import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Building2 } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrClientAccount } from '@weldsuite/app-api-client/domains/weldhr';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { useHrClients } from '@/hooks/queries/use-weldhr-queries';
import { emptyIcon, useHrBreadcrumbs } from '../components/page-kit';
import { AssignEmployeeDialog } from './components/assign-employee-dialog';

interface ClientRow extends HrClientAccount {
  id: string;
}

export default function WeldHrClientsPage() {
  const t = useTranslations();
  useHrBreadcrumbs({ label: t('weldhr.clients.title') });
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canAssign = can('employees:update') || can('employees:manage');
  const { data: clients, isLoading, error } = useHrClients();
  const [assigning, setAssigning] = useState(false);
  const [search, setSearch] = useState('');

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
      render: (c) => <span className="font-medium">{c.companyName ?? c.companyId}</span>,
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
