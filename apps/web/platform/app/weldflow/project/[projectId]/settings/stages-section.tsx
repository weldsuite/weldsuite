import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { toast } from 'sonner';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label as UILabel } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Plus,
  Trash2,
  Check,
  MoreVertical,
  Pencil,
  Search,
} from 'lucide-react';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import { cn } from '@/lib/utils';
import { stagesApi } from '@/app/weldflow/lib/api-client';

interface Stage {
  id: string;
  name: string;
  color: string;
  position: number;
  systemStatus: string;
  usageCount?: number;
}

interface StagesSectionProps {
  projectId: string;
  isAdmin: boolean;
}

// SYSTEM_STATUSES labels are built inside the component using t

const STAGE_COLORS = [
  '#3b82f6', '#a855f7', '#ec4899', '#ef4444', '#f97316', '#eab308',
  '#22c55e', '#14b8a6', '#06b6d4', '#6366f1', '#94a3b8', '#d946ef',
];

const DEFAULT_COLOR = STAGE_COLORS[0];

// Visual badge styling per system status — kept identical to `statusConfig` in
// apps/web/platform/app/weldflow/project/[projectId]/tasks/tasks-client.tsx so the badge
// here in settings matches what shows up in the task rows.
const SYSTEM_STATUS_BADGE: Record<string, { color: string; bg: string }> = {
  backlog: { color: 'text-slate-600 dark:text-slate-400', bg: 'bg-slate-100 dark:bg-slate-900/50' },
  todo: { color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  in_progress: { color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
  review: { color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950' },
  in_review: { color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950' },
  testing: { color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-50 dark:bg-purple-950' },
  done: { color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950' },
  cancelled: { color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950' },
};
const DEFAULT_BADGE = SYSTEM_STATUS_BADGE.todo;

export function StagesSection({ projectId, isAdmin }: StagesSectionProps) {
  const { t } = useI18n();

  const SYSTEM_STATUSES = useMemo(() => [
    { value: 'backlog', label: t.projects.settings.backlogStatus },
    { value: 'todo', label: t.projects.settings.todoStatus },
    { value: 'in_progress', label: t.projects.settings.inProgressStatus },
    { value: 'review', label: t.projects.settings.reviewStatus },
    { value: 'done', label: t.projects.settings.doneStatus },
    { value: 'cancelled', label: t.projects.settings.cancelledStatus },
  ], [t]);

  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editingStage, setEditingStage] = useState<Stage | null>(null);
  const [deletingStage, setDeletingStage] = useState<Stage | null>(null);
  const [reassignTargetId, setReassignTargetId] = useState<string>('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(DEFAULT_COLOR);
  const [newSystemStatus, setNewSystemStatus] = useState('in_progress');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'systemStatus',
      label: t.projects.settings.countsAsFilter,
      options: SYSTEM_STATUSES.map((s) => ({ value: s.value, label: s.label })),
    },
  ], [t, SYSTEM_STATUSES]);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await stagesApi.list(projectId);
    if (res.success && res.data) {
      // The wire response includes `usageCount` (computed server-side) even
      // though the shared `ApiPipelineStage` client type doesn't declare it.
      const sorted: Stage[] = res.data
        .map((s): Stage => ({
          id: s.id,
          name: s.name,
          color: s.color || DEFAULT_COLOR,
          position: s.position ?? 0,
          systemStatus: s.systemStatus || 'todo',
          usageCount: (s as typeof s & { usageCount?: number }).usageCount,
        }))
        .sort((a, b) => a.position - b.position);
      setStages(sorted);
    } else {
      toast.error(res.error || t.projects.settings.failedToLoadStages);
    }
    setLoading(false);
    // `t` intentionally excluded — keeping `load` stable per-projectId avoids
    // re-fetching stages on every locale switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const startAdd = () => {
    setAdding(true);
    setNewName('');
    setNewColor(DEFAULT_COLOR);
    setNewSystemStatus('in_progress');
  };

  const cancelAdd = () => setAdding(false);

  const saveAdd = async () => {
    if (!newName.trim()) {
      toast.error(t.projects.settings.stageNameRequired);
      return;
    }
    setBusy(true);
    const res = await stagesApi.create(projectId, {
      name: newName.trim(),
      color: newColor,
      systemStatus: newSystemStatus,
    });
    setBusy(false);
    if (res.success) {
      toast.success(t.projects.settings.statusAdded);
      cancelAdd();
      load();
    } else {
      toast.error(res.error || t.projects.settings.failedToAddStatus);
    }
  };

  const saveEdit = async () => {
    if (!editingStage) return;
    if (!editingStage.name.trim()) {
      toast.error(t.projects.settings.stageNameRequired);
      return;
    }
    setBusy(true);
    const res = await stagesApi.update(projectId, editingStage.id, {
      name: editingStage.name.trim(),
      color: editingStage.color,
      systemStatus: editingStage.systemStatus,
    });
    setBusy(false);
    if (res.success) {
      toast.success(t.projects.settings.statusUpdated);
      setEditingStage(null);
      load();
    } else {
      toast.error(res.error || t.projects.settings.failedToUpdateStatus);
    }
  };

  const confirmDelete = async () => {
    if (!deletingStage) return;
    setBusy(true);
    const res = await stagesApi.delete(projectId, deletingStage.id, reassignTargetId || undefined);
    setBusy(false);
    if (res.success) {
      toast.success(t.projects.settings.statusDeleted);
      setDeletingStage(null);
      setReassignTargetId('');
      load();
    } else {
      toast.error(res.error || t.projects.settings.failedToDeleteStatus);
    }
  };

  const filteredStages = useMemo(() => {
    let result = stages;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((s) => s.name.toLowerCase().includes(q));
    }
    if (activeFilters.length > 0) {
      result = result.filter((s) =>
        activeFilters.every((f) => {
          if (!f.value) return true;
          if (f.field === 'systemStatus') {
            const match = s.systemStatus === f.value;
            return f.operator === 'is not' ? !match : match;
          }
          return true;
        }),
      );
    }
    return result;
  }, [stages, searchQuery, activeFilters]);

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
                placeholder={t.projects.settings.searchStatusesPlaceholder}
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
            {t.projects.settings.addStatusBtn}
          </Button>
        )}
      </div>

      <div className="rounded-md border border-border/70 overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-[1fr_160px_128px_48px] items-center h-10 px-3 border-b border-border/70 text-sm font-medium">
          <div>{t.projects.settings.columnStatus}</div>
          <div>{t.projects.settings.columnCountsAs}</div>
          <div>{t.projects.settings.columnUsage}</div>
          <div />
        </div>

        {/* Body */}
        {loading ? (
          <PageLoader fullScreen={false} />
        ) : filteredStages.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground text-sm">
            {stages.length === 0 ? t.projects.settings.noStatusesYet : t.projects.settings.noStatusesMatch}
          </div>
        ) : (
          <div className="divide-y divide-border/70">
            {filteredStages.map((stage) => (
              <StageRow
                key={stage.id}
                stage={stage}
                isAdmin={isAdmin}
                onEdit={() => setEditingStage(stage)}
                onDelete={() => { setDeletingStage(stage); setReassignTargetId(''); }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add dialog */}
      <Dialog open={adding} onOpenChange={(o) => !o && cancelAdd()}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t.projects.settings.createStatusTitle}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 pt-2 pb-4">
            <div className="grid gap-2">
              <UILabel className="text-[13px]">{t.projects.settings.stageNameLabel}</UILabel>
              <div className="flex items-center gap-2">
                <ColorSwatch color={newColor} onChange={setNewColor} />
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t.projects.settings.stageNamePlaceholder}
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) saveAdd(); }}
                  className="h-9 flex-1 focus-visible:ring-0 focus-visible:ring-offset-0"
                />
              </div>
            </div>
            <div className="grid gap-2">
              <UILabel className="text-[13px]">{t.projects.settings.countsAsLabel}</UILabel>
              <Select value={newSystemStatus} onValueChange={setNewSystemStatus}>
                <SelectTrigger className="h-9 focus:ring-0 focus:ring-offset-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SYSTEM_STATUSES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={cancelAdd} disabled={busy}>{t.projects.settings.cancelBtn}</Button>
            <Button onClick={saveAdd} disabled={busy || !newName.trim()}>{t.projects.settings.createStatusBtn}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editingStage} onOpenChange={(o) => !o && setEditingStage(null)}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t.projects.settings.editStatusTitle}</DialogTitle>
          </DialogHeader>
          {editingStage && (
            <div className="grid gap-4 pt-2 pb-4">
              <div className="grid gap-2">
                <UILabel className="text-[13px]">{t.projects.settings.stageNameLabel}</UILabel>
                <div className="flex items-center gap-2">
                  <ColorSwatch
                    color={editingStage.color || DEFAULT_COLOR}
                    onChange={(c) => setEditingStage({ ...editingStage, color: c })}
                  />
                  <Input
                    value={editingStage.name}
                    onChange={(e) => setEditingStage({ ...editingStage, name: e.target.value })}
                    className="h-9 flex-1 focus-visible:ring-0 focus-visible:ring-offset-0"
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <UILabel className="text-[13px]">{t.projects.settings.countsAsLabel}</UILabel>
                <Select
                  value={editingStage.systemStatus}
                  onValueChange={(v) => setEditingStage({ ...editingStage, systemStatus: v })}
                >
                  <SelectTrigger className="h-9 focus:ring-0 focus:ring-offset-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SYSTEM_STATUSES.map((s) => (
                      <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingStage(null)} disabled={busy}>{t.projects.settings.cancelBtn}</Button>
            <Button onClick={saveEdit} disabled={busy}>{t.projects.settings.saveBtn}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete dialog with reassignment */}
      <Dialog open={!!deletingStage} onOpenChange={(o) => !o && setDeletingStage(null)}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t.projects.settings.deleteStatusTitle}</DialogTitle>
            <DialogDescription>
              {t.projects.settings.deleteStatusDesc.replace('{name}', deletingStage?.name ?? '')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <UILabel className="text-xs text-muted-foreground">{t.projects.settings.moveTasksToLabel}</UILabel>
            <Select value={reassignTargetId} onValueChange={setReassignTargetId}>
              <SelectTrigger className="h-9 focus:ring-0 focus:ring-offset-0">
                <SelectValue placeholder={t.projects.settings.leaveTasksUnassigned} />
              </SelectTrigger>
              <SelectContent>
                {stages
                  .filter((s) => s.id !== deletingStage?.id)
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingStage(null)} disabled={busy}>{t.projects.settings.cancelBtn}</Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={busy}>{t.projects.settings.deleteStatusBtn}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StageRow({
  stage,
  isAdmin,
  onEdit,
  onDelete,
}: {
  stage: Stage;
  isAdmin: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const SYSTEM_STATUS_LABELS: Record<string, string> = {
    backlog: t.projects.settings.backlogStatus,
    todo: t.projects.settings.todoStatus,
    in_progress: t.projects.settings.inProgressStatus,
    review: t.projects.settings.reviewStatus,
    done: t.projects.settings.doneStatus,
    cancelled: t.projects.settings.cancelledStatus,
  };
  const systemLabel = SYSTEM_STATUS_LABELS[stage.systemStatus] ?? stage.systemStatus;

  const badge = SYSTEM_STATUS_BADGE[stage.systemStatus] ?? DEFAULT_BADGE;
  return (
    <div className="group grid grid-cols-[1fr_160px_128px_48px] items-center h-[46px] px-3 hover:bg-muted/50 bg-background">
      <div>
        <span
          className={cn(
            'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none',
            badge.color,
            badge.bg,
          )}
        >
          {stage.name}
        </span>
      </div>
      <div className="text-sm text-muted-foreground">{systemLabel}</div>
      <div className="font-mono tabular-nums text-sm text-muted-foreground">
        {stage.usageCount ?? 0}
      </div>
      <div className="flex items-center justify-center">
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
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="h-4 w-4 mr-0.5" />
                {t.projects.settings.editStageMenuItem}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 className="h-4 w-4 mr-0.5" />
                {t.projects.settings.deleteStageMenuItem}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

function ColorSwatch({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="w-9 h-9 rounded-md flex-shrink-0 border border-input p-1.5"
          aria-label="Pick color"
        >
          <div className="w-full h-full rounded" style={{ backgroundColor: color }} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-2" align="start">
        <div className="grid grid-cols-6 gap-1.5">
          {STAGE_COLORS.map((c) => (
            <Button
              key={c}
              type="button"
              variant="ghost"
              onClick={() => { onChange(c); setOpen(false); }}
              className={cn(
                'w-6 h-6 rounded relative transition-all hover:scale-110 p-0',
                color === c && 'ring-2 ring-offset-1 ring-foreground',
              )}
              style={{ backgroundColor: c }}
            >
              {color === c && <Check className="absolute inset-0 m-auto h-3 w-3 text-white" />}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
