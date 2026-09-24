/** WeldHR settings — leave types tab. */

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CalendarDays } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrLeaveType } from '@weldsuite/app-api-client/domains/weldhr';
import {
  useHrLeaveTypes,
  useCreateHrLeaveType,
  useUpdateHrLeaveType,
  useDeleteHrLeaveType,
} from '@/hooks/queries/use-weldhr-queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PanelEntityList, type ColumnDef, type GroupConfig } from '@/components/panel-entity-list';
import { ErrorBanner, errorMessage } from '../../components/shared';
import { emptyIcon } from '../../components/page-kit';
import { ColorField } from './color-field';

interface FormState {
  id: string | null;
  name: string;
  color: string;
  isPaid: boolean;
  requiresApproval: boolean;
  defaultAllowanceDays: string;
  isActive: boolean;
}

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  color: '',
  isPaid: true,
  requiresApproval: true,
  defaultAllowanceDays: '',
  isActive: true,
};

export function LeaveTypesTab() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canManage = can('employees:manage');
  const [includeInactive, setIncludeInactive] = useState(false);
  const { data: leaveTypes, isLoading, error } = useHrLeaveTypes(includeInactive);
  const [form, setForm] = useState<FormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrLeaveType | null>(null);
  const [search, setSearch] = useState('');

  const items = useMemo(() => {
    const all = leaveTypes ?? [];
    if (!search.trim()) return all;
    const q = search.trim().toLowerCase();
    return all.filter((lt) => lt.name.toLowerCase().includes(q));
  }, [leaveTypes, search]);

  const groups: GroupConfig<HrLeaveType>[] = [
    { id: 'active', label: t('weldhr.settings.leaveTypes.active'), sortOrder: 1, filter: (i) => i.isActive },
    { id: 'inactive', label: t('weldhr.settings.leaveTypes.inactive'), sortOrder: 2, filter: (i) => !i.isActive },
  ];

  const columns: ColumnDef<HrLeaveType>[] = [
    {
      id: 'name',
      header: t('weldhr.settings.leaveTypes.name'),
      width: 'flex-1',
      render: (leaveType) => (
        <div className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full border"
            style={{ backgroundColor: leaveType.color ?? undefined }}
          />
          <span className="font-medium">{leaveType.name}</span>
        </div>
      ),
    },
    {
      id: 'paid',
      header: t('weldhr.settings.leaveTypes.paid'),
      width: 'w-[90px]',
      render: (leaveType) => (
        <span className="text-muted-foreground">{leaveType.isPaid ? t('weldhr.common.yes') : t('weldhr.common.no')}</span>
      ),
    },
    {
      id: 'approval',
      header: t('weldhr.settings.leaveTypes.requiresApproval'),
      width: 'w-[140px]',
      render: (leaveType) => (
        <span className="text-muted-foreground">
          {leaveType.requiresApproval ? t('weldhr.common.yes') : t('weldhr.common.no')}
        </span>
      ),
    },
    {
      id: 'allowance',
      header: t('weldhr.settings.leaveTypes.allowance'),
      width: 'w-[140px]',
      render: (leaveType) => (
        <span className="tabular-nums">
          {leaveType.defaultAllowanceDays === null
            ? t('weldhr.settings.leaveTypes.unlimited')
            : t(
                leaveType.defaultAllowanceDays === 1
                  ? 'weldhr.settings.leaveTypes.daysPerYear'
                  : 'weldhr.settings.leaveTypes.daysPerYearPlural',
                { count: leaveType.defaultAllowanceDays },
              )}
        </span>
      ),
    },
  ];

  return (
    <>
      <PanelEntityList<HrLeaveType>
        items={items}
        isLoading={isLoading}
        error={error as Error | null}
        columns={columns}
        groups={groups}
        onEdit={
          canManage
            ? (leaveType) =>
                setForm({
                  id: leaveType.id,
                  name: leaveType.name,
                  color: leaveType.color ?? '',
                  isPaid: leaveType.isPaid,
                  requiresApproval: leaveType.requiresApproval,
                  defaultAllowanceDays: leaveType.defaultAllowanceDays?.toString() ?? '',
                  isActive: leaveType.isActive,
                })
            : undefined
        }
        onDelete={canManage ? setDeleteTarget : undefined}
        searchQuery={search}
        onSearchChange={setSearch}
        searchPlaceholder={t('weldhr.settings.leaveTypes.name')}
        actionButtons={
          <label className="flex h-8 items-center gap-2 px-1 text-sm">
            <Switch checked={includeInactive} onCheckedChange={setIncludeInactive} />
            <span className="hidden text-muted-foreground md:inline">{t('weldhr.settings.leaveTypes.includeInactive')}</span>
          </label>
        }
        createButton={canManage ? { label: t('weldhr.settings.leaveTypes.add'), onClick: () => setForm({ ...EMPTY_FORM }) } : undefined}
        emptyState={{
          icon: emptyIcon(CalendarDays),
          title: t('weldhr.settings.leaveTypes.emptyTitle'),
          description: t('weldhr.settings.leaveTypes.emptyDescription'),
          action: canManage ? { label: t('weldhr.settings.leaveTypes.add'), onClick: () => setForm({ ...EMPTY_FORM }) } : undefined,
        }}
      />

      {form && <LeaveTypeDialog form={form} onClose={() => setForm(null)} />}

      {deleteTarget && (
        <DeleteLeaveTypeDialog leaveType={deleteTarget} onClose={() => setDeleteTarget(null)} />
      )}
    </>
  );
}

