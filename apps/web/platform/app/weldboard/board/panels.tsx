import { useState, useSyncExternalStore } from 'react';
import { History, MessageSquare, X } from 'lucide-react';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardVersion } from '@weldsuite/app-api-client/schemas/boards';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import { Input } from '@weldsuite/ui/components/input';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { useAppApi } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import type { Person } from '@/components/record-comments/comment-parts';
import type { BoardController } from '../editor/model/board-controller';
import { boardsQueryKey } from '../store/use-board-store';
import { CommentsPanel } from './comments-panel';
import { RecordsDialog, TasksDialog } from './records';

export type PanelKind = 'comments' | 'versions';

interface PanelState {
  open: PanelKind | null;
  /** The comment pin the panel shows first (just placed, or clicked). */
  activeComment: string | null;
  /** The records picker is open. */
  records: boolean;
  /** Elements being made tasks (the dialog is open), or null. */
  tasks: string[] | null;
}

/** Which side panel a board shows, kept outside React so the board's callbacks can open one. */
export class BoardPanels {
  private state: PanelState = { open: null, activeComment: null, records: false, tasks: null };
  private readonly listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  get = (): PanelState => this.state;

  private set(next: Partial<PanelState>) {
    this.state = { ...this.state, ...next };
    for (const fn of this.listeners) fn();
  }

  toggle(kind: PanelKind) {
    this.set({ open: this.state.open === kind ? null : kind });
  }

  focusComment(id: string) {
    this.set({ open: 'comments', activeComment: id });
  }

  close() {
    this.set({ open: null, activeComment: null });
  }

  openRecords(open = true) {
    this.set({ records: open });
  }

  openTasks(ids: string[] | null) {
    this.set({ tasks: ids });
  }
}

/** The board's right-hand panels: comments or version history. */
export function SidePanels({ controller, boardId, projectId, people, panels, canEdit }: { controller: BoardController; boardId: string; projectId: string | null; people: Person[]; panels: BoardPanels; canEdit: boolean }) {
  const state = useSyncExternalStore(panels.subscribe, panels.get);
  return (
    <>
      {state.open === 'comments' && <CommentsPanel controller={controller} boardId={boardId} people={people} panels={panels} />}
      {state.open === 'versions' && <VersionsPanel boardId={boardId} canEdit={canEdit} onClose={() => panels.close()} />}
      <RecordsDialog controller={controller} open={state.records} onOpenChange={(open) => panels.openRecords(open)} />
      <TasksDialog boardId={boardId} elementIds={state.tasks} projectId={projectId} onOpenChange={(open) => !open && panels.openTasks(null)} />
    </>
  );
}

/** Board menu items that open the panels. */
export function PanelMenuItems({ panels }: { panels: BoardPanels }) {
  const { t } = useI18n();
  const te = t.weldboard.editor;
  return (
    <>
      <DropdownMenuItem onSelect={() => panels.toggle('comments')}>
        <MessageSquare className="mr-2 size-4" />
        {te.comments.title}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => panels.toggle('versions')}>
        <History className="mr-2 size-4" />
        {te.versions.open}
      </DropdownMenuItem>
    </>
  );
}

/**
 * Version history: name the board as it is now, rename a version, restore
 * one (the board as it was is saved first, so a restore can be undone).
 */
function VersionsPanel({ boardId, canEdit, onClose }: { boardId: string; canEdit: boolean; onClose: () => void }) {
  const appApi = useAppApi();
  const queryClient = useQueryClient();
  const { t, format, language } = useI18n();
  const tv = t.weldboard.editor.versions;
  const key = [...boardsQueryKey, 'versions', boardId] as const;
  const versions = useQuery({ queryKey: key, queryFn: async () => (await appApi.boards.versions(boardId, { limit: 100 })).data });
  const [name, setName] = useState('');
  const [restoring, setRestoring] = useState<BoardVersion | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  const save = useMutation({
    mutationFn: (versionName: string) => appApi.boards.createVersion(boardId, { name: versionName }),
    onSuccess: () => {
      setName('');
      toast.success(tv.saved);
      void refresh();
    },
    onError: () => toast.error(tv.saveFailed),
  });
  const restore = useMutation({
    mutationFn: (versionId: string) => appApi.boards.restoreVersion(boardId, versionId),
    onSuccess: () => {
      toast.success(tv.restored);
      void refresh();
    },
    onError: () => toast.error(tv.restoreFailed),
  });
  const rename = async (version: BoardVersion) => {
    const next = window.prompt(tv.namePrompt, version.name ?? '')?.trim();
    if (!next || next === version.name) return;
    try {
      await appApi.boards.renameVersion(boardId, version.id, { name: next.slice(0, 255) });
      void refresh();
    } catch {
      toast.error(tv.saveFailed);
    }
  };
  const when = (iso: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

  return (
    <aside className="pointer-events-auto flex max-h-full w-80 flex-col rounded-xl border bg-background shadow-lg" aria-label={tv.title}>
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-sm font-semibold">{tv.title}</h2>
        <Button size="icon" variant="ghost" className="size-7" aria-label={t.weldboard.editor.comments.close} onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      {canEdit && (
        <form
          className="flex gap-2 border-b p-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save.mutate(name.trim().slice(0, 255));
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={tv.name} aria-label={tv.name} className="h-8" />
          <Button type="submit" size="sm" disabled={!name.trim() || save.isPending}>
            {tv.save}
          </Button>
        </form>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {versions.isLoading && (
          <div className="flex justify-center py-6">
            <InlineSpinner />
          </div>
        )}
        {versions.isError && <p className="p-2 text-sm text-destructive">{tv.loadFailed}</p>}
        {versions.data?.length === 0 && <p className="p-2 text-center text-sm text-muted-foreground">{tv.empty}</p>}
        <ul className="space-y-1">
          {versions.data?.map((v) => (
            <li key={v.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{v.name ?? tv.auto}</p>
                <p className="truncate text-xs text-muted-foreground">{when(v.createdAt)}</p>
              </div>
              {canEdit && (
                <div className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void rename(v)}>
                    {tv.rename}
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={restore.isPending} onClick={() => setRestoring(v)}>
                    {tv.restoreShort}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => !open && setRestoring(null)}
        title={tv.restoreTitle}
        description={format(tv.restoreDescriptionNamed, { name: restoring?.name ?? (restoring ? when(restoring.createdAt) : '') })}
        confirmLabel={tv.restore}
        cancelLabel={t.weldboard.editor.comments.cancel}
        onConfirm={() => {
          if (restoring) restore.mutate(restoring.id);
          setRestoring(null);
        }}
      />
    </aside>
  );
}
