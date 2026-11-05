import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { isApiError } from '@weldsuite/api-client';
import { BOARD_CONNECT_PATH, type BoardSessionMode } from '@weldsuite/app-api-client/schemas/boards';
import type { BoardPeer } from '@weldsuite/board-engine';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ShareDialog, type DriveShareTarget } from '@/app/welddrive/components/share-dialog';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useWorkspaceMemberDirectory } from '@/hooks/queries/use-settings-queries';
import { useUser } from '@/lib/auth';
import { useAppApi } from '@/lib/api/use-app-api';
import { getApiOriginForPath } from '@/lib/api/public-env';
import { useI18n } from '@/lib/i18n/provider';
import { BoardConnection } from '../collab/board-connection';
import { BoardEditor, type BoardEditorProps, type BoardStatus } from '../editor/board-editor';
import { BoardController } from '../editor/model/board-controller';
import { boardsQueryKey, useBoardMutations } from '../store/use-board-store';
import { useImageLoader, useUploadImage } from '../use-board-files';
import { BackLink, MissingBoard } from './board-chrome';
import { FollowBanner, PeerAvatars } from './peer-avatars';

/** How often, at most, this person's pointer and view go out to the others. */
const PRESENCE_MS = 60;

function roomUrl(ticket: string): string {
  const origin = getApiOriginForPath(BOARD_CONNECT_PATH).replace(/^http/, 'ws');
  return `${origin}${BOARD_CONNECT_PATH}?ticket=${encodeURIComponent(ticket)}`;
}

export interface LiveBoardProps {
  boardId: string;
  /** Where the back arrow goes (a project's whiteboards, or the WeldBoard home). */
  backTo?: string;
  backLabel?: string;
  /** Breadcrumbs above the board, given its name (a project's pages set their own). */
  breadcrumbs?: (name: string) => { label: string; href?: string }[];
  /** Panels and controls the later parts of WeldBoard add (comments, versions, facilitation). */
  extend?: (c: BoardController, ctx: { boardId: string; mode: BoardSessionMode; name: string; peers: BoardPeer[] }) => Partial<BoardEditorProps> & { menuExtra?: ReactNode };
}

/**
 * A board in a workspace, co-edited live: its content comes from and goes to
 * the board's room over a socket (BoardConnection); the name and the other
 * record fields come from board-api. An old WeldFlow whiteboard is converted
 * first, keeping its id.
 */
