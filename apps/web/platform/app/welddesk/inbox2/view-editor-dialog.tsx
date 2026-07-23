import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  useCreateDeskView,
  useUpdateDeskView,
  type DeskView,
  type DeskViewFilterCondition,
  type DeskViewSort,
} from '@/hooks/queries/use-desk-queries';

/** Fields the v1 filter builder can target — mirrors viewFilterToQuery's SUPPORTED_FIELDS. */
const FILTER_FIELDS = [
  'state',
  'channel',
  'adminAssigneeId',
  'teamAssigneeId',
  'priority',
  'tag',
  'isTicket',
] as const;
type FilterField = (typeof FILTER_FIELDS)[number];

interface ConditionRow {
  key: string;
  field: FilterField;
  value: string;
}

function conditionsFromView(view: DeskView | null): ConditionRow[] {
  if (!view) return [];
  return view.filters.groups
    .map((group) => group.conditions[0])
    .filter((c): c is DeskViewFilterCondition => !!c && FILTER_FIELDS.includes(c.field as FilterField))
    .map((c, i) => ({ key: `${i}-${c.field}`, field: c.field as FilterField, value: String(c.value ?? '') }));
}

interface ViewEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing an existing view; omit to create a new one. */
  editingView?: DeskView | null;
}

/**
 * Create/edit a saved inbox view. Builds the DeskViewFilter AND-of-OR-groups
 * shape with one OR-group (single `eq` condition) per chosen field — the v1
 * scope agreed in .claude/welddesk-intercom-plan.md Phase 2. See
 * view-filter-to-query.ts for the inverse (view -> flat query params) used
 * when a view is applied to the conversation list.
 */
export function ViewEditorDialog({ open, onOpenChange, editingView }: ViewEditorDialogProps) {
  const t = getTranslations('deskInbox2');
  const isEditing = !!editingView;
  const createView = useCreateDeskView();
  const updateView = useUpdateDeskView();

  const [name, setName] = useState(editingView?.name ?? '');
  const [icon, setIcon] = useState(editingView?.icon ?? '');
  const [folder, setFolder] = useState(editingView?.folder ?? '');
  const [shared, setShared] = useState(editingView?.shared ?? false);
  const [sort, setSort] = useState<DeskViewSort>(editingView?.sort ?? 'newest');
  const [conditions, setConditions] = useState<ConditionRow[]>(() => conditionsFromView(editingView ?? null));

  useEffect(() => {
    if (!open) return;
    setName(editingView?.name ?? '');
    setIcon(editingView?.icon ?? '');
    setFolder(editingView?.folder ?? '');
    setShared(editingView?.shared ?? false);
    setSort(editingView?.sort ?? 'newest');
    setConditions(conditionsFromView(editingView ?? null));
  }, [open, editingView]);

  const isSaving = createView.isPending || updateView.isPending;

  const addCondition = () => {
    setConditions((prev) => [...prev, { key: `new-${Date.now()}`, field: 'state', value: '' }]);
  };

  const updateCondition = (key: string, patch: Partial<ConditionRow>) => {
    setConditions((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  };

  const removeCondition = (key: string) => {
    setConditions((prev) => prev.filter((c) => c.key !== key));
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    const filters = {
      groups: conditions
        .filter((c) => c.value.trim() !== '')
        .map((c) => ({
          conditions: [{ field: c.field, operator: 'eq' as const, value: c.value }],
        })),
    };
    const payload = {
      name: name.trim(),
      icon: icon.trim() || undefined,
      folder: folder.trim() || undefined,
      filters,
      sort,
      shared,
    };
    try {
      if (isEditing && editingView) {
        await updateView.mutateAsync({ id: editingView.id, data: payload });
        toast.success(t.viewEditor.updateSuccess);
      } else {
        await createView.mutateAsync(payload);
        toast.success(t.viewEditor.createSuccess);
      }
      onOpenChange(false);
    } catch {
      toast.error(isEditing ? t.viewEditor.updateError : t.viewEditor.createError);
    }
  };

  const fieldLabel = (field: FilterField) => {
    switch (field) {
      case 'state':
        return t.viewEditor.fieldState;
      case 'channel':
        return t.viewEditor.fieldChannel;
      case 'adminAssigneeId':
        return t.viewEditor.fieldAdminAssignee;
      case 'teamAssigneeId':
        return t.viewEditor.fieldTeamAssignee;
      case 'priority':
        return t.viewEditor.fieldPriority;
      case 'tag':
        return t.viewEditor.fieldTag;
      case 'isTicket':
        return t.viewEditor.fieldIsTicket;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? t.viewEditor.editTitle : t.viewEditor.createTitle}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex gap-3">
            <div className="flex-1 flex flex-col gap-1.5">
              <Label htmlFor="desk-view-name">{t.viewEditor.nameLabel}</Label>
              <Input
                id="desk-view-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t.viewEditor.namePlaceholder}
              />
            </div>
            <div className="w-20 flex flex-col gap-1.5">
              <Label htmlFor="desk-view-icon">{t.viewEditor.iconLabel}</Label>
              <Input
                id="desk-view-icon"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder={t.viewEditor.iconPlaceholder}
                maxLength={4}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="desk-view-folder">{t.viewEditor.folderLabel}</Label>
            <Input
              id="desk-view-folder"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder={t.viewEditor.folderPlaceholder}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t.viewEditor.sortLabel}</Label>
            <Select value={sort} onValueChange={(v) => setSort(v as DeskViewSort)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">{t.sort.newest}</SelectItem>
                <SelectItem value="oldest">{t.sort.oldest}</SelectItem>
                <SelectItem value="waiting_longest">{t.sort.waitingLongest}</SelectItem>
                <SelectItem value="priority_first">{t.sort.priorityFirst}</SelectItem>
                <SelectItem value="next_sla_target">{t.sort.nextSlaTarget}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="desk-view-shared">{t.viewEditor.sharedLabel}</Label>
            <Switch id="desk-view-shared" checked={shared} onCheckedChange={setShared} />
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label>{t.viewEditor.filtersLabel}</Label>
              <Button type="button" variant="ghost" size="sm" onClick={addCondition}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                {t.viewEditor.addFilter}
              </Button>
            </div>
            {conditions.map((condition) => (
              <div key={condition.key} className="flex items-center gap-2">
                <Select
                  value={condition.field}
                  onValueChange={(value) => updateCondition(condition.key, { field: value as FilterField })}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FILTER_FIELDS.map((field) => (
                      <SelectItem key={field} value={field}>
                        {fieldLabel(field)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={condition.value}
                  onChange={(e) => updateCondition(condition.key, { value: e.target.value })}
                  placeholder={t.viewEditor.valueLabel}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeCondition(condition.key)}
                  aria-label={t.viewEditor.removeFilter}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t.viewEditor.cancel}
          </Button>
          <Button type="button" onClick={handleSave} disabled={isSaving || !name.trim()}>
            {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t.viewEditor.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
