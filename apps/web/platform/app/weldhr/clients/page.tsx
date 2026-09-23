/** WeldHR client accounts: headcount/FTE per CRM company, and "Assign employee". */

import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { useHrClients } from '@/hooks/queries/use-weldhr-queries';
import { EmptyState, ErrorBanner, InlineSpinner, PageBody, PageHeader, errorMessage } from '../components/shared';
import { AssignEmployeeDialog } from './components/assign-employee-dialog';

export default function WeldHrClientsPage() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canAssign = can('employees:update') || can('employees:manage');
  const { data: clients, isLoading, error } = useHrClients();
  const [assigning, setAssigning] = useState(false);

  return (
    <PageBody wide>
      <PageHeader
        title={t('weldhr.clients.title')}
        subtitle={t('weldhr.clients.subtitle')}
        actions={
          canAssign ? (
            <Button onClick={() => setAssigning(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('weldhr.clients.assignEmployee')}
            </Button>
          ) : undefined
        }
      />

      <ErrorBanner error={error ? errorMessage(error, t('weldhr.clients.loadFailed')) : null} />

      {isLoading ? (
        <InlineSpinner />
      ) : !clients || clients.length === 0 ? (
        <EmptyState
          title={t('weldhr.clients.empty.title')}
          description={t('weldhr.clients.empty.description')}
          action={
            canAssign ? (
              <Button onClick={() => setAssigning(true)}>{t('weldhr.clients.assignEmployee')}</Button>
            ) : undefined
          }
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('weldhr.clients.table.company')}</TableHead>
                <TableHead>{t('weldhr.clients.table.active')}</TableHead>
                <TableHead>{t('weldhr.clients.table.fte')}</TableHead>
                <TableHead>{t('weldhr.clients.table.total')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.map((c) => (
                <TableRow key={c.companyId}>
                  <TableCell>
                    <Link to="/weldhr/clients/$companyId" params={{ companyId: c.companyId }} className="font-medium hover:underline">
                      {c.companyName ?? c.companyId}
                    </Link>
                  </TableCell>
                  <TableCell>{c.activeCount}</TableCell>
                  <TableCell>{c.fte.toFixed(1)}</TableCell>
                  <TableCell className="text-muted-foreground">{c.totalCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {assigning && <AssignEmployeeDialog onClose={() => setAssigning(false)} />}
    </PageBody>
  );
}
