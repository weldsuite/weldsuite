import { useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useCan } from '@weldsuite/permissions/react';
import { Upload } from 'lucide-react';
import { Board, applyOp, newId, placeFragment, type BuiltInTemplate } from '@weldsuite/board-engine';
import type { ImportBoardInput } from '@weldsuite/app-api-client/schemas/boards';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import type { GroupConfig } from '@/components/entity-list';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useProjects } from '@/hooks/queries/use-projects-queries';
import { useAppApi } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { BoardList } from './board-list';
import { buildTemplate, TemplatesGallery } from './editor/templates-dialog';
import { boardName, importFormat, IMPORT_ACCEPT, IMPORT_MAX_BYTES, snapshotFromFile } from './import';
import { boardsQueryKey, useBoardList, useBoardMutations, type BoardMeta } from './store/use-board-store';

type Translations = ReturnType<typeof useI18n>['t'];

const NO_BOARDS: BoardMeta[] = [];

export default function WeldBoardHome() {
  const { t } = useI18n();
  const th = t.weldboard.home;
  const preview = usePreviewMode();
  const recent = useBoardList();
  const projectBoards = useBoardList({ projects: true }, !preview);
  const { create } = useBoardMutations();
  const canCreate = useCan('boards:create');
  const open = useOpenBoard();
  const importFile = useBoardImport(open);

  const createBoard = async (template?: BuiltInTemplate) => {
    // A failure is announced by the mutation; there is nothing to open then.
    const meta = await create.mutateAsync(template ? templateBoard(template, t) : { name: th.untitled }).catch(() => null);
    if (meta) open(meta);
  };
  const createBlank = () => {
    if (!create.isPending) void createBoard();
  };

  if (recent.isLoading) return <PageLoader fullScreen={false} />;

  return (
    <div className="flex w-full flex-col">
      {canCreate && <NewBoardStrip onTemplate={(tpl) => void createBoard(tpl)} onImport={(file) => void importFile(file)} />}
      {recent.isError && !recent.data ? (
        <ErrorState message={th.loadFailed} onRetry={() => void recent.refetch()} retryLabel={th.retry} className="py-16" />
      ) : (
        <HomeBoardList boards={recent.data} projectBoards={projectBoards.data} onOpen={open} onCreate={canCreate ? createBlank : undefined} />
      )}
    </div>
  );
}

/** A built-in template as a new board's name and contents. */
function templateBoard(template: BuiltInTemplate, t: Translations) {
  const board = Board.create();
  applyOp(board, placeFragment(board, buildTemplate(template, t, () => newId()), { x: 0, y: 0, makeId: () => newId() }).op);
  const name = (t.weldboard.templates.names as Record<string, string>)[template.id] ?? t.weldboard.home.untitled;
  return { name, snapshot: board.toSnapshot() };
}

/** Opens a board: a project's in its project, otherwise in WeldBoard (or the preview). */
function useOpenBoard() {
  const navigate = useNavigate();
  const preview = usePreviewMode();
  return useCallback(
    (board: BoardMeta) => {
      if (board.projectId) void navigate({ to: '/weldflow/project/$projectId/whiteboard/$whiteboardId', params: { projectId: board.projectId, whiteboardId: board.id } });
      else if (preview) void navigate({ to: '/preview/weldboard/$boardId', params: { boardId: board.id } });
      else void navigate({ to: '/weldboard/$boardId', params: { boardId: board.id } });
    },
    [navigate, preview],
  );
}

/** Imports a picked file as a new board and opens it: board-api reads it in a workspace, the browser in the preview. */
function useBoardImport(open: (board: BoardMeta) => void) {
  const { t, format } = useI18n();
  const th = t.weldboard.home;
  const preview = usePreviewMode();
  const appApi = useAppApi();
  const queryClient = useQueryClient();
  const { create } = useBoardMutations();

  const importAs = async (file: File, kind: ImportBoardInput['format']): Promise<{ meta: BoardMeta; skipped: number }> => {
    const content = await file.text();
    if (preview) {
      const read = snapshotFromFile(kind, content);
      if (!read) throw new Error('unreadable');
      return { meta: await create.mutateAsync({ name: boardName(file.name), snapshot: read.snapshot }), skipped: read.skipped };
    }
    const { data } = await appApi.boards.import({ name: boardName(file.name), format: kind, content });
    void queryClient.invalidateQueries({ queryKey: boardsQueryKey });
    return { meta: { id: data.id, name: data.name, createdAt: Date.parse(data.createdAt), updatedAt: Date.parse(data.updatedAt), canEdit: data.canEdit }, skipped: data.skipped };
  };

  return async (file: File | undefined) => {
    if (!file) return;
    const kind = importFormat(file.name);
    if (!kind || file.size > IMPORT_MAX_BYTES) {
      toast.error(format(th.importFailed, { name: file.name }));
      return;
    }
    const pending = toast.loading(format(th.importing, { name: file.name }));
    try {
      const { meta, skipped } = await importAs(file, kind);
      toast.dismiss(pending);
      if (skipped) toast.warning(format(th.imported, { name: file.name }), { description: format(th.importSkipped, { count: skipped }) });
      else toast.success(format(th.imported, { name: file.name }));
      open(meta);
    } catch {
      toast.dismiss(pending);
      toast.error(format(th.importFailed, { name: file.name }));
    }
  };
}