export function LiveBoard({ boardId, backTo = '/weldboard', backLabel, breadcrumbs, extend }: LiveBoardProps) {
  const appApi = useAppApi();
  const boardsApi = useRef(appApi.boards);
  boardsApi.current = appApi.boards;
  const canUpdate = useCan('boards:update');
  const { t } = useI18n();
  const tw = t.weldboard;
  const queryClient = useQueryClient();
  const { rename } = useBoardMutations();
  const loadImage = useImageLoader();
  const uploadImage = useUploadImage();
  const { user } = useUser();
  const [controller, setController] = useState<BoardController | null>(null);
  const [gone, setGone] = useState(false);
  const [roomCanEdit, setRoomCanEdit] = useState(false);
  const [mode, setMode] = useState<BoardSessionMode>('view');
  const [peers, setPeers] = useState<BoardPeer[]>([]);
  const [shareTarget, setShareTarget] = useState<DriveShareTarget | null>(null);
  const [, setTick] = useState(0);
  const connection = useRef<BoardConnection | null>(null);
  const strings = useRef(tw);
  strings.current = tw;
  const userRef = useRef({ id: '', name: '' });
  userRef.current = { id: user?.id ?? '', name: user?.fullName || user?.username || user?.primaryEmailAddress?.emailAddress || '' };
  const members = useWorkspaceMemberDirectory();

  const recordKey = [...boardsQueryKey, 'board', boardId] as const;
  const record = useQuery({
    queryKey: recordKey,
    queryFn: async () => {
      const { data } = await boardsApi.current.get(boardId);
      // An old WeldFlow whiteboard becomes a board the first time anyone opens it.
      if (data.legacy) return (await boardsApi.current.convert({ whiteboardId: boardId })).data;
      return data;
    },
    retry: (count, err) => !(isApiError(err) && (err.status === 404 || err.status === 403)) && count < 3,
  });
  const ready = !!record.data && !record.data.legacy;
  const name = record.data?.name ?? '';

  useEffect(() => {
    if (!ready) return;
    let current: BoardController | null = null;
    let latestPeers: BoardPeer[] = [];
    const conn = new BoardConnection({
      openSession: async () => {
        const { data } = await boardsApi.current.session(boardId);
        setMode(data.mode);
        return roomUrl(data.ticket);
      },
      events: {
        onReset: (board, { canEdit, lostEdits }) => {
          setRoomCanEdit(canEdit);
          if (current) {
            current.replaceBoard(board);
            if (lostEdits) toast.warning(strings.current.editor.resynced);
            return;
          }
          current = new BoardController(board, { applyOp: (op) => conn.apply(op), userId: userRef.current.id, userName: userRef.current.name });
          current.setPeers(latestPeers);
          setController(current);
        },
        onRemoteOp: (op) => current?.remoteOp(op),
        onPeers: (next) => {
          latestPeers = next;
          setPeers(next);
          current?.setPeers(next);
        },
        onStatus: () => setTick((n) => n + 1),
        onGone: () => setGone(true),
        onRestored: () => {
          toast.info(strings.current.editor.restored);
          void queryClient.invalidateQueries({ queryKey: [...boardsQueryKey, 'versions', boardId] });
        },
      },
    });
    connection.current = conn;
    conn.start();
    return () => {
      conn.stop();
      connection.current = null;
    };
  }, [boardId, ready, queryClient]);

  // Names for authors, assignees and mentions.
  useEffect(() => {
    if (!controller) return;
    controller.names = new Map((members.data?.data ?? []).map((m) => [m.userId, m.name || m.email || m.userId]));
    controller.changed();
  }, [controller, members.data]);

  // Where this person is, for everyone else: sent when it changes, at most every PRESENCE_MS.
  const sendPresence = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!controller) return;
    let sent = '';
    let timer: number | null = null;
    const send = () => {
      timer = null;
      const presence = controller.presence();
      const key = JSON.stringify(presence);
      if (key === sent) return;
      sent = key;
      connection.current?.setPresence(presence);
    };
    const queue = () => {
      timer ??= window.setTimeout(send, PRESENCE_MS);
    };
    sendPresence.current = queue;
    const offReact = controller.subscribe(queue);
    const offRender = controller.onRender(queue);
    send();
    return () => {
      offReact();
      offRender();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [controller]);

  const canEdit = canUpdate && roomCanEdit;
  useEffect(() => {
    if (!controller) return;
    controller.canComment = mode !== 'view';
    controller.setReadOnly(!canEdit);
  }, [controller, canEdit, mode]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (connection.current?.pending) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  useBreadcrumbs(breadcrumbs ? breadcrumbs(name || tw.home.untitled) : [{ label: tw.breadcrumb.home, href: '/weldboard' }, { label: name || tw.home.untitled }], { enabled: !!controller });

  const extension = useMemo(() => (controller && extend ? extend(controller, { boardId, mode, name, peers }) : {}), [controller, extend, boardId, mode, name, peers]);

  const missing = gone || (isApiError(record.error) && (record.error.status === 404 || record.error.status === 403));
  if (missing) return <MissingBoard message={controller ? tw.editor.removed : tw.home.notFound} backTo={backTo} />;
  if (record.isError) return <MissingBoard message={tw.project.convertFailed} backTo={backTo} />;
  if (!controller) return <PageLoader fullScreen={false} />;

  const conn = connection.current;
  const offline = conn?.status === 'reconnecting';
  let status: BoardStatus = 'saved';
  if (!canEdit) status = mode === 'comment' ? 'comment-only' : 'view-only';
  else if (offline) status = conn?.pending ? 'offline-pending' : 'reconnecting';
  else if (conn?.pending) status = 'saving';

  const onRename = (next: string) => {
    queryClient.setQueryData(recordKey, (old: typeof record.data) => (old ? { ...old, name: next } : old));
    rename.mutate(
      { id: boardId, name: next },
      {
        onError: () => {
          void queryClient.invalidateQueries({ queryKey: recordKey });
          toast.error(tw.editor.renameFailed);
        },
      },
    );
  };

  const fileId = record.data?.fileId;
  const link = `${window.location.origin}${backTo.startsWith('/weldflow') ? `${backTo}/${encodeURIComponent(boardId)}` : `/weldboard/${encodeURIComponent(boardId)}`}`;

  return (
    <>
      <BoardEditor
        controller={controller}
        name={name || tw.home.untitled}
        status={status}
        canRename={canEdit && !!record.data?.canEdit}
        onRename={onRename}
        loadImage={loadImage}
        uploadImage={uploadImage}
        unfurl={async (url) => (await boardsApi.current.unfurl({ url })).data}
        headerExtra={<PeerAvatars controller={controller} peers={peers} />}
        banner={<FollowBanner controller={controller} peers={peers} />}
        onShare={fileId && !record.data?.projectId ? () => setShareTarget({ kind: 'item', fileId, name: name || tw.home.untitled, link }) : undefined}
        back={<BackLink to={backTo} label={backLabel ?? tw.home.backHome} />}
        context={{
          onCopyLink: (id) => {
            void navigator.clipboard.writeText(`${link}?el=${encodeURIComponent(id)}`).then(() => toast.success(tw.editor.actions.linkCopied));
          },
        }}
        {...extension}
      />
      <ShareDialog target={shareTarget} onOpenChange={(open) => !open && setShareTarget(null)} />
    </>
  );
}
