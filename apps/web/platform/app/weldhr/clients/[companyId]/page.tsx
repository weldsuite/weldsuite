/** WeldHR client account detail: team, "what the client sees", and portal contacts. */

import { useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ExternalLink, Plus } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
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
import { useObjectPanel } from '@/components/object-panel';
import { useHrClient, useUpdateHrAssignment, useDeleteHrAssignment } from '@/hooks/queries/use-weldhr-queries';
import { ClientPortalContactsCard } from '../../components/portal/client-contacts-card';
import {
  ErrorBanner,
  InlineSpinner,
  PageBody,
  PageHeader,
  errorMessage,
  formatDate,
  todayIso,
} from '../../components/shared';
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

  const canUpdate = can('employees:update') || can('employees:manage');
  const activeTab: TabId = (search.tab as TabId | undefined) ?? 'team';

  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'edit'; assignment: HrAssignment } | { kind: 'delete'; assignment: HrAssignment } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  function setTab(tab: TabId) {
    void navigate({ to: '/weldhr/clients/$companyId', params: { companyId }, search: { tab }, replace: true });
  }

  if (isLoading) {
    return (
      <PageBody wide>
        <InlineSpinner />
      </PageBody>
    );
  }

  if (!data) {
    return (
      <PageBody wide>
        <ErrorBanner error={errorMessage(error, t('weldhr.clients.detail.loadFailed'))} />
      </PageBody>
    );
  }

  const active = data.assignments.filter((a) => a.isActive);
  const past = data.assignments.filter((a) => !a.isActive);

  return (
    <PageBody wide>
      <PageHeader
        title={data.company.name}
        actions={
          <Button variant="outline" size="sm" onClick={() => openObjectPanel({ type: 'company', id: companyId })}>
            <ExternalLink className="mr-1.5 h-4 w-4" />
            {t('weldhr.clients.detail.viewInCrm')}
          </Button>
        }
      />

      <Tabs value={activeTab} onValueChange={(v) => setTab(v as TabId)}>
        <TabsList>
          <TabsTrigger value="team">{t('weldhr.clients.detail.tabs.team')}</TabsTrigger>
          <TabsTrigger value="client-view">{t('weldhr.clients.detail.tabs.clientView')}</TabsTrigger>
          <TabsTrigger value="contacts">{t('weldhr.clients.detail.tabs.contacts')}</TabsTrigger>
        </TabsList>
      </Tabs>

      {activeTab === 'team' && (
        <Card className="p-4">
          <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t('weldhr.clients.detail.team.active')}</h2>
            {canUpdate && (
              <Button size="sm" onClick={() => setDialog({ kind: 'create' })}>
                <Plus className="mr-1.5 h-4 w-4" />
                {t('weldhr.employees.detail.clientsTab.addAssignment')}
              </Button>
            )}
          </div>
          {active.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('weldhr.clients.detail.team.empty')}</p>
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

          {past.length > 0 && (
            <div className="mt-6">
              <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{t('weldhr.clients.detail.team.past')}</h2>
              <AssignmentTable assignments={past} canUpdate={canUpdate} onEdit={(a) => setDialog({ kind: 'edit', assignment: a })} onDelete={(a) => setDialog({ kind: 'delete', assignment: a })} />
            </div>
          )}
        </Card>
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
    </PageBody>
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
