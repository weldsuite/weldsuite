import { useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useCan } from '@weldsuite/permissions/react';
import { Upload } from 'lucide-react';
import { Board, applyOp, newId, placeFragment, type BuiltInTemplate } from '@weldsuite/board-engine';
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

export default function WeldBoardHome() {
  const { t, format } = useI18n();
  const th = t.weldboard.home;
  const navigate = useNavigate();
  const preview = usePreviewMode();
  const appApi = useAppApi();
  const queryClient = useQueryClient();
  const recent = useBoardList();
  const projectBoards = useBoardList({ projects: true }, !preview);
  const projects = useProjects({ pageSize: 100 });
  const { create, rename, remove } = useBoardMutations();
  const fileInput = useRef<HTMLInputElement>(null);
  const canCreate = useCan('boards:create');
  const canUpdate = useCan('boards:update');
  const canDelete = useCan('boards:delete');

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const p of projects.data?.data ?? []) names.set(p.id, p.name);
    return names;
  }, [projects.data]);

  const open = (board: BoardMeta) => {
    if (board.projectId) void navigate({ to: '/weldflow/project/$projectId/whiteboard/$whiteboardId', params: { projectId: board.projectId, whiteboardId: board.id } });
    else if (preview) void navigate({ to: '/preview/weldboard/$boardId', params: { boardId: board.id } });
    else void navigate({ to: '/weldboard/$boardId', params: { boardId: board.id } });
  };

  const createBoard = async (template?: BuiltInTemplate) => {
    let snapshot;
    if (template) {
      const board = Board.create();
      applyOp(board, placeFragment(board, buildTemplate(template, t, () => newId()), { x: 0, y: 0, makeId: () => newId() }).op);
      snapshot = board.toSnapshot();
    }
    const name = template ? ((t.weldboard.templates.names as Record<string, string>)[template.id] ?? th.untitled) : th.untitled;
    // A failure is announced by the mutation; there is nothing to open then.
    const meta = await create.mutateAsync({ name, snapshot }).catch(() => null);
    if (meta) open(meta);
  };

  const importPicked = async (file: File | undefined) => {
    if (!file) return;
    const kind = importFormat(file.name);
    if (!kind || file.size > IMPORT_MAX_BYTES) {
      toast.error(format(th.importFailed, { name: file.name }));
      return;
    }
    const pending = toast.loading(format(th.importing, { name: file.name }));
    try {
      const content = await file.text();
      let meta: BoardMeta;
      let skipped = 0;
      if (preview) {
        const read = snapshotFromFile(kind, content);
        if (!read) throw new Error('unreadable');
        skipped = read.skipped;
        meta = await create.mutateAsync({ name: boardName(file.name), snapshot: read.snapshot });
      } else {
        const { data } = await appApi.boards.import({ name: boardName(file.name), format: kind, content });
        skipped = data.skipped;
        meta = { id: data.id, name: data.name, createdAt: Date.parse(data.createdAt), updatedAt: Date.parse(data.updatedAt), canEdit: data.canEdit };
        void queryClient.invalidateQueries({ queryKey: boardsQueryKey });
      }
      toast.dismiss(pending);
      if (skipped) toast.warning(format(th.imported, { name: file.name }), { description: format(th.importSkipped, { count: skipped }) });
      else toast.success(format(th.imported, { name: file.name }));
      open(meta);
    } catch {
      toast.dismiss(pending);
      toast.error(format(th.importFailed, { name: file.name }));
    }
  };

  const toggleTemplate = async (board: BoardMeta) => {
    try {
      await appApi.boards.update(board.id, { template: board.templateCategory ? null : { category: 'other' } });
      toast.success(board.templateCategory ? th.templateRemoved : th.templateSaved);
      void queryClient.invalidateQueries({ queryKey: boardsQueryKey });
    } catch {
      toast.error(th.templateFailed);
    }
  };

  // Project boards come after the workspace's own, under their own heading.
  const boards = useMemo(() => [...(recent.data ?? []), ...(projectBoards.data ?? [])], [recent.data, projectBoards.data]);
  const groups: GroupConfig<BoardMeta>[] = useMemo(
    () => [
      { id: 'boards', label: th.recent, filter: (b) => !b.projectId, sortOrder: 0 },
      { id: 'projects', label: th.projectBoards, filter: (b) => !!b.projectId, sortOrder: 1 },
    ],
    [th],
  );

  if (recent.isLoading) return <PageLoader fullScreen={false} />;
  const failed = recent.isError && !recent.data;

  return (
    <div className="flex w-full flex-col">
      {canCreate && (
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
              <TemplatesGallery compact onPick={(tpl) => void createBoard(tpl)} />
            </div>
            <input
              ref={fileInput}
              type="file"
              accept={IMPORT_ACCEPT}
              className="hidden"
              onChange={(e) => {
                void importPicked(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>
        </section>
      )}

      {failed ? (
        <ErrorState message={th.loadFailed} onRetry={() => void recent.refetch()} retryLabel={th.retry} className="py-16" />
      ) : (
        <BoardList
          boards={boards}
          onOpen={open}
          onRename={canUpdate ? (board, name) => rename.mutate({ id: board.id, name }) : undefined}
          onDuplicate={canCreate ? (board) => void create.mutateAsync({ name: format(th.copyOf, { name: board.name }), fromBoardId: board.id }).then(open, () => undefined) : undefined}
          onDelete={canDelete ? (board) => remove.mutate(board.id) : undefined}
          onToggleTemplate={!preview && canUpdate ? (board) => void toggleTemplate(board) : undefined}
          projectName={projectBoards.data?.length ? (b) => (b.projectId ? (projectNames.get(b.projectId) ?? null) : null) : undefined}
          groups={projectBoards.data?.length ? groups : undefined}
          onCreate={
            canCreate
              ? () => {
                  if (!create.isPending) void createBoard();
                }
              : undefined
          }
          notice={preview ? <span className="text-xs text-muted-foreground">{th.localNotice}</span> : undefined}
          emptyStateClassName="min-h-[360px] py-12"
          deletePermanently={!!preview}
        />
      )}
    </div>
  );
}
