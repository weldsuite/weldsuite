import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { isApiError } from '@weldsuite/api-client';
import { SHEET_CONNECT_PATH, type SheetSessionMode, type SheetSummary } from '@weldsuite/app-api-client/schemas/sheets';
import { Database, History, MessageSquare, Users } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ShareDialog, type DriveShareTarget } from '@/app/welddrive/components/share-dialog';
import { useWorkspaceMemberDirectory } from '@/hooks/queries/use-settings-queries';
import type { Peer, Presence } from '@weldsuite/sheets-engine';
import { PageLoader } from '@/components/page-loader';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useAppApi } from '@/lib/api/use-app-api';
import { getApiOriginForPath } from '@/lib/api/public-env';
import { useI18n } from '@/lib/i18n/provider';
import { SheetEditor } from '../editor/sheet-editor';
import { SheetController } from '../editor/model/sheet-controller';
import { CommentsPanel } from '../editor/comments/comments-panel';
import { sheetLocale } from '../editor/number-formats';
import { SheetConnection } from '../collab/sheet-connection';
import { sheetsQueryKey, useSheetMutations } from '../store/use-sheet-store';
import { MissingSheet, PanelToggle, SheetHeader, type SheetStatus } from './sheet-chrome';
import { DownloadMenu } from './download-menu';
import { PeerAvatars } from './peer-avatars';
import { DataPanel, useDataSources } from './data-panel';
import { VersionsPanel, versionsQueryKey } from './versions-panel';
import { SheetAgentContext } from './sheet-agent-context';

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

/**
 * What Share opens: the sheet's sharing, or for a WeldFlow project sheet
 * (whose access follows the project) a note saying so and its link.
 */
function shareTargetOf(sheet: SheetSummary, name: string): DriveShareTarget {
  const origin = window.location.origin;
  if (sheet.projectId) {
    const link = `${origin}/weldflow/project/${encodeURIComponent(sheet.projectId)}/table/${encodeURIComponent(sheet.fileId)}`;
    return { kind: 'item', fileId: sheet.fileId, name, link, recordFile: true };
  }
  return { kind: 'item', fileId: sheet.fileId, name, link: `${origin}/weldsheets/${encodeURIComponent(sheet.id)}` };
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
export function LiveSheet({ sheetId, embedded = false, onBack }: { sheetId: string; embedded?: boolean; onBack?: () => void }) {
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
  const [mode, setMode] = useState<SheetSessionMode>('view');
  const [shareTarget, setShareTarget] = useState<DriveShareTarget | null>(null);
  const { user } = useUser();
  const author = useRef({ id: '', name: '' });
  author.current = { id: user?.id ?? '', name: user?.fullName || user?.username || user?.primaryEmailAddress?.emailAddress || '' };
  const members = useWorkspaceMemberDirectory();
  const people = useMemo(() => (members.data?.data ?? []).map((m) => ({ id: m.userId, name: m.name || m.email || m.userId })), [members.data]);
  const dataSources = useDataSources(sheetId);
  const tableLabels = useMemo(
    () => Object.fromEntries((dataSources.data ?? []).map((s) => [s.id, t.sheetData.objects[s.objectType]])),
    [dataSources.data, t],
  );
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
      openSession: async () => {
        const { data } = await sheetsApi.current.session(sheetId);
        setMode(data.mode);
        return roomUrl(data.ticket);
      },
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
            onInputRefused: (rule) => toast.error(rule.help ?? strings.current.validation.refused),
            author: author.current,
          });
          current.setPeers(latestPeers);
          // A link to a comment (from WeldChat) opens it.
          const thread = new URLSearchParams(window.location.search).get('comment');
          if (thread) current.openThread(thread);
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
        onRestored: () => {
          toast.info(strings.current.versions.restored);
          void queryClient.invalidateQueries({ queryKey: versionsQueryKey(sheetId) });
        },
      },
    });
    connection.current = conn;
    conn.start();
    return () => {
      conn.stop();
      connection.current = null;
    };
  }, [sheetId, queryClient]);

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
    if (!controller) return;
    controller.setReadOnly(!canEdit);
    controller.setCanComment(mode === 'comment');
  }, [controller, canEdit, mode]);

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
    enabled: !!controller && !embedded,
  });

  const missing = gone || (isApiError(record.error) && (record.error.status === 404 || record.error.status === 403));
  if (missing) return <MissingSheet message={controller ? tw.editor.removed : tw.home.notFound} />;
  if (!controller) return <PageLoader fullScreen={false} />;

  const conn = connection.current;
  const offline = conn?.status === 'reconnecting';
  let status: SheetStatus = 'saved';
  if (!canEdit) status = mode === 'comment' ? 'comment-only' : 'view-only';
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
      <SheetHeader name={name} canRename={canEdit && !!record.data?.canEdit} onRename={onRename} status={status} onBack={onBack}>
        <PeerAvatars
          peers={peers}
          onSelect={(peer) => {
            if (peer.presence) controller.goTo(peer.presence.sheetId, peer.presence.active.row, peer.presence.active.col);
          }}
        />
        <PanelToggle controller={controller} panel="comments" label={tw.comments.title}>
          <MessageSquare className="size-4" />
        </PanelToggle>
        <PanelToggle controller={controller} panel="versions" label={tw.versions.title}>
          <History className="size-4" />
        </PanelToggle>
        <PanelToggle controller={controller} panel="data" label={tw.dataSources.title}>
          <Database className="size-4" />
        </PanelToggle>
        <DownloadMenu controller={controller} name={name || tw.home.untitled} />
        {record.data && (
          <Button
            size="sm"
            className="h-7 gap-1.5"
            onClick={() => setShareTarget(shareTargetOf(record.data, name || tw.home.untitled))}
          >
            <Users className="size-4" />
            {tw.editor.share}
          </Button>
        )}
        <ShareDialog target={shareTarget} onOpenChange={(open) => !open && setShareTarget(null)} />
      </SheetHeader>
      <SheetAgentContext controller={controller} sheetId={sheetId} name={name || tw.home.untitled} />
      <div className="min-h-0 flex-1">
        <SheetEditor
          controller={controller}
          tableLabels={tableLabels}
          panels={{
            comments: <CommentsPanel controller={controller} sheetId={sheetId} people={people} />,
            versions: (
              <VersionsPanel
                sheetId={sheetId}
                name={name || tw.home.untitled}
                canEdit={canEdit}
                people={people}
                locale={controller.options.locale}
                onClose={() => controller.openPanel(null)}
              />
            ),
            data: <DataPanel sheetId={sheetId} controller={controller} canEdit={canEdit} people={people} onClose={() => controller.openPanel(null)} />,
          }}
        />
      </div>
    </div>
  );
}
