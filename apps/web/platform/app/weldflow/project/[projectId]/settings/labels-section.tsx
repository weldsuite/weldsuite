import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { toast } from 'sonner';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Label as UILabel } from '@weldsuite/ui/components/label';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Search,
  Plus,
  MoreVertical,
  Trash2,
  Check,
  X,
  Pencil,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { coloredSquareColors } from '@/components/app-sidebar-layout';
import { labelsApi } from '@/app/weldflow/lib/api-client';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';

interface ProjectLabel {
  id: string;
  name: string;
  color: string;
  usageCount?: number;
}

interface LabelsSectionProps {
  projectId: string;
  isAdmin: boolean;
}

interface DraftLabel {
  id: string;
  name: string;
  color: string;
}

const DEFAULT_COLOR = coloredSquareColors[0].value;
const VALID_COLOR_VALUES = new Set(coloredSquareColors.map((c) => c.value));

/**
 * Resolve a stored color value to either a Tailwind class or an inline background-color.
 *
 * Project labels may be stored either as Tailwind class names (created in this settings page)
 * or as hex strings (created from inline pickers like the task dialog). Render whichever applies
 * so the pill has the correct color in either case.
 */
function resolveLabelColor(color: string | null | undefined): { className?: string; style?: CSSProperties } {
  if (color && VALID_COLOR_VALUES.has(color)) {
    return { className: color };
  }
  if (color && color.startsWith('#')) {
    return { style: { backgroundColor: color } };
  }
  return { className: DEFAULT_COLOR };
}

