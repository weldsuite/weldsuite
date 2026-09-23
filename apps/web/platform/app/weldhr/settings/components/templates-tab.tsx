/** WeldHR settings — onboarding/offboarding checklist templates tab. */

import { useState } from 'react';
import { Plus, Pencil, Trash2, ChevronUp, ChevronDown, GripVertical } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '@weldsuite/ui/components/sheet';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type {
  HrAssigneeRole,
  HrChecklistTemplate,
  HrChecklistTemplateItem,
} from '@weldsuite/app-api-client/domains/weldhr';
import {
  useHrChecklistTemplates,
  useCreateHrChecklistTemplate,
  useUpdateHrChecklistTemplate,
  useDeleteHrChecklistTemplate,
} from '@/hooks/queries/use-weldhr-queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState, ErrorBanner, InlineSpinner, StatusBadge, errorMessage } from '../../components/shared';

const ASSIGNEE_ROLES: HrAssigneeRole[] = ['hr', 'manager', 'it', 'employee', 'other'];

interface FormState {
  id: string | null;
  name: string;
  description: string;
  kind: 'onboarding' | 'offboarding';
  isDefault: boolean;
  items: HrChecklistTemplateItem[];
}

function emptyForm(kind: 'onboarding' | 'offboarding' = 'onboarding'): FormState {
  return { id: null, name: '', description: '', kind, isDefault: false, items: [] };
}

function newItem(): HrChecklistTemplateItem {
  return {
    id: crypto.randomUUID(),
    title: '',
    description: null,
    assigneeRole: 'hr',
    dueOffsetDays: 0,
    visibleToEmployee: false,
  };
}

