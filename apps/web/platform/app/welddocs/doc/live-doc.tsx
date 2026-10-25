import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { isApiError } from '@weldsuite/api-client';
import { DOC_CONNECT_PATH } from '@weldsuite/app-api-client/schemas/docs';
import type { DocPeer } from '@weldsuite/docs-engine';
import { PageLoader } from '@/components/page-loader';
import { useWorkspaceMemberDirectory } from '@/hooks/queries/use-settings-queries';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useAppApi } from '@/lib/api/use-app-api';
import { getApiOriginForPath } from '@/lib/api/public-env';
import { useI18n } from '@/lib/i18n/provider';
import { DocConnection } from '../collab/doc-connection';
import { DocEditor } from '../editor/doc-editor';
import { DocController } from '../editor/model/doc-controller';
import { docsQueryKey, useDocMutations } from '../store/use-doc-store';
import { MissingDoc, type DocStatus } from './doc-chrome';
import { PeerAvatars } from './peer-avatars';

/** How often, at most, this person's caret goes out to the others. */
const PRESENCE_MS = 120;

/** The room socket for a session ticket, on whichever host serves docs-api. */
function roomUrl(ticket: string): string {
  const origin = getApiOriginForPath(DOC_CONNECT_PATH).replace(/^http/, 'ws');
  return `${origin}${DOC_CONNECT_PATH}?ticket=${encodeURIComponent(ticket)}`;
}

/**
 * A document in a workspace, co-edited live: its content comes from and goes
 * to the document's room over a socket (DocConnection); the name and the
 * other record fields come from docs-api.
 */
export function LiveDoc({ docId }: { docId: string }) {
  const appApi = useAppApi();
  const docsApi = useRef(appApi.docs);
  docsApi.current = appApi.docs;
  const canUpdate = useCan('docs:update');
  const { t, language } = useI18n();
  const tw = t.welddocs;
  const queryClient = useQueryClient();
  const { rename } = useDocMutations();
  const [controller, setController] = useState<DocController | null>(null);
  const [gone, setGone] = useState(false);
  const [roomCanEdit, setRoomCanEdit] = useState(false);
  const [peers, setPeers] = useState<DocPeer[]>([]);
  const [, statusChanged] = useReducer((n: number) => n + 1, 0);
  const connection = useRef<DocConnection | null>(null);
  const strings = useRef(tw);
  strings.current = tw;
  const languageRef = useRef(language);
  languageRef.current = language;
  const { user } = useUser();
  const reviewer = useRef({ id: '', name: '' });
  reviewer.current = { id: user?.id ?? '', name: user?.fullName || user?.username || user?.primaryEmailAddress?.emailAddress || '' };
  const members = useWorkspaceMemberDirectory();
  const people = useMemo(() => (members.data?.data ?? []).map((m) => ({ id: m.userId, name: m.name || m.email || m.userId })), [members.data]);

  const recordKey = [...docsQueryKey, 'doc', docId] as const;
  const record = useQuery({
    queryKey: recordKey,
    queryFn: async () => (await docsApi.current.get(docId)).data,
    retry: (count, err) => !(isApiError(err) && (err.status === 404 || err.status === 403)) && count < 3,
  });
  const name = record.data?.name ?? '';
  const nameRef = useRef(name);
  nameRef.current = name;

  useEffect(() => {
    let current: DocController | null = null;
    // The first peer list arrives just before the document.
    let latestPeers: DocPeer[] = [];
    const conn = new DocConnection({
      openSession: async () => roomUrl((await docsApi.current.session(docId)).data.ticket),
      events: {
        onReset: (doc, { canEdit, lostEdits }) => {
          setRoomCanEdit(canEdit);
          if (current) {
            current.replaceDocument(doc);
            if (lostEdits) toast.warning(strings.current.editor.resynced);
            return;
          }
          current = new DocController(doc, { applyOp: (op) => conn.apply(op), title: nameRef.current, locale: languageRef.current, reviewer: reviewer.current });
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
  }, [docId]);

  // Where this person is, for everyone else: sent when it changes, at most every PRESENCE_MS.
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
    const unsubscribe = controller.subscribe(() => {
      timer ??= window.setTimeout(send, PRESENCE_MS);
    });
    send();
    // The typing flag wears off without a change to trigger a send.
    const idle = window.setInterval(send, 2000);
    return () => {
      unsubscribe();
      window.clearInterval(idle);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [controller]);

  const canEdit = canUpdate && roomCanEdit;
  useEffect(() => {
    controller?.setReadOnly(!canEdit);
  }, [controller, canEdit]);

  useEffect(() => {
    if (controller) controller.options.title = name;
  }, [controller, name]);

  // Edits the room has not confirmed yet would be lost with the page.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (connection.current?.pending) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  useBreadcrumbs([{ label: tw.breadcrumb.home, href: '/welddocs' }, { label: name || tw.home.untitled }], {
    enabled: !!controller,
  });

  const missing = gone || (isApiError(record.error) && (record.error.status === 404 || record.error.status === 403));
  if (missing) return <MissingDoc message={controller ? tw.editor.removed : tw.home.notFound} />;
  if (!controller) return <PageLoader fullScreen={false} />;

  const conn = connection.current;
  const offline = conn?.status === 'reconnecting';
  let status: DocStatus = 'saved';
  if (!canEdit) status = 'view-only';
  else if (offline) status = conn?.pending ? 'offline-pending' : 'reconnecting';
  else if (conn?.pending) status = 'saving';

  const onRename = (next: string) => {
    queryClient.setQueryData(recordKey, (old: typeof record.data) => (old ? { ...old, name: next } : old));
    rename.mutate(
      { id: docId, name: next },
      {
        onError: () => {
          void queryClient.invalidateQueries({ queryKey: recordKey });
          toast.error(tw.editor.renameFailed);
        },
      },
    );
  };

  return (
    <DocEditor
      controller={controller}
      name={name || tw.home.untitled}
      status={status}
      canRename={canEdit && !!record.data?.canEdit}
      onRename={onRename}
      headerExtra={<PeerAvatars peers={peers} onSelect={(peer) => controller.goToPeer(peer)} />}
      people={people}
    />
  );
}
