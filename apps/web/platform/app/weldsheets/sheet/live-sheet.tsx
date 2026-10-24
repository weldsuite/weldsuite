import { useEffect, useReducer, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { isApiError } from '@weldsuite/api-client';
import { SHEET_CONNECT_PATH } from '@weldsuite/app-api-client/schemas/sheets';
import type { Peer, Presence } from '@weldsuite/sheets-engine';
import { PageLoader } from '@/components/page-loader';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useAppApi } from '@/lib/api/use-app-api';
import { getApiOriginForPath } from '@/lib/api/public-env';
import { useI18n } from '@/lib/i18n/provider';
import { SheetEditor } from '../editor/sheet-editor';
import { SheetController } from '../editor/model/sheet-controller';
import { sheetLocale } from '../editor/number-formats';
import { SheetConnection } from '../collab/sheet-connection';
import { sheetsQueryKey, useSheetMutations } from '../store/use-sheet-store';
import { MissingSheet, SheetHeader, type SheetStatus } from './sheet-chrome';
import { PeerAvatars } from './peer-avatars';

/** How often, at most, this person's cursor goes out to the others. */
const PRESENCE_MS = 120;
/** Ranges of a ctrl+click selection sent along; the rest are not drawn for others. */
const MAX_PRESENCE_RANGES = 10;

function presenceOf(controller: SheetController): Presence {
  const { selection } = controller;
  return {
    sheetId: controller.activeSheetId,
    active: selection.active,
    ranges: selection.ranges.slice(-MAX_PRESENCE_RANGES),
    editing: !!controller.editing,
  };
}

/** The room socket for a session ticket, on whichever host serves sheets-api. */
function roomUrl(ticket: string): string {
  const origin = getApiOriginForPath(SHEET_CONNECT_PATH).replace(/^http/, 'ws');
  return `${origin}${SHEET_CONNECT_PATH}?ticket=${encodeURIComponent(ticket)}`;
}

/**
 * A spreadsheet in a workspace, co-edited live: its content comes from and
 * goes to the sheet's room over a socket (SheetConnection); the name and the
 * other record fields come from sheets-api.
 */
export function LiveSheet({ sheetId }: { sheetId: string }) {
  const appApi = useAppApi();
  const sheetsApi = useRef(appApi.sheets);
  sheetsApi.current = appApi.sheets;
  const canUpdate = useCan('sheets:update');
  const { t, language } = useI18n();
  const tw = t.weldsheets;
  const queryClient = useQueryClient();
  const { rename } = useSheetMutations();
  const [controller, setController] = useState<SheetController | null>(null);
  const [gone, setGone] = useState(false);
  const [roomCanEdit, setRoomCanEdit] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [, statusChanged] = useReducer((n: number) => n + 1, 0);
  const connection = useRef<SheetConnection | null>(null);
  const strings = useRef(tw);
  strings.current = tw;
  const languageRef = useRef(language);
  languageRef.current = language;

  const recordKey = [...sheetsQueryKey, 'sheet', sheetId] as const;
  const record = useQuery({
    queryKey: recordKey,
    queryFn: async () => (await sheetsApi.current.get(sheetId)).data,
    retry: (count, err) => !(isApiError(err) && (err.status === 404 || err.status === 403)) && count < 3,
  });

  useEffect(() => {
    let current: SheetController | null = null;
    // The first peer list arrives just before the workbook.
    let latestPeers: Peer[] = [];
    // Locale is read once: a language switch applies when the sheet is reopened.
    const locale = sheetLocale(languageRef.current);
    const conn = new SheetConnection({
      openSession: async () => roomUrl((await sheetsApi.current.session(sheetId)).data.ticket),
      events: {
        onReset: (engine, { canEdit, lostEdits }) => {
          setRoomCanEdit(canEdit);
          if (current) {
            current.replaceEngine(engine);
            if (lostEdits) toast.warning(strings.current.editor.resynced);
            return;
          }
          current = new SheetController(engine, {
            locale: locale.format,
            formulaLocale: locale.formula,
            applyOp: (op) => conn.apply(op),
          });
          current.setPeers(latestPeers);
          setController(current);
        },
        onRemoteOp: (op) => current?.remoteOp(op),
        onPeers: (next) => {
          latestPeers = next;
          setPeers(next);
          current?.setPeers(next);
        },
        onStatus: statusChanged,
        onGone: () => setGone(true),
      },
    });
    connection.current = conn;
    conn.start();
    return () => {
      conn.stop();
      connection.current = null;
    };
  }, [sheetId]);

  // Where this person is, for everyone else: sent when it changes, at most every PRESENCE_MS.
  useEffect(() => {
    if (!controller) return;
    let sent = '';
    let timer: number | null = null;
    const send = () => {
      timer = null;
      const presence = presenceOf(controller);
      const key = JSON.stringify(presence);
      if (key === sent) return;
      sent = key;
      connection.current?.setPresence(presence);
    };
    const unsubscribe = controller.subscribe(() => {
      timer ??= window.setTimeout(send, PRESENCE_MS);
    });
    send();
    return () => {
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [controller]);

  const canEdit = canUpdate && roomCanEdit;
  useEffect(() => {
    controller?.setReadOnly(!canEdit);
  }, [controller, canEdit]);

  // Edits the room has not confirmed yet would be lost with the page.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (connection.current?.pending) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const name = record.data?.name ?? '';
  useBreadcrumbs([{ label: tw.breadcrumb.home, href: '/weldsheets' }, { label: name || tw.home.untitled }], {
    enabled: !!controller,
  });

  const missing = gone || (isApiError(record.error) && (record.error.status === 404 || record.error.status === 403));
  if (missing) return <MissingSheet message={controller ? tw.editor.removed : tw.home.notFound} />;
  if (!controller) return <PageLoader fullScreen={false} />;

  const conn = connection.current;
  const offline = conn?.status === 'reconnecting';
  let status: SheetStatus = 'saved';
  if (!canEdit) status = 'view-only';
  else if (offline) status = conn?.pending ? 'offline-pending' : 'reconnecting';
  else if (conn?.pending) status = 'saving';

  const onRename = (next: string) => {
    queryClient.setQueryData(recordKey, (old: typeof record.data) => (old ? { ...old, name: next } : old));
    rename.mutate(
      { id: sheetId, name: next },
      {
        onError: () => {
          void queryClient.invalidateQueries({ queryKey: recordKey });
          toast.error(tw.editor.renameFailed);
        },
      },
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SheetHeader name={name} canRename={canEdit && !!record.data?.canEdit} onRename={onRename} status={status}>
        <PeerAvatars
          peers={peers}
          onSelect={(peer) => {
            if (peer.presence) controller.goTo(peer.presence.sheetId, peer.presence.active.row, peer.presence.active.col);
          }}
        />
      </SheetHeader>
      <div className="min-h-0 flex-1">
        <SheetEditor controller={controller} />
      </div>
    </div>
  );
}
