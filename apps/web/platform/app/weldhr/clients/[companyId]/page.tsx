/** WeldHR client account detail: team, "what the client sees", and portal contacts. */

import { useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ExternalLink, Plus } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
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
import type { HrAssignment } from '@weldsuite/app-api-client/domains/weldhr';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
import { useObjectPanel } from '@/components/object-panel';
import { useHrClient, useUpdateHrAssignment, useDeleteHrAssignment } from '@/hooks/queries/use-weldhr-queries';
import { ClientPortalContactsCard } from '../../components/portal/client-contacts-card';
import { DetailHeader, DetailPage, DetailTabs, SectionCard, EmptyText, useHrBreadcrumbs } from '../../components/page-kit';
import { ErrorBanner, errorMessage, formatDate, todayIso } from '../../components/shared';
import { ClientAssignmentDialog } from '../components/client-assignment-dialog';
import { ClientViewTab } from '../components/client-view-tab';

type TabId = 'team' | 'client-view' | 'contacts';

export default function WeldHrClientDetailPage() {
  const t = useTranslations();
  const { can } = usePermissions();
  const { companyId } = useParams({ from: '/weldhr/clients/$companyId/' });
  const search = useSearch({ from: '/weldhr/clients/$companyId/' });
  const navigate = useNavigate();
  const { open: openObjectPanel } = useObjectPanel();

  const { data, isLoading, error } = useHrClient(companyId);
  const updateAssignment = useUpdateHrAssignment();
  const deleteAssignment = useDeleteHrAssignment();

  useHrBreadcrumbs(
    { label: t('weldhr.clients.title'), href: '/weldhr/clients' },
    data ? { label: data.company.name } : null,
  );

  const canUpdate = can('employees:update') || can('employees:manage');
  const activeTab: TabId = (search.tab as TabId | undefined) ?? 'team';

  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'edit'; assignment: HrAssignment } | { kind: 'delete'; assignment: HrAssignment } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  function setTab(tab: TabId) {
    void navigate({ to: '/weldhr/clients/$companyId', params: { companyId }, search: { tab }, replace: true });
  }

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!data) {
    return (
      <DetailPage>
        <ErrorBanner error={errorMessage(error, t('weldhr.clients.detail.loadFailed'))} />
      </DetailPage>
    );
  }

  const active = data.assignments.filter((a) => a.isActive);
  const past = data.assignments.filter((a) => !a.isActive);

  const tabs = [
    { id: 'team', label: t('weldhr.clients.detail.tabs.team') },
    { id: 'client-view', label: t('weldhr.clients.detail.tabs.clientView') },
    { id: 'contacts', label: t('weldhr.clients.detail.tabs.contacts') },
  ];

  return (
    <DetailPage>
      <DetailHeader
        title={data.company.name}
        actions={
          <Button variant="outline" size="sm" onClick={() => openObjectPanel({ type: 'company', id: companyId })}>
            <ExternalLink className="mr-1.5 h-4 w-4" />
            {t('weldhr.clients.detail.viewInCrm')}
          </Button>
        }
      />

      <DetailTabs tabs={tabs} activeTab={activeTab} onTabChange={(v) => setTab(v as TabId)} />

      {activeTab === 'team' && (
        <div className="space-y-4">
          <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
          <SectionCard
            title={t('weldhr.clients.detail.team.active')}
            action={
              canUpdate && (
                <Button size="sm" onClick={() => setDialog({ kind: 'create' })}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  {t('weldhr.employees.detail.clientsTab.addAssignment')}
                </Button>
              )
            }
          >
            {active.length === 0 ? (
              <EmptyText>{t('weldhr.clients.detail.team.empty')}</EmptyText>
            ) : (
              <AssignmentTable
                assignments={active}
                canUpdate={canUpdate}
                onEnd={async (a) => {
                  setFailure(null);
                  try {
                    await updateAssignment.mutateAsync({ id: a.id, endDate: todayIso() });
                  } catch (err) {
                    setFailure(errorMessage(err, t('weldhr.common.saveFailed')));
                  }
                }}
                onEdit={(a) => setDialog({ kind: 'edit', assignment: a })}
                onDelete={(a) => setDialog({ kind: 'delete', assignment: a })}
              />
            )}
          </SectionCard>

          {past.length > 0 && (
            <SectionCard title={t('weldhr.clients.detail.team.past')}>
              <AssignmentTable assignments={past} canUpdate={canUpdate} onEdit={(a) => setDialog({ kind: 'edit', assignment: a })} onDelete={(a) => setDialog({ kind: 'delete', assignment: a })} />
            </SectionCard>
          )}
        </div>
      )}

      {activeTab === 'client-view' && <ClientViewTab clientView={data.clientView} />}

      {activeTab === 'contacts' && <ClientPortalContactsCard companyId={companyId} companyName={data.company.name} />}

      {dialog?.kind === 'create' && <ClientAssignmentDialog companyId={companyId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <ClientAssignmentDialog companyId={companyId} assignment={dialog.assignment} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={t('weldhr.common.confirmDelete')}
          description={dialog.assignment.employeeName}
          variant="destructive"
          confirmLabel={t('weldhr.common.delete')}
          cancelLabel={t('weldhr.common.cancel')}
          onConfirm={async () => {
            try {
              await deleteAssignment.mutateAsync(dialog.assignment.id);
            } catch (err) {
              setFailure(errorMessage(err, t('weldhr.common.deleteFailed')));
            } finally {
              setDialog(null);
            }
          }}
        />
      )}
    </DetailPage>
  );
}

function AssignmentTable({
  assignments,
  canUpdate,
  onEnd,
  onEdit,
  onDelete,
}: {
  assignments: HrAssignment[];
  canUpdate: boolean;
  onEnd?: (a: HrAssignment) => void;
  onEdit: (a: HrAssignment) => void;
  onDelete: (a: HrAssignment) => void;
}) {
  const t = useTranslations();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('weldhr.common.employee')}</TableHead>
          <TableHead>{t('weldhr.employees.detail.clientsTab.table.role')}</TableHead>
          <TableHead>{t('weldhr.employees.detail.clientsTab.table.allocation')}</TableHead>
          <TableHead>{t('weldhr.employees.detail.clientsTab.table.dates')}</TableHead>
          {canUpdate && <TableHead className="w-px" />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {assignments.map((a) => (
          <TableRow key={a.id}>
            <TableCell>
              <Link to="/weldhr/employees/$employeeId" params={{ employeeId: a.employeeId }} className="hover:underline">
                {a.employeeName}
              </Link>
              {a.isPrimary && (
                <Badge variant="outline" className="ml-2">
                  {t('weldhr.employees.detail.clientsTab.table.primary')}
                </Badge>
              )}
            </TableCell>
            <TableCell className="text-muted-foreground">{a.role ?? '—'}</TableCell>
            <TableCell className="text-muted-foreground">{a.allocationPercent}%</TableCell>
            <TableCell className="text-muted-foreground">
              {formatDate(a.startDate)} – {a.endDate ? formatDate(a.endDate) : t('weldhr.common.none')}
            </TableCell>
            {canUpdate && (
              <TableCell>
                <div className="flex justify-end gap-1">
                  {onEnd && a.isActive && !a.endDate && (
                    <Button variant="ghost" size="sm" onClick={() => onEnd(a)}>
                      {t('weldhr.clients.detail.team.endAssignment')}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => onEdit(a)}>
                    {t('weldhr.common.edit')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onDelete(a)}>
                    {t('weldhr.common.delete')}
                  </Button>
                </div>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
