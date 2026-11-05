import { useCallback, useMemo, useRef } from 'react';
import { useCan } from '@weldsuite/permissions/react';
import { useWorkspaceMemberDirectory } from '@/hooks/queries/use-settings-queries';
import { isFeatureAvailable } from '@/lib/edition';
import { useRouter } from '@/lib/router';
import type { BoardController } from '../editor/model/board-controller';
import type { LiveBoardProps } from './live-board';
import { BoardPanels, PanelMenuItems, SidePanels } from './panels';
import { recordUrl } from './records';

/**
 * Panels and controls added to a live board: comments (in the board's
 * WeldChat chat), version history, WeldSuite record cards, stickies made
 * tasks, and the AI. Kept apart from LiveBoard so the WeldFlow project page mounts the
 * same board with the same extras.
 */
export function useBoardExtensions(): LiveBoardProps['extend'] {
  const members = useWorkspaceMemberDirectory();
  const people = useMemo(() => (members.data?.data ?? []).map((m) => ({ id: m.userId, name: m.name || m.email || m.userId })), [members.data]);
  // One panel state per board controller, so a reconnect keeps what is open.
  const stores = useRef(new WeakMap<BoardController, BoardPanels>());
  const router = useRouter();
  const canCreateTasks = useCan('tasks:create');
  // AI runs where WeldAgent's does (no AI provider on the Kubernetes editions yet).
  const aiAvailable = isFeatureAvailable('agent-ai');
  return useCallback<NonNullable<LiveBoardProps['extend']>>(
    (c, ctx) => {
      let panels = stores.current.get(c);
      if (!panels) {
        panels = new BoardPanels();
        stores.current.set(c, panels);
      }
      const store = panels;
      return {
        panel: <SidePanels controller={c} boardId={ctx.boardId} projectId={ctx.projectId} people={people} panels={store} canEdit={ctx.mode === 'edit'} />,
        menuExtra: <PanelMenuItems panels={store} />,
        onComment: (id: string) => store.focusComment(id),
        onRecords: ctx.mode === 'edit' ? () => store.openRecords() : undefined,
        onAi: ctx.mode === 'edit' && aiAvailable ? () => store.openAi() : undefined,
        context: {
          ...(ctx.mode === 'edit' && canCreateTasks ? { onToTasks: (ids: string[]) => store.openTasks(ids) } : {}),
          onOpenRecord: (el) => {
            if (el.record) router.push(recordUrl(el.record));
          },
        },
      };
    },
    [people, router, canCreateTasks, aiAvailable],
  );
}
