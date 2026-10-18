/** WeldHR settings — departments tab. */

import { useMemo, useState } from 'react';
import { Building2, Loader2 } from 'lucide-react';
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
import { Button } from '@weldsuite/ui/components/button';
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
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { EmployeePicker, ErrorBanner, errorMessage } from '../../components/shared';
import { cn } from '@/lib/utils';
import { HR_COL, HrListContainer, emptyIcon } from '../../components/page-kit';
import { ColorField } from './color-field';
import { subtreeOf } from './department-tree';

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
  const [search, setSearch] = useState('');

  const byId = new Map((departments ?? []).map((d) => [d.id, d]));

  const items = useMemo(() => {
    const all = departments ?? [];
    if (!search.trim()) return all;
    const q = search.trim().toLowerCase();
    return all.filter((d) => d.name.toLowerCase().includes(q) || (d.description ?? '').toLowerCase().includes(q));
  }, [departments, search]);

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

  const columns: ColumnDef<HrDepartment>[] = [
    {
      id: 'name',
      header: t('weldhr.settings.departments.name'),
      width: HR_COL.main,
      render: (dept) => (
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full border"
            style={{ backgroundColor: dept.color ?? undefined }}
          />
          <div className="min-w-0">
            <p className="truncate font-medium">{dept.name}</p>
            {dept.description && <p className="truncate text-xs text-muted-foreground">{dept.description}</p>}
            {/* The parent, once the list is too narrow for its own column. */}
            {dept.parentId && byId.get(dept.parentId) && (
              <p className="truncate text-xs text-muted-foreground @2xl:hidden">
                {t('weldhr.settings.departments.parent')}: {byId.get(dept.parentId)?.name}
              </p>
            )}
          </div>
        </div>
      ),
    },
    {
      id: 'parent',
      header: t('weldhr.settings.departments.parent'),
      width: cn(HR_COL.fixed, HR_COL.hideMd, 'w-[140px]'),
      render: (dept) => (
        <span className="block truncate text-muted-foreground">{dept.parentId ? (byId.get(dept.parentId)?.name ?? '—') : '—'}</span>
      ),
    },
    {
      id: 'head',
      header: t('weldhr.settings.departments.head'),
      // Shown from ~576px of list width, so it fits the narrow settings column.
      width: cn(HR_COL.fixed, 'hidden @xl:block w-[120px]'),
      render: (dept) => (
        <span className="text-muted-foreground">
          {dept.headEmployeeId ? t('weldhr.settings.departments.headAssigned') : '—'}
        </span>
      ),
    },
    {
      id: 'employeeCount',
      header: t('weldhr.settings.departments.employeeCount'),
      width: cn(HR_COL.fixed, 'w-[90px]'),
      render: (dept) => <span className="tabular-nums">{dept.employeeCount}</span>,
    },
  ];

  return (
    <>
      <HrListContainer>
        <PanelEntityList<HrDepartment>
          items={items}
          isLoading={isLoading}
          error={error as Error | null}
          columns={columns}
          onEdit={canManage ? openEdit : undefined}
          onDelete={canManage ? setDeleteTarget : undefined}
          searchQuery={search}
          onSearchChange={setSearch}
          searchPlaceholder={t('weldhr.settings.departments.name')}
          createButton={canManage ? { label: t('weldhr.settings.departments.add'), onClick: openCreate } : undefined}
          emptyState={{
            icon: emptyIcon(Building2),
            title: t('weldhr.settings.departments.emptyTitle'),
            description: t('weldhr.settings.departments.emptyDescription'),
            action: canManage ? { label: t('weldhr.settings.departments.add'), onClick: openCreate } : undefined,
          }}
        />
      </HrListContainer>

      {form && (
        <DepartmentDialog
          form={form}
          departments={departments ?? []}
          onClose={() => setForm(null)}
        />
      )}

      {deleteTarget && (
        <DeleteDepartmentDialog department={deleteTarget} departments={departments ?? []} onClose={() => setDeleteTarget(null)} />
      )}
    </>
  );
}

function DepartmentDialog({
  form,
  departments,
  onClose,
}: Readonly<{
  form: FormState;
  departments: HrDepartment[];
  onClose: () => void;
}>) {
  const t = useTranslations();
  const createDept = useCreateHrDepartment();
  const updateDept = useUpdateHrDepartment();
  const [state, setState] = useState(form);
  const [failure, setFailure] = useState<string | null>(null);
  const isEdit = Boolean(state.id);
  const pending = createDept.isPending || updateDept.isPending;

  // A department cannot sit under itself or anything below it (that would make a loop).
  const ownSubtree = state.id ? subtreeOf(departments, state.id) : new Set<string>();
  const parentOptions = departments.filter((d) => !ownSubtree.has(d.id));
  const nameTaken = departments.some(
    (d) => d.id !== state.id && d.name.trim().toLowerCase() === state.name.trim().toLowerCase(),
  );

  async function submit() {
    if (!state.name.trim() || nameTaken) return;
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
              aria-invalid={nameTaken}
              onChange={(e) => setState({ ...state, name: e.target.value })}
              autoFocus
            />
            {nameTaken && <p className="text-xs text-destructive">{t('weldhr.settings.departments.nameTaken')}</p>}
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
          <Button type="button" onClick={() => void submit()} disabled={pending || !state.name.trim() || nameTaken}>
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('weldhr.common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDepartmentDialog({
  department,
  departments,
  onClose,
}: Readonly<{ department: HrDepartment; departments: HrDepartment[]; onClose: () => void }>) {
  const t = useTranslations();
  const deleteDept = useDeleteHrDepartment();
  const [failure, setFailure] = useState<string | null>(null);
  const childCount = departments.filter((d) => d.parentId === department.id).length;
  const parentName = department.parentId ? departments.find((d) => d.id === department.parentId)?.name ?? null : null;

  // The server moves sub-departments up to this department's parent; say so before it happens.
  let description = t('weldhr.settings.departments.deleteDescription', { name: department.name });
  if (childCount > 0) {
    description += ` ${
      parentName
        ? t('weldhr.settings.departments.deleteMovesChildren', { count: childCount, parent: parentName })
        : t('weldhr.settings.departments.deleteMovesChildrenTop', { count: childCount })
    }`;
  }

  return (
    <>
      <ConfirmDialog
        open
        onOpenChange={(open) => !open && onClose()}
        title={t('weldhr.settings.departments.deleteTitle')}
        description={description}
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
