/** WeldHR settings — evaluation (scorecard) forms tab. */

import { useMemo, useState } from 'react';
import { ClipboardCheck, Plus, GripVertical, ChevronUp, ChevronDown, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '@weldsuite/ui/components/sheet';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrEvaluationCriterion, HrEvaluationForm } from '@weldsuite/app-api-client/domains/weldhr';
import {
  useHrEvaluationForms,
  useCreateHrEvaluationForm,
  useUpdateHrEvaluationForm,
  useDeleteHrEvaluationForm,
} from '@/hooks/queries/use-weldhr-queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PanelEntityList, type ColumnDef, type GroupConfig } from '@/components/panel-entity-list';
import { ErrorBanner, errorMessage } from '../../components/shared';
import { emptyIcon } from '../../components/page-kit';

function newCriterion(): HrEvaluationCriterion {
  return { id: crypto.randomUUID(), label: '', description: null, weight: 1, maxScore: 10 };
}

interface FormState {
  id: string | null;
  name: string;
  description: string;
  isActive: boolean;
  criteria: HrEvaluationCriterion[];
}

function emptyForm(): FormState {
  return { id: null, name: '', description: '', isActive: true, criteria: [newCriterion()] };
}

export function EvaluationFormsTab() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canManage = can('employees:manage');
  const { data: forms, isLoading, error } = useHrEvaluationForms();
  const [form, setForm] = useState<FormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrEvaluationForm | null>(null);
  const [search, setSearch] = useState('');

  const items = useMemo(() => {
    const all = forms ?? [];
    if (!search.trim()) return all;
    const q = search.trim().toLowerCase();
    return all.filter((f) => f.name.toLowerCase().includes(q) || (f.description ?? '').toLowerCase().includes(q));
  }, [forms, search]);

  const groups: GroupConfig<HrEvaluationForm>[] = [
    { id: 'active', label: t('weldhr.settings.evaluationForms.active'), sortOrder: 1, filter: (i) => i.isActive },
    { id: 'inactive', label: t('weldhr.settings.evaluationForms.inactive'), sortOrder: 2, filter: (i) => !i.isActive },
  ];

  const columns: ColumnDef<HrEvaluationForm>[] = [
    {
      id: 'name',
      header: t('weldhr.settings.evaluationForms.name'),
      width: 'flex-1',
      render: (evalForm) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{evalForm.name}</p>
          {evalForm.description && <p className="truncate text-xs text-muted-foreground">{evalForm.description}</p>}
        </div>
      ),
    },
    {
      id: 'criteria',
      header: t('weldhr.settings.evaluationForms.criteria'),
      width: 'w-[140px]',
      render: (evalForm) => (
        <span className="text-muted-foreground">
          {t(
            evalForm.criteria.length === 1
              ? 'weldhr.settings.evaluationForms.criteriaCount'
              : 'weldhr.settings.evaluationForms.criteriaCountPlural',
            { count: evalForm.criteria.length },
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <PanelEntityList<HrEvaluationForm>
        items={items}
        isLoading={isLoading}
        error={error as Error | null}
        columns={columns}
        groups={groups}
        onEdit={
          canManage
            ? (evalForm) =>
                setForm({
                  id: evalForm.id,
                  name: evalForm.name,
                  description: evalForm.description ?? '',
                  isActive: evalForm.isActive,
                  criteria: evalForm.criteria.map((c) => ({ ...c })),
                })
            : undefined
        }
        onDelete={canManage ? setDeleteTarget : undefined}
        searchQuery={search}
        onSearchChange={setSearch}
        searchPlaceholder={t('weldhr.settings.evaluationForms.name')}
        createButton={canManage ? { label: t('weldhr.settings.evaluationForms.add'), onClick: () => setForm(emptyForm()) } : undefined}
        emptyState={{
          icon: emptyIcon(ClipboardCheck),
          title: t('weldhr.settings.evaluationForms.emptyTitle'),
          description: t('weldhr.settings.evaluationForms.emptyDescription'),
          action: canManage ? { label: t('weldhr.settings.evaluationForms.add'), onClick: () => setForm(emptyForm()) } : undefined,
        }}
      />

      {form && <EvaluationFormEditor form={form} onClose={() => setForm(null)} />}

      {deleteTarget && (
        <DeleteEvaluationFormDialog evalForm={deleteTarget} onClose={() => setDeleteTarget(null)} />
      )}
    </>
  );
}

function EvaluationFormEditor({ form, onClose }: { form: FormState; onClose: () => void }) {
  const t = useTranslations();
  const createForm = useCreateHrEvaluationForm();
  const updateForm = useUpdateHrEvaluationForm();
  const [state, setState] = useState(form);
  const [failure, setFailure] = useState<string | null>(null);
  const isEdit = Boolean(state.id);
  const pending = createForm.isPending || updateForm.isPending;
  const weightsTotal = state.criteria.reduce((sum, c) => sum + (Number(c.weight) || 0), 0);

  function updateCriterion(id: string, patch: Partial<HrEvaluationCriterion>) {
    setState({ ...state, criteria: state.criteria.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  }

  function removeCriterion(id: string) {
    setState({ ...state, criteria: state.criteria.filter((c) => c.id !== id) });
  }

  function moveCriterion(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= state.criteria.length) return;
    const criteria = [...state.criteria];
    [criteria[index], criteria[target]] = [criteria[target]!, criteria[index]!];
    setState({ ...state, criteria });
  }

  async function submit() {
    if (!state.name.trim() || state.criteria.length === 0) return;
    setFailure(null);
    const criteria = state.criteria.map((c) => ({ ...c, label: c.label.trim() }));
    if (criteria.some((c) => !c.label)) {
      setFailure(t('weldhr.settings.evaluationForms.criterionLabelRequired'));
      return;
    }
    const payload = {
      name: state.name.trim(),
      description: state.description.trim() || null,
      isActive: state.isActive,
      criteria,
    };
    try {
      if (state.id) {
        await updateForm.mutateAsync({ id: state.id, ...payload });
      } else {
        await createForm.mutateAsync(payload);
      }
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.common.saveFailed')));
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>
            {isEdit ? t('weldhr.settings.evaluationForms.editTitle') : t('weldhr.settings.evaluationForms.addTitle')}
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-4 px-4 pb-4">
          <ErrorBanner error={failure} />

          <div className="space-y-1.5">
            <Label htmlFor="eval-name">{t('weldhr.settings.evaluationForms.name')}</Label>
            <Input id="eval-name" value={state.name} onChange={(e) => setState({ ...state, name: e.target.value })} autoFocus />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="eval-description">{t('weldhr.settings.evaluationForms.description')}</Label>
            <Textarea
              id="eval-description"
              value={state.description}
              onChange={(e) => setState({ ...state, description: e.target.value })}
              rows={2}
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <Label htmlFor="eval-active">{t('weldhr.settings.evaluationForms.active')}</Label>
            <Switch id="eval-active" checked={state.isActive} onCheckedChange={(checked) => setState({ ...state, isActive: checked })} />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t('weldhr.settings.evaluationForms.criteria')}</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setState({ ...state, criteria: [...state.criteria, newCriterion()] })}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                {t('weldhr.settings.evaluationForms.addCriterion')}
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              {t('weldhr.settings.evaluationForms.weightsTotal', { total: weightsTotal })}
            </p>

            {state.criteria.map((criterion, index) => (
              <div key={criterion.id} className="space-y-2.5 rounded-lg border p-3">
                <div className="flex items-start gap-2">
                  <GripVertical className="mt-2.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1 space-y-2.5">
                    <Input
                      value={criterion.label}
                      placeholder={t('weldhr.settings.evaluationForms.criterionLabelPlaceholder')}
                      onChange={(e) => updateCriterion(criterion.id, { label: e.target.value })}
                    />
                    <Textarea
                      value={criterion.description ?? ''}
                      placeholder={t('weldhr.settings.evaluationForms.criterionDescriptionPlaceholder')}
                      onChange={(e) => updateCriterion(criterion.id, { description: e.target.value || null })}
                      rows={2}
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs">{t('weldhr.settings.evaluationForms.weight')}</Label>
                        <Input
                          type="number"
                          className="h-8"
                          min={0}
                          max={100}
                          value={criterion.weight}
                          onChange={(e) => updateCriterion(criterion.id, { weight: Number(e.target.value) || 0 })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">{t('weldhr.settings.evaluationForms.maxScore')}</Label>
                        <Input
                          type="number"
                          className="h-8"
                          min={1}
                          max={100}
                          value={criterion.maxScore}
                          onChange={(e) => updateCriterion(criterion.id, { maxScore: Number(e.target.value) || 1 })}
                        />
                      </div>
                    </div>
                    <div className="flex justify-end gap-1 pt-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        disabled={index === 0}
                        onClick={() => moveCriterion(index, -1)}
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        disabled={index === state.criteria.length - 1}
                        onClick={() => moveCriterion(index, 1)}
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive"
                        disabled={state.criteria.length <= 1}
                        onClick={() => removeCriterion(criterion.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <SheetFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={pending || !state.name.trim() || state.criteria.length === 0}
          >
            {pending ? t('weldhr.common.saving') : t('weldhr.common.save')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function DeleteEvaluationFormDialog({ evalForm, onClose }: { evalForm: HrEvaluationForm; onClose: () => void }) {
  const t = useTranslations();
  const deleteForm = useDeleteHrEvaluationForm();
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <>
      <ConfirmDialog
        open
        onOpenChange={(open) => !open && onClose()}
        title={t('weldhr.settings.evaluationForms.deleteTitle')}
        description={t('weldhr.settings.evaluationForms.deleteDescription', { name: evalForm.name })}
        confirmLabel={t('weldhr.common.delete')}
        cancelLabel={t('weldhr.common.cancel')}
        variant="destructive"
        onConfirm={async () => {
          try {
            await deleteForm.mutateAsync(evalForm.id);
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
