import { useCallback } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useParams } from '@/lib/router';
import { LiveBoard } from '@/app/weldboard/board/live-board';
import { useBoardExtensions } from '@/app/weldboard/board/extensions';

/**
 * A WeldFlow project's whiteboard: a WeldBoard board that belongs to the
 * project (docs/plans/weldboard.md, ADR BOARD-001). Who may open and edit it
 * follows the project's members; an old WeldFlow whiteboard becomes a board
 * the first time it is opened, keeping its id and so this link.
 */
export default function WhiteboardDetailPage() {
  const st = useTranslations();
  const params = useParams();
  const projectId = params.projectId as string;
  const whiteboardId = params.whiteboardId as string;
  const extend = useBoardExtensions();
  const listHref = `/weldflow/project/${projectId}/whiteboard`;

  const breadcrumbs = useCallback(
    (name: string) => [
      { label: st('sweep.weldflow.whiteboardListPage.projects'), href: '/weldflow' },
      { label: st('sweep.weldflow.whiteboardListPage.whiteboards'), href: listHref },
      { label: name },
    ],
    [st, listHref],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <LiveBoard
        key={whiteboardId}
        boardId={whiteboardId}
        backTo={listHref}
        backLabel={st('sweep.weldflow.whiteboardListPage.backToList')}
        breadcrumbs={breadcrumbs}
        extend={extend}
      />
    </div>
  );
}
