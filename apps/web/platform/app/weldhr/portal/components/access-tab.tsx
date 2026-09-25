/** WeldHR workforce portal — access grants for employees and client contacts. */

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, RotateCcw, UserX, UserRound, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPortalAccess } from '@weldsuite/app-api-client/domains/weldhr';
import {
  useHrEmployees,
  useHrPortalAccess,
  useHrPortalSettings,
  useInviteHrPortalAccess,
  useRevokeHrPortalAccess,
  useRestoreHrPortalAccess,
  useDeleteHrPortalAccess,
} from '@/hooks/queries/use-weldhr-queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PanelEntityList, type ColumnDef, type GroupConfig } from '@/components/panel-entity-list';
import {
  CompanyPicker,
  EmployeePicker,
  ErrorBanner,
  PersonPicker,
  StatusBadge,
  errorMessage,
  formatDate,
  formatDateTime,
} from '../../components/shared';
import { emptyIcon } from '../../components/page-kit';

/** `base` for count === 1, `${base}Plural` otherwise — matches the repo's i18n plural convention. */
function pluralKey(base: string, count: number): string {
  return count === 1 ? base : `${base}Plural`;
}

export function PortalAccessTab() {
  const t = useTranslations();
  const settings = useHrPortalSettings();
  const { data: access, isLoading, error } = useHrPortalAccess({});
  const [inviteEmployees, setInviteEmployees] = useState(false);
  const [inviteClient, setInviteClient] = useState(false);
  const [bulkInviting, setBulkInviting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<HrPortalAccess | null>(null);
  const [search, setSearch] = useState('');

  const revoke = useRevokeHrPortalAccess();
  const restore = useRestoreHrPortalAccess();
  const [rowFailure, setRowFailure] = useState<string | null>(null);

  const portalDisabled = settings.data ? !settings.data.isEnabled : false;

  const items = useMemo(() => {
    const all = access ?? [];
    if (!search.trim()) return all;
    const q = search.trim().toLowerCase();
    return all.filter(
      (a) => (a.displayName ?? '').toLowerCase().includes(q) || a.email.toLowerCase().includes(q) || (a.companyName ?? '').toLowerCase().includes(q),
    );
  }, [access, search]);

  const groups: GroupConfig<HrPortalAccess>[] = [
    { id: 'employees', label: t('weldhr.portal.access.employeesTitle'), sortOrder: 1, filter: (i) => i.kind === 'employee' },
    { id: 'clients', label: t('weldhr.portal.access.clientsTitle'), sortOrder: 2, filter: (i) => i.kind === 'client' },
  ];

  async function handleRevoke(item: HrPortalAccess) {
    setRowFailure(null);
    try {
      await revoke.mutateAsync(item.id);
    } catch (err) {
      setRowFailure(errorMessage(err, t('weldhr.portal.access.revokeFailed')));
    }
  }

  async function handleRestore(item: HrPortalAccess) {
    setRowFailure(null);
    try {
      await restore.mutateAsync(item.id);
    } catch (err) {
      setRowFailure(errorMessage(err, t('weldhr.portal.access.restoreFailed')));
    }
  }

  const columns: ColumnDef<HrPortalAccess>[] = [
    {
      id: 'name',
      header: t('weldhr.portal.access.name'),
      width: 'flex-1',
      render: (item) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{item.displayName ?? item.email}</p>
          <p className="truncate text-xs text-muted-foreground">{item.email}</p>
        </div>
      ),
    },
    {
      id: 'company',
      header: t('weldhr.common.client'),
      width: 'w-[160px]',
      render: (item) => <span className="text-muted-foreground">{item.companyName ?? '—'}</span>,
    },
    {
      id: 'status',
      header: t('weldhr.common.status'),
      width: 'w-[110px]',
      render: (item) => <StatusBadge group="portalAccess" status={item.status} />,
    },
    {
      id: 'invitedAt',
      header: t('weldhr.portal.access.invitedAt'),
      width: 'w-[120px]',
      render: (item) => <span className="text-muted-foreground">{formatDate(item.invitedAt)}</span>,
    },
    {
      id: 'lastSignIn',
      header: t('weldhr.portal.access.lastSignIn'),
      width: 'w-[140px]',
      render: (item) => <span className="text-muted-foreground">{formatDateTime(item.lastLoginAt)}</span>,
    },
    {
      id: 'quickActions',
      header: '',
      width: 'w-[36px]',
      render: (item) =>
        item.status === 'revoked' ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title={t('weldhr.portal.access.restore')}
            onClick={(e) => {
              e.stopPropagation();
              void handleRestore(item);
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title={t('weldhr.portal.access.revoke')}
            onClick={(e) => {
              e.stopPropagation();
              void handleRevoke(item);
            }}
          >
            <UserX className="h-3.5 w-3.5" />
          </Button>
        ),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {portalDisabled && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
          {t('weldhr.portal.access.portalDisabledNotice')}
        </div>
      )}
      <ErrorBanner error={rowFailure} onDismiss={() => setRowFailure(null)} />

      <div className="min-h-0 flex-1">
        <PanelEntityList<HrPortalAccess>
          items={items}
          isLoading={isLoading}
          error={error as Error | null}
          columns={columns}
          groups={groups}
          onDelete={setDeleteTarget}
          searchQuery={search}
          onSearchChange={setSearch}
          searchPlaceholder={t('weldhr.portal.access.name')}
          actionButtons={
            <>
              <Button size="sm" variant="outline" className="h-8" onClick={() => setBulkInviting(true)}>
                {t('weldhr.portal.access.inviteAllActive')}
              </Button>
              <Button size="sm" variant="outline" className="h-8" onClick={() => setInviteClient(true)}>
                <Plus className="mr-1.5 h-4 w-4" />
                {t('weldhr.portal.access.inviteClientContact')}
              </Button>
            </>
          }
          createButton={{ label: t('weldhr.portal.access.inviteEmployees'), onClick: () => setInviteEmployees(true) }}
          emptyState={{
            icon: emptyIcon(UserRound),
            title: t('weldhr.portal.access.emptyTitle'),
            description: t('weldhr.portal.access.emptyDescription'),
            action: { label: t('weldhr.portal.access.inviteEmployees'), onClick: () => setInviteEmployees(true) },
          }}
        />
      </div>

      {inviteEmployees && <InviteEmployeesDialog onClose={() => setInviteEmployees(false)} />}
      {inviteClient && <InviteClientContactDialog onClose={() => setInviteClient(false)} />}
      {bulkInviting && (
        <BulkInviteActiveEmployeesDialog
          existingEmployeeIds={new Set((access ?? []).filter((a) => a.kind === 'employee').map((a) => a.employeeId).filter(Boolean) as string[])}
          onClose={() => setBulkInviting(false)}
        />
      )}
      {deleteTarget && <DeleteAccessDialog access={deleteTarget} onClose={() => setDeleteTarget(null)} />}
    </div>
  );
}

function InviteEmployeesDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const t = useTranslations();
  const invite = useInviteHrPortalAccess();
  const settings = useHrPortalSettings();
  const [rows, setRows] = useState<Array<{ key: string; employeeId: string | null; employeeName: string | null }>>([
    { key: crypto.randomUUID(), employeeId: null, employeeName: null },
  ]);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function updateRow(key: string, employeeId: string | null, employeeName: string | null) {
    setRows(rows.map((r) => (r.key === key ? { ...r, employeeId, employeeName } : r)));
  }

  function removeRow(key: string) {
    setRows(rows.filter((r) => r.key !== key));
  }

  async function submit() {
    const employeeIds = rows.map((r) => r.employeeId).filter((id): id is string => Boolean(id));
    if (employeeIds.length === 0) return;
    setFailure(null);
    setPending(true);
    let emailedCount = 0;
    let failed = 0;
    try {
      for (const employeeId of employeeIds) {
        try {
          const result = await invite.mutateAsync({ kind: 'employee', employeeId });
          if (result.data.emailed) emailedCount += 1;
        } catch {
          failed += 1;
        }
      }
      if (failed === 0) {
        toast.success(
          settings.data?.isEnabled
            ? t(pluralKey('weldhr.portal.access.inviteSentCount', emailedCount), { count: emailedCount })
            : t(pluralKey('weldhr.portal.access.inviteAddedNoEmail', employeeIds.length), { count: employeeIds.length }),
        );
        onClose();
      } else {
        setFailure(t('weldhr.portal.access.inviteSomeFailed', { failed, total: employeeIds.length }));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('weldhr.portal.access.inviteEmployees')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <ErrorBanner error={failure} />
          {!settings.data?.isEnabled && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              {t('weldhr.portal.access.portalDisabledNotice')}
            </p>
          )}

          {rows.map((row) => (
            <div key={row.key} className="flex items-center gap-2">
              <EmployeePicker
                value={row.employeeId}
                valueLabel={row.employeeName}
                onChange={(id, label) => updateRow(row.key, id, label)}
                className="flex-1"
              />
              {rows.length > 1 && (
                <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => removeRow(row.key)}>
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRows([...rows, { key: crypto.randomUUID(), employeeId: null, employeeName: null }])}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t('weldhr.portal.access.addAnother')}
          </Button>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={pending || rows.every((r) => !r.employeeId)}>
            {pending ? t('weldhr.common.saving') : t('weldhr.portal.access.invite')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteClientContactDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const t = useTranslations();
  const invite = useInviteHrPortalAccess();
  const settings = useHrPortalSettings();
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [personId, setPersonId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit() {
    if (!companyId || !personId) return;
    setFailure(null);
    try {
      const result = await invite.mutateAsync({ kind: 'client', personId, companyId });
      toast.success(
        result.data.emailed ? t('weldhr.portal.access.inviteSentCount', { count: 1 }) : t('weldhr.portal.access.inviteAddedNoEmail', { count: 1 }),
      );
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.portal.access.inviteFailed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('weldhr.portal.access.inviteClientContact')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <ErrorBanner error={failure} />
          {!settings.data?.isEnabled && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              {t('weldhr.portal.access.portalDisabledNotice')}
            </p>
          )}
          <CompanyPicker
            value={companyId}
            valueLabel={companyName}
            onChange={(id, label) => {
              setCompanyId(id);
              setCompanyName(label);
              setPersonId(null);
            }}
          />
          <PersonPicker companyId={companyId} value={personId} onChange={(id) => setPersonId(id)} />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={invite.isPending}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={invite.isPending || !companyId || !personId}>
            {invite.isPending ? t('weldhr.common.saving') : t('weldhr.portal.access.invite')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BulkInviteActiveEmployeesDialog({
  existingEmployeeIds,
  onClose,
}: Readonly<{
  existingEmployeeIds: Set<string>;
  onClose: () => void;
}>) {
  const t = useTranslations();
  const invite = useInviteHrPortalAccess();
  const { data, isLoading } = useHrEmployees({ status: 'active', limit: 200 });
  const eligible = useMemo(
    () => (data?.data ?? []).filter((e) => !existingEmployeeIds.has(e.id)),
    [data, existingEmployeeIds],
  );
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const running = progress !== null && progress.done < progress.total;

  async function run() {
    setFailure(null);
    setProgress({ done: 0, total: eligible.length });
    let emailed = 0;
    let failed = 0;
    for (let i = 0; i < eligible.length; i += 1) {
      try {
        const result = await invite.mutateAsync({ kind: 'employee', employeeId: eligible[i]!.id });
        if (result.data.emailed) emailed += 1;
      } catch {
        failed += 1;
      }
      setProgress({ done: i + 1, total: eligible.length });
    }
    if (failed === 0) {
      toast.success(t('weldhr.portal.access.bulkInviteDone', { count: eligible.length, emailed }));
      onClose();
    } else {
      setFailure(t('weldhr.portal.access.inviteSomeFailed', { failed, total: eligible.length }));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !running && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('weldhr.portal.access.inviteAllActive')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <ErrorBanner error={failure} />
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : eligible.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('weldhr.portal.access.bulkInviteNoneEligible')}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(pluralKey('weldhr.portal.access.bulkInviteConfirm', eligible.length), { count: eligible.length })}
            </p>
          )}
          {progress && (
            <div className="flex items-center gap-2 text-sm">
              {running && <Loader2 className="h-4 w-4 animate-spin" />}
              <span>{t('weldhr.portal.access.bulkInviteProgress', { done: progress.done, total: progress.total })}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={running}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button type="button" onClick={() => void run()} disabled={running || eligible.length === 0}>
            {running ? t('weldhr.common.saving') : t('weldhr.portal.access.invite')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteAccessDialog({ access, onClose }: Readonly<{ access: HrPortalAccess; onClose: () => void }>) {
  const t = useTranslations();
  const deleteAccess = useDeleteHrPortalAccess();
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <>
      <ConfirmDialog
        open
        onOpenChange={(open) => !open && onClose()}
        title={t('weldhr.portal.access.deleteTitle')}
        description={t('weldhr.portal.access.deleteDescription', { name: access.displayName ?? access.email })}
        confirmLabel={t('weldhr.common.delete')}
        cancelLabel={t('weldhr.common.cancel')}
        variant="destructive"
        onConfirm={async () => {
          try {
            await deleteAccess.mutateAsync(access.id);
            onClose();
          } catch (err) {
            setFailure(errorMessage(err, t('weldhr.common.deleteFailed')));
          }
        }}
      />
      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
    </>
  );
}