function LeaveTypeDialog({ form, onClose }: { form: FormState; onClose: () => void }) {
  const t = useTranslations();
  const createType = useCreateHrLeaveType();
  const updateType = useUpdateHrLeaveType();
  const [state, setState] = useState(form);
  const [failure, setFailure] = useState<string | null>(null);
  const isEdit = Boolean(state.id);
  const pending = createType.isPending || updateType.isPending;

  async function submit() {
    if (!state.name.trim()) return;
    setFailure(null);
    const allowance = state.defaultAllowanceDays.trim();
    const payload = {
      name: state.name.trim(),
      color: state.color.trim() || null,
      isPaid: state.isPaid,
      requiresApproval: state.requiresApproval,
      defaultAllowanceDays: allowance === '' ? null : Number(allowance),
      isActive: state.isActive,
    };
    try {
      if (state.id) {
        await updateType.mutateAsync({ id: state.id, ...payload });
      } else {
        await createType.mutateAsync(payload);
      }
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.common.saveFailed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('weldhr.settings.leaveTypes.editTitle') : t('weldhr.settings.leaveTypes.addTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />

          <div className="space-y-1.5">
            <Label htmlFor="leave-name">{t('weldhr.settings.leaveTypes.name')}</Label>
            <Input id="leave-name" value={state.name} onChange={(e) => setState({ ...state, name: e.target.value })} autoFocus />
          </div>

          <ColorField
            id="leave-color"
            label={t('weldhr.settings.leaveTypes.color')}
            value={state.color}
            onChange={(color) => setState({ ...state, color })}
          />

          <div className="space-y-1.5">
            <Label htmlFor="leave-allowance">{t('weldhr.settings.leaveTypes.allowance')}</Label>
            <Input
              id="leave-allowance"
              type="number"
              min={0}
              max={366}
              value={state.defaultAllowanceDays}
              placeholder={t('weldhr.settings.leaveTypes.unlimited')}
              onChange={(e) => setState({ ...state, defaultAllowanceDays: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">{t('weldhr.settings.leaveTypes.allowanceHint')}</p>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <Label htmlFor="leave-paid">{t('weldhr.settings.leaveTypes.paid')}</Label>
            <Switch id="leave-paid" checked={state.isPaid} onCheckedChange={(checked) => setState({ ...state, isPaid: checked })} />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <Label htmlFor="leave-approval">{t('weldhr.settings.leaveTypes.requiresApproval')}</Label>
            <Switch
              id="leave-approval"
              checked={state.requiresApproval}
              onCheckedChange={(checked) => setState({ ...state, requiresApproval: checked })}
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <Label htmlFor="leave-active">{t('weldhr.settings.leaveTypes.active')}</Label>
            <Switch id="leave-active" checked={state.isActive} onCheckedChange={(checked) => setState({ ...state, isActive: checked })} />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={pending || !state.name.trim()}>
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('weldhr.common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteLeaveTypeDialog({ leaveType, onClose }: { leaveType: HrLeaveType; onClose: () => void }) {
  const t = useTranslations();
  const deleteType = useDeleteHrLeaveType();
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <>
      <ConfirmDialog
        open
        onOpenChange={(open) => !open && onClose()}
        title={t('weldhr.settings.leaveTypes.deleteTitle')}
        description={t('weldhr.settings.leaveTypes.deleteDescription', { name: leaveType.name })}
        confirmLabel={t('weldhr.common.delete')}
        cancelLabel={t('weldhr.common.cancel')}
        variant="destructive"
        onConfirm={async () => {
          try {
            const result = await deleteType.mutateAsync(leaveType.id);
            if (result.data.archived) {
              toast.info(t('weldhr.settings.leaveTypes.archivedInstead', { name: leaveType.name }));
            }
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
