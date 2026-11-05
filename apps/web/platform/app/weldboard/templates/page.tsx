import { useNavigate } from '@tanstack/react-router';
import { useCan } from '@weldsuite/permissions/react';
import { Board, applyOp, newId, placeFragment, type BuiltInTemplate } from '@weldsuite/board-engine';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useI18n } from '@/lib/i18n/provider';
import { BoardList } from '../board-list';
import { buildTemplate, TemplatesGallery } from '../editor/templates-dialog';
import { useBoardList, useBoardMutations, type BoardMeta } from '../store/use-board-store';

/** Built-in templates, and the boards the team saved as templates. */
export default function WeldBoardTemplates() {
  const { t } = useI18n();
  const tt = t.weldboard.templates;
  const navigate = useNavigate();
  const preview = usePreviewMode();
  const canCreate = useCan('boards:create');
  const workspace = useBoardList({ templates: true }, !preview);
  const { create } = useBoardMutations();
  useBreadcrumbs([{ label: t.weldboard.breadcrumb.home, href: preview ? '/preview/weldboard' : '/weldboard' }, { label: t.weldboard.breadcrumb.templates }]);

  const open = (id: string) => {
    if (preview) void navigate({ to: '/preview/weldboard/$boardId', params: { boardId: id } });
    else void navigate({ to: '/weldboard/$boardId', params: { boardId: id } });
  };

  const fromBuiltIn = async (template: BuiltInTemplate) => {
    if (!canCreate) return;
    const board = Board.create();
    applyOp(board, placeFragment(board, buildTemplate(template, t, () => newId()), { x: 0, y: 0, makeId: () => newId() }).op);
    const meta = await create.mutateAsync({ name: (tt.names as Record<string, string>)[template.id] ?? t.weldboard.home.untitled, snapshot: board.toSnapshot() });
    open(meta.id);
  };

  const fromWorkspace = async (template: BoardMeta) => {
    if (!canCreate) return;
    const meta = await create.mutateAsync({ name: template.name, fromBoardId: template.id });
    open(meta.id);
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-lg font-semibold">{tt.title}</h1>
        <p className="text-sm text-muted-foreground">{tt.description}</p>
      </header>
      {!preview && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">{tt.workspace}</h2>
          {workspace.data?.length ? (
            <BoardList boards={workspace.data} onOpen={(b) => void fromWorkspace(b)} />
          ) : (
            <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{tt.workspaceEmpty}</p>
          )}
        </section>
      )}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">{tt.builtIn}</h2>
        <TemplatesGallery onPick={(tpl) => void fromBuiltIn(tpl)} />
      </section>
    </div>
  );
}
