import { useCallback, useMemo, useRef } from 'react';
import { useWorkspaceMemberDirectory } from '@/hooks/queries/use-settings-queries';
import type { BoardController } from '../editor/model/board-controller';
import type { LiveBoardProps } from './live-board';
import { BoardPanels, PanelMenuItems, SidePanels } from './panels';

/**
 * Panels and controls added to a live board: comments (in the board's
 * WeldChat chat) and version history. Kept apart from LiveBoard so the
 * WeldFlow project page mounts the same board with the same extras.
 */
export function useBoardExtensions(): LiveBoardProps['extend'] {
  const members = useWorkspaceMemberDirectory();
  const people = useMemo(() => (members.data?.data ?? []).map((m) => ({ id: m.userId, name: m.name || m.email || m.userId })), [members.data]);
  // One panel state per board controller, so a reconnect keeps what is open.
  const stores = useRef(new WeakMap<BoardController, BoardPanels>());
  return useCallback<NonNullable<LiveBoardProps['extend']>>(
    (c, ctx) => {
      let panels = stores.current.get(c);
      if (!panels) {
        panels = new BoardPanels();
        stores.current.set(c, panels);
      }
      const store = panels;
      return {
        panel: <SidePanels controller={c} boardId={ctx.boardId} people={people} panels={store} canEdit={ctx.mode === 'edit'} />,
        menuExtra: <PanelMenuItems panels={store} />,
        onComment: (id: string) => store.focusComment(id),
      };
    },
    [people],
  );
}
