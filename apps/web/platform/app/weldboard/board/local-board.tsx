import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Board } from '@weldsuite/board-engine';
import { useCan } from '@weldsuite/permissions/react';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { BoardEditor } from '../editor/board-editor';
import { BoardController } from '../editor/model/board-controller';
import { useBoardMutations, useLocalBoardStore } from '../store/use-board-store';
import { useImageLoader, useUploadImage } from '../use-board-files';
import { BackLink, MissingBoard } from './board-chrome';

const SAVE_DELAY_MS = 800;

/** A board kept in the browser (the signed-out preview): loaded from IndexedDB, autosaved after every change. */
export function LocalBoard({ boardId }: { boardId: string }) {
  const store = useLocalBoardStore();
  const canUpdate = useCan('boards:update');
  const { t } = useI18n();
  const tw = t.weldboard;
  const [controller, setController] = useState<BoardController | 'missing' | null>(null);
  const [name, setName] = useState('');
  const { rename } = useBoardMutations();
  const loadImage = useImageLoader();
  const uploadImage = useUploadImage();
  const saveTimer = useRef<number | null>(null);
  // Read through a ref, so switching language does not reload the board (and drop its pending save).
  const strings = useRef({ you: tw.editor.peers.you, saveFailed: tw.editor.saveFailed });
  strings.current = { you: tw.editor.peers.you, saveFailed: tw.editor.saveFailed };

  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    let loaded: BoardController | null = null;
    const save = (c: BoardController) => store.save(boardId, c.board.toSnapshot()).catch(() => toast.error(strings.current.saveFailed));
    void store.load(boardId).then((result) => {
      if (cancelled) return;
      if (!result) {
        setController('missing');
        return;
      }
      setName(result.meta.name);
      const board = result.snapshot ? Board.fromSnapshot(result.snapshot) : Board.create();
      const c = new BoardController(board, {
        userId: 'preview',
        userName: strings.current.you,
        onOp: () => {
          if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
          saveTimer.current = window.setTimeout(() => {
            saveTimer.current = null;
            void save(c);
          }, SAVE_DELAY_MS);
        },
      });
      loaded = c;
      setController(c);
    });
    return () => {
      cancelled = true;
      // Leaving the board: save what the debounce was still holding, now.
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
        if (loaded) void save(loaded);
      }
    };
  }, [boardId, store]);

  useEffect(() => {
    if (controller && controller !== 'missing') controller.setReadOnly(!canUpdate);
  }, [controller, canUpdate]);

  useBreadcrumbs([{ label: tw.breadcrumb.home, href: '/preview/weldboard' }, { label: name || tw.home.untitled }], { enabled: !!controller });

  if (controller === 'missing') return <MissingBoard message={tw.home.notFound} />;
  if (!controller) return <PageLoader fullScreen={false} />;
  return (
    <BoardEditor
      controller={controller}
      name={name || tw.home.untitled}
      status="local"
      canRename={canUpdate}
      onRename={(next) => {
        setName(next);
        rename.mutate({ id: boardId, name: next });
      }}
      loadImage={loadImage}
      uploadImage={uploadImage}
      back={<BackLink to="/preview/weldboard" label={tw.home.backHome} />}
    />
  );
}