export function LabelsSection({ projectId, isAdmin }: LabelsSectionProps) {
  const { t } = useI18n();
  const [labels, setLabels] = useState<ProjectLabel[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftLabel | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectLabel | null>(null);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState<DraftLabel>({ id: '', name: '', color: DEFAULT_COLOR });
  const [busy, setBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'color',
      label: t.projects.settings.colorFilter,
      options: coloredSquareColors.map((c) => ({ value: c.value, label: c.label })),
    },
  ], [t]);

  const load = async () => {
    setLoading(true);
    const res = await labelsApi.list(projectId);
    if (res.success && res.data) setLabels(res.data);
    else toast.error(res.error || t.projects.settings.failedToLoadLabels);
    setLoading(false);
  };

  useEffect(() => { load(); }, [projectId]);

  const startEdit = (label: ProjectLabel) => {
    setEditingId(label.id);
    setDraft({ id: label.id, name: label.name, color: label.color });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(null);
  };

  const saveEdit = async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast.error(t.projects.settings.nameRequired);
      return;
    }
    setBusy(true);
    const res = await labelsApi.update(draft.id, { name: draft.name.trim(), color: draft.color });
    setBusy(false);
    if (res.success) {
      toast.success(t.projects.settings.labelUpdated);
      cancelEdit();
      load();
    } else {
      toast.error(res.error || t.projects.settings.failedToUpdateLabel);
    }
  };

  const startAdd = () => {
    setAdding(true);
    setNewLabel({ id: '', name: '', color: DEFAULT_COLOR });
  };

  const cancelAdd = () => {
    setAdding(false);
    setNewLabel({ id: '', name: '', color: DEFAULT_COLOR });
  };

  const saveAdd = async () => {
    if (!newLabel.name.trim()) {
      toast.error(t.projects.settings.nameRequired);
      return;
    }
    setBusy(true);
    const res = await labelsApi.create({ name: newLabel.name.trim(), color: newLabel.color, projectId });
    setBusy(false);
    if (res.success) {
      toast.success(t.projects.settings.labelCreated);
      cancelAdd();
      load();
    } else {
      toast.error(res.error || t.projects.settings.failedToCreateLabel);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    const res = await labelsApi.delete(deleteTarget.id);
    setBusy(false);
    if (res.success) {
      toast.success(t.projects.settings.labelDeleted);
      setDeleteTarget(null);
      load();
    } else {
      toast.error(res.error || t.projects.settings.failedToDeleteLabel);
    }
  };

  const filteredLabels = useMemo(() => {
    // Drop malformed rows (empty name) that would render as blank lines.
    let result = labels.filter((l) => l.name && l.name.trim().length > 0);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(l => l.name.toLowerCase().includes(q));
    }
    if (activeFilters.length > 0) {
      result = result.filter(l =>
        activeFilters.every(f => {
          if (!f.value) return true;
          if (f.field === 'color') {
            const match = l.color === f.value;
            return f.operator === 'is not' ? !match : match;
          }
          return true;
        })
      );
    }
    return result;
  }, [labels, searchQuery, activeFilters]);

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-end mb-4 gap-2">
        <FilterPills
          filters={activeFilters}
          filterConfigs={filterConfigs}
          maxFilters={3}
          onFiltersChange={setActiveFilters}
        />
        <div className="flex-1" />
        <div className="relative flex items-center">
          <div className={cn(
            'flex items-center transition-all duration-200 ease-out',
            searchOpen ? 'w-48' : 'w-8',
          )}>
            <Button
              variant="outline"
              size="sm"
              className={cn(
                'h-8 w-8 p-0 flex-shrink-0 shadow-none transition-opacity duration-200',
                searchOpen && 'opacity-0 pointer-events-none absolute',
              )}
              onClick={() => {
                setSearchOpen(true);
                setTimeout(() => searchInputRef.current?.focus(), 50);
              }}
            >
              <Search className="h-4 w-4" />
            </Button>
            <div className={cn(
              'relative transition-all duration-200 ease-out',
              searchOpen ? 'opacity-100 w-48' : 'opacity-0 w-0 pointer-events-none',
            )}>
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder={t.projects.settings.searchLabelsPlaceholder}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onBlur={() => { if (!searchQuery) setSearchOpen(false); }}
                className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
              />
            </div>
          </div>
        </div>
        {isAdmin && (
          <Button
            onClick={startAdd}
            className="h-8 text-sm px-3 flex items-center gap-2 shadow-none"
          >
            <Plus className="h-4 w-4" />
            {t.projects.settings.addLabelBtn}
          </Button>
        )}
      </div>

      <div className="rounded-md border border-border/70 overflow-hidden">
        <Table>
          <TableHeader className="[&_tr]:border-border/70">
            <TableRow>
              <TableHead>{t.projects.settings.columnLabel}</TableHead>
              <TableHead className="w-32">{t.projects.settings.columnUsage}</TableHead>
              <TableHead className="w-12"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_tr]:border-border/70">
            {loading ? (
              <TableRow>
                <TableCell colSpan={3} className="p-0">
                  <PageLoader fullScreen={false} />
                </TableCell>
              </TableRow>
            ) : (
              <>
                {filteredLabels.map((label) => {
                  const editing = editingId === label.id;
                  if (editing && draft) {
                    return (
                      <LabelEditRow
                        key={label.id}
                        draft={draft}
                        setDraft={setDraft as any}
                        onSave={saveEdit}
                        onCancel={cancelEdit}
                        busy={busy}
                      />
                    );
                  }
                  const labelColor = resolveLabelColor(label.color);
                  return (
                    <TableRow key={label.id} className="group h-[46px] hover:bg-muted/50">
                      <TableCell className="py-1.5">
                        <span
                          className={cn(
                            'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none text-white',
                            labelColor.className,
                          )}
                          style={labelColor.style}
                        >
                          {label.name}
                        </span>
                      </TableCell>
                      <TableCell className="py-1.5 font-mono tabular-nums text-sm text-muted-foreground">
                        {label.usageCount ?? 0}
                      </TableCell>
                      <TableCell className="py-1.5">
                        <div className="h-8 w-8 flex items-center justify-center">
                          {isAdmin && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 rounded-lg opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                                >
                                  <MoreVertical className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-40">
                                <DropdownMenuItem onClick={() => startEdit(label)}>
                                  <Pencil className="h-4 w-4 mr-0.5" />
                                  {t.projects.settings.editMenuItem}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => setDeleteTarget(label)}
                                >
                                  <Trash2 className="h-4 w-4 mr-0.5" />
                                  {t.projects.settings.deleteMenuItem}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {filteredLabels.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center py-12 text-muted-foreground">
                      {t.projects.settings.noLabelsFound}
                    </TableCell>
                  </TableRow>
                )}
              </>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={adding} onOpenChange={(o) => !o && cancelAdd()}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t.projects.settings.createLabelTitle}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 pt-2 pb-4">
            <div className="grid gap-2">
              <UILabel htmlFor="label-name" className="text-[13px]">{t.projects.settings.labelNameLabel}</UILabel>
              <div className="flex items-center gap-2">
                <LabelColorSwatch
                  color={newLabel.color}
                  onChange={(c) => setNewLabel({ ...newLabel, color: c })}
                />
                <Input
                  id="label-name"
                  value={newLabel.name}
                  onChange={(e) => setNewLabel({ ...newLabel, name: e.target.value })}
                  placeholder={t.projects.settings.labelNamePlaceholder}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newLabel.name.trim()) saveAdd();
                  }}
                  className="h-9 flex-1 focus-visible:ring-0 focus-visible:ring-offset-0"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={cancelAdd}>
              {t.projects.settings.cancelBtn}
            </Button>
            <Button onClick={saveAdd} disabled={busy || !newLabel.name.trim()}>
              {t.projects.settings.createLabelBtn}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={t.projects.settings.deleteLabelTitle}
        description={t.projects.settings.deleteLabelDesc.replace('{name}', deleteTarget?.name ?? '')}
        variant="destructive"
        confirmLabel={t.projects.settings.deleteBtn}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

interface LabelEditRowProps {
  isNew?: boolean;
  draft: DraftLabel;
  setDraft: (next: DraftLabel) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}

function LabelEditRow({ isNew, draft, setDraft, onSave, onCancel, busy }: LabelEditRowProps) {
  const { t } = useI18n();
  const [colorOpen, setColorOpen] = useState(false);
  const draftColor = resolveLabelColor(draft.color);
  return (
    <TableRow className="h-[46px] bg-muted/30">
      <TableCell className="py-1.5">
        <div className="flex items-center gap-2">
          <Popover open={colorOpen} onOpenChange={setColorOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className={cn('w-5 h-5 rounded shrink-0 ring-1 ring-border p-0', draftColor.className)}
                style={draftColor.style}
                aria-label="Pick color"
              />
            </PopoverTrigger>
            <PopoverContent className="w-auto p-1" align="start">
              <div className="grid grid-cols-4 gap-1">
                {coloredSquareColors.map((c) => (
                  <Button
                    key={c.value}
                    type="button"
                    variant="ghost"
                    className={cn(
                      'w-8 h-8 rounded-md transition-transform hover:scale-110',
                      c.value,
                      draft.color === c.value && 'ring-2 ring-offset-2 ring-primary',
                    )}
                    onClick={() => { setDraft({ ...draft, color: c.value }); setColorOpen(false); }}
                    title={c.label}
                  />
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder={isNew ? t.projects.settings.newLabelPlaceholder : t.projects.settings.labelNameEditPlaceholder}
            autoFocus
            className="h-8 max-w-xs focus-visible:ring-0 focus-visible:ring-offset-0"
          />
        </div>
      </TableCell>
      <TableCell className="py-1.5" />
      <TableCell className="py-1.5">
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" onClick={onSave} disabled={busy} className="h-8">
            <Check className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy} className="h-8 w-8 p-0">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function LabelColorSwatch({
  color,
  onChange,
}: {
  color: string;
  onChange: (c: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const swatch = resolveLabelColor(color);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="w-9 h-9 rounded-md flex-shrink-0 border border-input p-1.5"
          aria-label="Pick color"
        >
          <div className={cn('w-full h-full rounded', swatch.className)} style={swatch.style} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-2" align="start">
        <div className="grid grid-cols-6 gap-1.5">
          {coloredSquareColors.map((c) => (
            <Button
              key={c.value}
              type="button"
              variant="ghost"
              onClick={() => { onChange(c.value); setOpen(false); }}
              title={c.label}
              className={cn(
                'w-6 h-6 rounded relative transition-all hover:scale-110 p-0',
                c.value,
                color === c.value && 'ring-2 ring-offset-1 ring-foreground',
              )}
            >
              {color === c.value && <Check className="absolute inset-0 m-auto h-3 w-3 text-white" />}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
