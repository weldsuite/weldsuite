/** WeldHR settings — leave types tab. */

import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
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
import type { HrLeaveType } from '@weldsuite/app-api-client/domains/weldhr';
import {
  useHrLeaveTypes,
  useCreateHrLeaveType,
  useUpdateHrLeaveType,
  useDeleteHrLeaveType,
} from '@/hooks/queries/use-weldhr-queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState, ErrorBanner, InlineSpinner, errorMessage } from '../../components/shared';
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">{t('weldhr.settings.leaveTypes.subtitle')}</p>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch id="include-inactive" checked={includeInactive} onCheckedChange={setIncludeInactive} />
            <Label htmlFor="include-inactive" className="text-sm font-normal">
              {t('weldhr.settings.leaveTypes.includeInactive')}
            </Label>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => setForm({ ...EMPTY_FORM })}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('weldhr.settings.leaveTypes.add')}
            </Button>
          )}
        </div>
      </div>

      <ErrorBanner error={error ? errorMessage(error, t('weldhr.common.loadFailed')) : null} />

      {isLoading ? (
        <InlineSpinner />
      ) : !leaveTypes || leaveTypes.length === 0 ? (
        <EmptyState
          title={t('weldhr.settings.leaveTypes.emptyTitle')}
          description={t('weldhr.settings.leaveTypes.emptyDescription')}
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('weldhr.settings.leaveTypes.name')}</TableHead>
                <TableHead>{t('weldhr.settings.leaveTypes.paid')}</TableHead>
                <TableHead>{t('weldhr.settings.leaveTypes.requiresApproval')}</TableHead>
                <TableHead className="text-right">{t('weldhr.settings.leaveTypes.allowance')}</TableHead>
                <TableHead>{t('weldhr.common.status')}</TableHead>
                {canManage && <TableHead className="w-24" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {leaveTypes.map((leaveType) => (
                <TableRow key={leaveType.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full border"
                        style={{ backgroundColor: leaveType.color ?? undefined }}
                      />
                      <span className="font-medium">{leaveType.name}</span>
                    </div>
                  </TableCell>
                  <TableCell>{leaveType.isPaid ? t('weldhr.common.yes') : t('weldhr.common.no')}</TableCell>
                  <TableCell>{leaveType.requiresApproval ? t('weldhr.common.yes') : t('weldhr.common.no')}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {leaveType.defaultAllowanceDays === null
                      ? t('weldhr.settings.leaveTypes.unlimited')
                      : t(
                          leaveType.defaultAllowanceDays === 1
                            ? 'weldhr.settings.leaveTypes.daysPerYear'
                            : 'weldhr.settings.leaveTypes.daysPerYearPlural',
                          { count: leaveType.defaultAllowanceDays },
                        )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={leaveType.isActive ? 'default' : 'secondary'}>
                      {leaveType.isActive ? t('weldhr.settings.leaveTypes.active') : t('weldhr.settings.leaveTypes.inactive')}
                    </Badge>
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() =>
                            setForm({
                              id: leaveType.id,
                              name: leaveType.name,
                              color: leaveType.color ?? '',
                              isPaid: leaveType.isPaid,
                              requiresApproval: leaveType.requiresApproval,
                              defaultAllowanceDays: leaveType.defaultAllowanceDays?.toString() ?? '',
                              isActive: leaveType.isActive,
                            })
                          }
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          onClick={() => setDeleteTarget(leaveType)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {form && <LeaveTypeDialog form={form} onClose={() => setForm(null)} />}

      {deleteTarget && (
        <DeleteLeaveTypeDialog leaveType={deleteTarget} onClose={() => setDeleteTarget(null)} />
      )}
    </div>
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
            {pending ? t('weldhr.common.saving') : t('weldhr.common.save')}
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