/** Saves a board as a workspace template, or takes it out of the templates. */
function useToggleTemplate() {
  const { t } = useI18n();
  const th = t.weldboard.home;
  const appApi = useAppApi();
  const queryClient = useQueryClient();
  return async (board: BoardMeta) => {
    const removing = !!board.templateCategory;
    try {
      await appApi.boards.update(board.id, { template: removing ? null : { category: 'other' } });
      toast.success(removing ? th.templateRemoved : th.templateSaved);
      void queryClient.invalidateQueries({ queryKey: boardsQueryKey });
    } catch {
      toast.error(th.templateFailed);
    }
  };
}

/** The strip above the list: import a file, or start from a template. */
function NewBoardStrip({ onTemplate, onImport }: { onTemplate: (template: BuiltInTemplate) => void; onImport: (file: File | undefined) => void }) {
  const { t } = useI18n();
  const th = t.weldboard.home;
  const preview = usePreviewMode();
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <section className="border-b bg-muted/40">
      <div className="flex w-full flex-col gap-3 px-4 py-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">{th.startNew}</h2>
          <Link to={preview ? '/preview/weldboard/templates' : '/weldboard/templates'} className="text-sm text-primary hover:underline">
            {th.allTemplates}
          </Link>
        </div>
        <div className="flex gap-4 overflow-x-auto pb-1">
          <button type="button" onClick={() => fileInput.current?.click()} className="group flex w-44 shrink-0 flex-col items-stretch gap-1.5 text-left">
            <span className="flex aspect-[4/3] flex-col items-center justify-center gap-1 rounded-lg border border-dashed bg-background transition group-hover:border-primary">
              <Upload className="size-8 text-muted-foreground group-hover:text-primary" />
              <span className="text-xs text-muted-foreground">{th.importHint}</span>
            </span>
            <span className="text-sm font-medium">{th.importFile}</span>
          </button>
          <TemplatesGallery compact onPick={onTemplate} />
        </div>
        <input
          ref={fileInput}
          type="file"
          accept={IMPORT_ACCEPT}
          className="hidden"
          onChange={(e) => {
            onImport(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
    </section>
  );
}

/** The list's menu actions this member may use; a missing one hides its menu item. */
function useBoardActions(onOpen: (board: BoardMeta) => void) {
  const { t, format } = useI18n();
  const th = t.weldboard.home;
  const preview = usePreviewMode();
  const { create, rename, remove } = useBoardMutations();
  const toggleTemplate = useToggleTemplate();
  const canCreate = useCan('boards:create');
  const canUpdate = useCan('boards:update');
  const canDelete = useCan('boards:delete');
  return {
    onRename: canUpdate ? (board: BoardMeta, name: string) => rename.mutate({ id: board.id, name }) : undefined,
    onDuplicate: canCreate ? (board: BoardMeta) => void create.mutateAsync({ name: format(th.copyOf, { name: board.name }), fromBoardId: board.id }).then(onOpen, () => undefined) : undefined,
    onDelete: canDelete ? (board: BoardMeta) => remove.mutate(board.id) : undefined,
    onToggleTemplate: !preview && canUpdate ? (board: BoardMeta) => void toggleTemplate(board) : undefined,
  };
}

/** Project names by id, for the list's Project column. */
function useProjectNames() {
  const projects = useProjects({ pageSize: 100 });
  return useMemo(() => new Map((projects.data?.data ?? []).map((p) => [p.id, p.name])), [projects.data]);
}

/** The workspace's own boards first, then the project whiteboards. */
function boardGroups(th: Translations['weldboard']['home']): GroupConfig<BoardMeta>[] {
  return [
    { id: 'boards', label: th.recent, filter: (b) => !b.projectId, sortOrder: 0 },
    { id: 'projects', label: th.projectBoards, filter: (b) => !!b.projectId, sortOrder: 1 },
  ];
}

/** The workspace's boards, then the project whiteboards under their own heading (these only open from here). */
function HomeBoardList({
  boards = NO_BOARDS,
  projectBoards = NO_BOARDS,
  onOpen,
  onCreate,
}: {
  boards?: BoardMeta[];
  projectBoards?: BoardMeta[];
  onOpen: (board: BoardMeta) => void;
  onCreate?: () => void;
}) {
  const { t } = useI18n();
  const th = t.weldboard.home;
  const preview = usePreviewMode();
  const actions = useBoardActions(onOpen);
  const projectNames = useProjectNames();
  const items = useMemo(() => [...boards, ...projectBoards], [boards, projectBoards]);
  const groups = useMemo(() => boardGroups(th), [th]);
  const hasProjectBoards = projectBoards.length > 0;

  return (
    <BoardList
      boards={items}
      onOpen={onOpen}
      {...actions}
      projectName={hasProjectBoards ? (b) => projectNames.get(b.projectId ?? '') ?? null : undefined}
      groups={hasProjectBoards ? groups : undefined}
      onCreate={onCreate}
      notice={preview ? <span className="text-xs text-muted-foreground">{th.localNotice}</span> : undefined}
      emptyStateClassName="min-h-[360px] py-12"
      deletePermanently={!!preview}
    />
  );
}
