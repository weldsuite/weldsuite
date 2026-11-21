import { useEffect, useState, useSyncExternalStore } from 'react';
import { History, MessageSquare, MoreHorizontal, X } from 'lucide-react';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardVersion } from '@weldsuite/app-api-client/schemas/boards';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { Input } from '@weldsuite/ui/components/input';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { PromptDialog } from '@weldsuite/ui/components/prompt-dialog';
import { useAppApi } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import type { Person } from '@/components/record-comments/comment-parts';
import type { BoardController } from '../editor/model/board-controller';
import { SIDE_PANEL, SIDE_PANEL_HEADER } from '../editor/ui';
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

  /** Opens a panel (leaves it open when it already is). */
  show(kind: PanelKind) {
    if (this.state.open !== kind) this.set({ open: kind });
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

/**
 * Picking the comment tool (its button or C) opens the comments panel, so
 * the conversations are there beside the pins. Returns the unsubscribe.
 */
export function openCommentsWithTool(controller: BoardController, panels: BoardPanels): () => void {
  let last = controller.tool;
  return controller.onRender(() => {
    const tool = controller.tool;
    if (tool === 'comment' && last !== 'comment') panels.show('comments');
    last = tool;
  });
}

/** The board's right-hand panels: comments or version history. */
export function SidePanels({ controller, boardId, projectId, people, panels, canEdit }: { controller: BoardController; boardId: string; projectId: string | null; people: Person[]; panels: BoardPanels; canEdit: boolean }) {
  const state = useSyncExternalStore(panels.subscribe, panels.get);
  useEffect(() => openCommentsWithTool(controller, panels), [controller, panels]);
  return (
    <>
      {state.open === 'comments' && <CommentsPanel controller={controller} boardId={boardId} people={people} panels={panels} />}
      {state.open === 'versions' && <VersionsPanel boardId={boardId} canEdit={canEdit} people={people} onClose={() => panels.close()} />}
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
        <MessageSquare className="size-4" />
        {te.comments.title}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => panels.toggle('versions')}>
        <History className="size-4" />
        {te.versions.open}
      </DropdownMenuItem>
    </>
  );
}

/**
 * Version history: name the board as it is now, rename a version, restore
 * one (the board as it was is saved first, so a restore can be undone).
 */
function VersionsPanel({ boardId, canEdit, people, onClose }: { boardId: string; canEdit: boolean; people: Person[]; onClose: () => void }) {
  const appApi = useAppApi();
  const queryClient = useQueryClient();
  const { t, format, language } = useI18n();
  const tv = t.weldboard.editor.versions;
  const key = [...boardsQueryKey, 'versions', boardId] as const;
  const versions = useQuery({ queryKey: key, queryFn: async () => (await appApi.boards.versions(boardId, { limit: 100 })).data });
  const [name, setName] = useState('');
  const [restoring, setRestoring] = useState<BoardVersion | null>(null);
  const [renaming, setRenaming] = useState<BoardVersion | null>(null);
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
  const rename = async (version: BoardVersion, next: string) => {
    if (next === version.name) return;
    try {
      await appApi.boards.renameVersion(boardId, version.id, { name: next.slice(0, 255) });
      void refresh();
    } catch {
      toast.error(tv.saveFailed);
    }
  };
  const when = (iso: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  /** Who saved a version (an automatic one has nobody). */
  const author = (v: { createdById: string | null }) => (v.createdById ? people.find((p) => p.id === v.createdById)?.name : undefined);

  return (
    <aside className={SIDE_PANEL} aria-label={tv.title}>
      <div className={SIDE_PANEL_HEADER}>
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
            // The whole name (two lines at most), when and by whom; its actions in a menu, always there.
            <li key={v.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60">
              <div className="min-w-0 flex-1">
                <p className={cn('line-clamp-2 break-words text-sm font-medium', !v.name && 'italic text-muted-foreground')}>{v.name ?? tv.auto}</p>
                <p className="truncate text-xs text-muted-foreground">{[when(v.createdAt), author(v)].filter(Boolean).join(' · ')}</p>
              </div>
              {canEdit && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label={format(tv.actionsFor, { name: v.name ?? tv.auto })}>
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setRenaming(v)}>{tv.rename}</DropdownMenuItem>
                    <DropdownMenuItem disabled={restore.isPending} onSelect={() => setRestoring(v)}>
                      {tv.restore}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </li>
          ))}
        </ul>
      </div>
      <PromptDialog
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
        title={tv.rename}
        label={tv.namePrompt}
        defaultValue={renaming?.name ?? ''}
        confirmLabel={tv.save}
        cancelLabel={t.weldboard.editor.comments.cancel}
        onConfirm={(next) => (renaming ? rename(renaming, next) : undefined)}
      />
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