export function TemplatesTab() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canManage = can('employees:manage');
  const { data: templates, isLoading, error } = useHrChecklistTemplates();
  const [form, setForm] = useState<FormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrChecklistTemplate | null>(null);

  function openEdit(template: HrChecklistTemplate) {
    setForm({
      id: template.id,
      name: template.name,
      description: template.description ?? '',
      kind: template.kind,
      isDefault: template.isDefault,
      items: template.items.map((item) => ({ ...item })),
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t('weldhr.settings.templates.subtitle')}</p>
        {canManage && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setForm(emptyForm('onboarding'))}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('weldhr.settings.templates.addOnboarding')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setForm(emptyForm('offboarding'))}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('weldhr.settings.templates.addOffboarding')}
            </Button>
          </div>
        )}
      </div>

      <ErrorBanner error={error ? errorMessage(error, t('weldhr.common.loadFailed')) : null} />

      {isLoading ? (
        <InlineSpinner />
      ) : !templates || templates.length === 0 ? (
        <EmptyState
          title={t('weldhr.settings.templates.emptyTitle')}
          description={t('weldhr.settings.templates.emptyDescription')}
        />
      ) : (
        <div className="space-y-2">
          {templates.map((template) => (
            <div key={template.id} className="flex items-center justify-between gap-4 rounded-lg border p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate font-medium">{template.name}</p>
                  <StatusBadge group="checklistKind" status={template.kind} />
                  {template.isDefault && <Badge variant="outline">{t('weldhr.settings.templates.default')}</Badge>}
                </div>
                {template.description && (
                  <p className="truncate text-xs text-muted-foreground">{template.description}</p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(
                    template.items.length === 1 ? 'weldhr.settings.templates.itemCount' : 'weldhr.settings.templates.itemCountPlural',
                    { count: template.items.length },
                  )}
                </p>
              </div>
              {canManage && (
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(template)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive"
                    onClick={() => setDeleteTarget(template)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {form && <TemplateEditor form={form} onClose={() => setForm(null)} />}

      {deleteTarget && (
        <DeleteTemplateDialog template={deleteTarget} onClose={() => setDeleteTarget(null)} />
      )}
    </div>
  );
}

function dueOffsetLabel(days: number, kind: 'onboarding' | 'offboarding', t: (k: string, p?: Record<string, unknown>) => string): string {
  const anchor = kind === 'onboarding' ? t('weldhr.settings.templates.anchorStart') : t('weldhr.settings.templates.anchorLastDay');
  if (days === 0) return t('weldhr.settings.templates.dueOnAnchor', { anchor });
  if (days > 0) {
    return t(days === 1 ? 'weldhr.settings.templates.dueAfterAnchor' : 'weldhr.settings.templates.dueAfterAnchorPlural', {
      count: days,
      anchor,
    });
  }
  const count = Math.abs(days);
  return t(count === 1 ? 'weldhr.settings.templates.dueBeforeAnchor' : 'weldhr.settings.templates.dueBeforeAnchorPlural', {
    count,
    anchor,
  });
}

function TemplateEditor({ form, onClose }: { form: FormState; onClose: () => void }) {
  const t = useTranslations();
  const createTemplate = useCreateHrChecklistTemplate();
  const updateTemplate = useUpdateHrChecklistTemplate();
  const [state, setState] = useState(form);
  const [failure, setFailure] = useState<string | null>(null);
  const isEdit = Boolean(state.id);
  const pending = createTemplate.isPending || updateTemplate.isPending;

  function updateItem(id: string, patch: Partial<HrChecklistTemplateItem>) {
    setState({ ...state, items: state.items.map((item) => (item.id === id ? { ...item, ...patch } : item)) });
  }

  function removeItem(id: string) {
    setState({ ...state, items: state.items.filter((item) => item.id !== id) });
  }

  function moveItem(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= state.items.length) return;
    const items = [...state.items];
    [items[index], items[target]] = [items[target]!, items[index]!];
    setState({ ...state, items });
  }

  async function submit() {
    if (!state.name.trim()) return;
    setFailure(null);
    const payload = {
      name: state.name.trim(),
      description: state.description.trim() || null,
      kind: state.kind,
      isDefault: state.isDefault,
      items: state.items.map((item) => ({ ...item, title: item.title.trim() })),
    };
    if (payload.items.some((item) => !item.title)) {
      setFailure(t('weldhr.settings.templates.itemTitleRequired'));
      return;
    }
    try {
      if (state.id) {
        await updateTemplate.mutateAsync({ id: state.id, ...payload });
      } else {
        await createTemplate.mutateAsync(payload);
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
            {isEdit ? t('weldhr.settings.templates.editTitle') : t('weldhr.settings.templates.addTitle')}
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-4 px-4 pb-4">
          <ErrorBanner error={failure} />

          <div className="space-y-1.5">
            <Label htmlFor="tpl-name">{t('weldhr.settings.templates.name')}</Label>
            <Input id="tpl-name" value={state.name} onChange={(e) => setState({ ...state, name: e.target.value })} autoFocus />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tpl-description">{t('weldhr.settings.templates.description')}</Label>
            <Textarea
              id="tpl-description"
              value={state.description}
              onChange={(e) => setState({ ...state, description: e.target.value })}
              rows={2}
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div>
              <Label htmlFor="tpl-default">{t('weldhr.settings.templates.isDefault')}</Label>
              <p className="text-xs text-muted-foreground">{t('weldhr.settings.templates.isDefaultHint')}</p>
            </div>
            <Switch
              id="tpl-default"
              checked={state.isDefault}
              onCheckedChange={(checked) => setState({ ...state, isDefault: checked })}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t('weldhr.settings.templates.items')}</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setState({ ...state, items: [...state.items, newItem()] })}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                {t('weldhr.settings.templates.addItem')}
              </Button>
            </div>

            {state.items.length === 0 && (
              <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                {t('weldhr.settings.templates.noItems')}
              </p>
            )}

            {state.items.map((item, index) => (
              <div key={item.id} className="space-y-2.5 rounded-lg border p-3">
                <div className="flex items-start gap-2">
                  <GripVertical className="mt-2.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1 space-y-2.5">
                    <Input
                      value={item.title}
                      placeholder={t('weldhr.settings.templates.itemTitlePlaceholder')}
                      onChange={(e) => updateItem(item.id, { title: e.target.value })}
                    />
                    <Textarea
                      value={item.description ?? ''}
                      placeholder={t('weldhr.settings.templates.itemDescriptionPlaceholder')}
                      onChange={(e) => updateItem(item.id, { description: e.target.value || null })}
                      rows={2}
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs">{t('weldhr.settings.templates.assigneeRole')}</Label>
                        <Select
                          value={item.assigneeRole}
                          onValueChange={(v) => updateItem(item.id, { assigneeRole: v as HrAssigneeRole })}
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ASSIGNEE_ROLES.map((role) => (
                              <SelectItem key={role} value={role}>
                                {t(`weldhr.status.assigneeRole.${role}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">{t('weldhr.settings.templates.dueOffsetDays')}</Label>
                        <Input
                          type="number"
                          className="h-8"
                          min={-365}
                          max={365}
                          value={item.dueOffsetDays}
                          onChange={(e) => updateItem(item.id, { dueOffsetDays: Number(e.target.value) || 0 })}
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">{dueOffsetLabel(item.dueOffsetDays, state.kind, t)}</p>
                    <div className="flex items-center justify-between gap-4 pt-1">
                      <div className="flex items-center gap-2">
                        <Switch
                          id={`vis-${item.id}`}
                          checked={item.visibleToEmployee}
                          onCheckedChange={(checked) => updateItem(item.id, { visibleToEmployee: checked })}
                        />
                        <Label htmlFor={`vis-${item.id}`} className="text-xs font-normal">
                          {t('weldhr.settings.templates.visibleToEmployee')}
                        </Label>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          disabled={index === 0}
                          onClick={() => moveItem(index, -1)}
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          disabled={index === state.items.length - 1}
                          onClick={() => moveItem(index, 1)}
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          onClick={() => removeItem(item.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
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
          <Button type="button" onClick={() => void submit()} disabled={pending || !state.name.trim()}>
            {pending ? t('weldhr.common.saving') : t('weldhr.common.save')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function DeleteTemplateDialog({ template, onClose }: { template: HrChecklistTemplate; onClose: () => void }) {
  const t = useTranslations();
  const deleteTemplate = useDeleteHrChecklistTemplate();
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <>
      <ConfirmDialog
        open
        onOpenChange={(open) => !open && onClose()}
        title={t('weldhr.settings.templates.deleteTitle')}
        description={t('weldhr.settings.templates.deleteDescription', { name: template.name })}
        confirmLabel={t('weldhr.common.delete')}
        cancelLabel={t('weldhr.common.cancel')}
        variant="destructive"
        onConfirm={async () => {
          try {
            await deleteTemplate.mutateAsync(template.id);
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
