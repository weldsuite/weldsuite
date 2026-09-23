/** WeldHR settings — departments tab. */

import { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
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
import type { HrDepartment } from '@weldsuite/app-api-client/domains/weldhr';
import {
  useHrDepartments,
  useCreateHrDepartment,
  useUpdateHrDepartment,
  useDeleteHrDepartment,
} from '@/hooks/queries/use-weldhr-queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmployeePicker, EmptyState, ErrorBanner, InlineSpinner, errorMessage } from '../../components/shared';
import { ColorField } from './color-field';

interface FormState {
  id: string | null;
  name: string;
  description: string;
  parentId: string | null;
  headEmployeeId: string | null;
  headEmployeeName: string | null;
  color: string;
}

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  description: '',
  parentId: null,
  headEmployeeId: null,
  headEmployeeName: null,
  color: '',
};

export function DepartmentsTab() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canManage = can('employees:manage');
  const { data: departments, isLoading, error } = useHrDepartments();
  const [form, setForm] = useState<FormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrDepartment | null>(null);

  const byId = new Map((departments ?? []).map((d) => [d.id, d]));

  function openCreate() {
    setForm({ ...EMPTY_FORM });
  }

  function openEdit(dept: HrDepartment) {
    setForm({
      id: dept.id,
      name: dept.name,
      description: dept.description ?? '',
      parentId: dept.parentId,
      headEmployeeId: dept.headEmployeeId,
      headEmployeeName: null,
      color: dept.color ?? '',
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t('weldhr.settings.departments.subtitle')}</p>
        {canManage && (
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('weldhr.settings.departments.add')}
          </Button>
        )}
      </div>

      <ErrorBanner error={error ? errorMessage(error, t('weldhr.common.loadFailed')) : null} />

      {isLoading ? (
        <InlineSpinner />
      ) : !departments || departments.length === 0 ? (
        <EmptyState
          title={t('weldhr.settings.departments.emptyTitle')}
          description={t('weldhr.settings.departments.emptyDescription')}
          action={
            canManage ? (
              <Button size="sm" onClick={openCreate}>
                {t('weldhr.settings.departments.add')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('weldhr.settings.departments.name')}</TableHead>
                <TableHead>{t('weldhr.settings.departments.parent')}</TableHead>
                <TableHead>{t('weldhr.settings.departments.head')}</TableHead>
                <TableHead className="text-right">{t('weldhr.settings.departments.employeeCount')}</TableHead>
                {canManage && <TableHead className="w-24" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {departments.map((dept) => (
                <TableRow key={dept.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full border"
                        style={{ backgroundColor: dept.color ?? undefined }}
                      />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{dept.name}</p>
                        {dept.description && (
                          <p className="truncate text-xs text-muted-foreground">{dept.description}</p>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {dept.parentId ? (byId.get(dept.parentId)?.name ?? '—') : '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {dept.headEmployeeId ? t('weldhr.settings.departments.headAssigned') : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{dept.employeeCount}</TableCell>
                  {canManage && (
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(dept)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          onClick={() => setDeleteTarget(dept)}
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

      {form && (
        <DepartmentDialog
          form={form}
          departments={departments ?? []}
          onClose={() => setForm(null)}
        />
      )}

      {deleteTarget && (
        <DeleteDepartmentDialog department={deleteTarget} onClose={() => setDeleteTarget(null)} />
      )}
    </div>
  );
}

function DepartmentDialog({
  form,
  departments,
  onClose,
}: {
  form: FormState;
  departments: HrDepartment[];
  onClose: () => void;
}) {
  const t = useTranslations();
  const createDept = useCreateHrDepartment();
  const updateDept = useUpdateHrDepartment();
  const [state, setState] = useState(form);
  const [failure, setFailure] = useState<string | null>(null);
  const isEdit = Boolean(state.id);
  const pending = createDept.isPending || updateDept.isPending;

  const parentOptions = departments.filter((d) => d.id !== state.id);

  async function submit() {
    if (!state.name.trim()) return;
    setFailure(null);
    const payload = {
      name: state.name.trim(),
      description: state.description.trim() || null,
      parentId: state.parentId,
      headEmployeeId: state.headEmployeeId,
      color: state.color.trim() || null,
    };
    try {
      if (state.id) {
        await updateDept.mutateAsync({ id: state.id, ...payload });
      } else {
        await createDept.mutateAsync(payload);
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
            {isEdit ? t('weldhr.settings.departments.editTitle') : t('weldhr.settings.departments.addTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />

          <div className="space-y-1.5">
            <Label htmlFor="dept-name">{t('weldhr.settings.departments.name')}</Label>
            <Input
              id="dept-name"
              value={state.name}
              onChange={(e) => setState({ ...state, name: e.target.value })}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="dept-description">{t('weldhr.settings.departments.description')}</Label>
            <Textarea
              id="dept-description"
              value={state.description}
              onChange={(e) => setState({ ...state, description: e.target.value })}
              rows={2}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('weldhr.settings.departments.parent')}</Label>
            <Select
              value={state.parentId ?? '__none__'}
              onValueChange={(v) => setState({ ...state, parentId: v === '__none__' ? null : v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t('weldhr.common.none')}</SelectItem>
                {parentOptions.map((dept) => (
                  <SelectItem key={dept.id} value={dept.id}>
                    {dept.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{t('weldhr.settings.departments.head')}</Label>
            <EmployeePicker
              value={state.headEmployeeId}
              valueLabel={state.headEmployeeName}
              onChange={(id, label) => setState({ ...state, headEmployeeId: id, headEmployeeName: label })}
              allowClear
            />
          </div>

          <ColorField
            id="dept-color"
            label={t('weldhr.settings.departments.color')}
            value={state.color}
            onChange={(color) => setState({ ...state, color })}
          />
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

function DeleteDepartmentDialog({ department, onClose }: { department: HrDepartment; onClose: () => void }) {
  const t = useTranslations();
  const deleteDept = useDeleteHrDepartment();
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <>
      <ConfirmDialog
        open
        onOpenChange={(open) => !open && onClose()}
        title={t('weldhr.settings.departments.deleteTitle')}
        description={t('weldhr.settings.departments.deleteDescription', { name: department.name })}
        confirmLabel={t('weldhr.common.delete')}
        cancelLabel={t('weldhr.common.cancel')}
        variant="destructive"
        onConfirm={async () => {
          try {
            await deleteDept.mutateAsync(department.id);
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
