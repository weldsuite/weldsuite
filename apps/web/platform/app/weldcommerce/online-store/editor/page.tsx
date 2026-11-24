/**
 * The online store editor, full screen (`/weldcommerce/online-store/$siteId/editor`,
 * outside the WeldCommerce layout and the platform shell): the section lists
 * on the left, a live preview of the shop in the middle, and the settings of
 * what is selected on the right. `?template=<name>` or `?page=<id>` picks
 * what the middle list edits.
 *
 * Changes are saved on their own (`useAutosave`); after each save the preview
 * reloads the draft, and the selected section is highlighted in it. A section
 * clicked in the preview is selected here (`usePreviewBridge`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Provider as JotaiProvider, useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';
import { TEMPLATE_NAMES, type TemplateName } from '@weldsuite/storefront-theme/catalog';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { EditionUnavailablePage } from '@/components/edition-unavailable-page';
import { useAppAccess } from '@/hooks/use-app-access';
import {
  useOnlineStoreSite,
  useStorePage,
  useStorePages,
  type OnlineStoreSiteDetail,
  type StorePage,
} from '@/hooks/queries/use-online-store-queries';
import { isFeatureAvailable } from '@/lib/edition';
import { getTranslations } from '@/lib/i18n';
import { Link, useParams, useRouter, useSearchParams } from '@/lib/router';
import { createHistory } from '../lib/history';
import type { PreviewMessage } from '../lib/bridge';
import { OnlineStoreSettingsLink } from '../lib/settings-link';
import { PublishDialog } from '../components/publish-dialog';
import {
  DEVICE_WIDTHS,
  deviceAtom,
  fieldErrorsAtom,
  historyAtom,
  selectionAtom,
  useEditorDispatch,
  useEditorHistory,
  viewListKey,
  type EditorView,
} from './editor-state';
import { InspectorPanel } from './inspector-panel';
import { SectionsPanel } from './sections-panel';
import { EditorTopBar } from './top-bar';
import { useAutosave } from './use-autosave';
import { usePreviewBridge, type PreviewState } from './use-preview-bridge';
import { VersionsSheet } from './versions-sheet';

/** Where the preview opens a view. The other templates need a product or a category: the person opens one in the preview. */
export function previewPath(view: EditorView, pages: readonly StorePage[]): string | null {
  if (view.kind === 'page') {
    const page = pages.find((p) => p.id === view.pageId);
    return page ? `/pages/${page.slug}` : null;
  }
  switch (view.template) {
    case 'home':
      return '/';
    case 'search':
      return '/search';
    case 'cart':
      return '/cart';
    default:
      return null;
  }
}

function readView(params: { get: (key: string) => string | null }): EditorView {
  const pageId = params.get('page');
  if (pageId) return { kind: 'page', pageId };
  const template = params.get('template');
  if (template && (TEMPLATE_NAMES as readonly string[]).includes(template)) return { kind: 'template', template: template as TemplateName };
  return { kind: 'template', template: 'home' };
}

/** The query string `readView` reads `view` back from; none for the home template. */
function viewQuery(view: EditorView): string {
  if (view.kind === 'page') return `?page=${encodeURIComponent(view.pageId)}`;
  return view.template === 'home' ? '' : `?template=${view.template}`;
}

/** Typing in a field keeps the field's own undo; the editor's shortcuts work everywhere else. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'color'].includes(target.type));
}

function PreviewArea({
  url,
  state,
  frameRef,
  hasHost,
  siteId,
  hint,
  onRetry,
}: Readonly<{
  url: string | null;
  state: PreviewState;
  frameRef: React.RefObject<HTMLIFrameElement | null>;
  hasHost: boolean;
  siteId: string;
  hint: string | null;
  onRetry: () => void;
}>) {
  const t = getTranslations('commerce').onlineStore.editor;
  const device = useAtomValue(deviceAtom);
  const width = DEVICE_WIDTHS[device];

  if (!hasHost) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <p>{t.previewNoAddress}</p>
        <OnlineStoreSettingsLink siteId={siteId} className="font-medium text-primary underline underline-offset-4">
          {t.previewClaim}
        </OnlineStoreSettingsLink>
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <ErrorState message={t.previewFailed} onRetry={onRetry} />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
      {hint && <p className="text-center text-xs text-muted-foreground">{hint}</p>}
      <div
        className="relative mx-auto h-full max-w-full overflow-hidden rounded-md border bg-background shadow-sm transition-[width] motion-reduce:transition-none"
        style={{ width: width ? `${width}px` : '100%' }}
      >
        {url && <iframe ref={frameRef} src={url} title={t.previewTitle} className="h-full w-full" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />}
        {state !== 'ready' && (
          <p className="absolute inset-x-0 top-4 text-center text-xs text-muted-foreground" aria-live="polite">
            {t.previewLoading}
          </p>
        )}
      </div>
    </div>
  );
}

function EditorShell({ site }: Readonly<{ site: OnlineStoreSiteDetail }>) {
  useHydrateAtoms([[historyAtom, createHistory({ document: site.draft, pages: {} })]]);
  const t = getTranslations('commerce').onlineStore;
  const permissions = usePermissionsMaybe();
  const canUpdate = permissions?.can('websites:update') ?? false;
  const canManage = permissions?.can('websites:manage') ?? false;
  const readOnly = !canUpdate;
  const history = useEditorHistory();
  const dispatch = useEditorDispatch();
  const [selection, setSelection] = useAtom(selectionAtom);
  const fieldErrors = useAtomValue(fieldErrorsAtom);
  const setFieldErrors = useSetAtom(fieldErrorsAtom);
  const searchParams = useSearchParams();
  const router = useRouter();
  const view = readView(searchParams);
  const viewKey = view.kind === 'page' ? `page:${view.pageId}` : `template:${view.template}`;
  const detail = useOnlineStoreSite(site.id);
  const pagesQuery = useStorePages(site.id);
  const pages = useMemo(() => [...(pagesQuery.data?.data ?? [])].sort((a, b) => a.position - b.position), [pagesQuery.data]);
  const pageId = view.kind === 'page' ? view.pageId : '';
  const page = useStorePage(site.id, pageId, view.kind === 'page');
  const [publishing, setPublishing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const setView = useCallback(
    (next: EditorView) => {
      router.replace(`/weldcommerce/online-store/${site.id}/editor${viewQuery(next)}`);
      setSelection(null);
    },
    [router, site.id, setSelection],
  );

  // A content page's sections join the editor once read (no undo step).
  const loadedPage = page.data?.data;
  useEffect(() => {
    if (loadedPage) dispatch({ type: 'loadPage', pageId: loadedPage.id, sections: loadedPage.sections });
  }, [loadedPage, dispatch]);

  const onMessage = useCallback(
    (message: PreviewMessage) => {
      if (message.type !== 'select') return;
      if (message.list === 'header' || message.list === 'footer') {
        setSelection({ kind: 'section', list: { name: message.list }, sectionId: message.sectionId });
      } else if (message.list === 'content') {
        if (view.kind === 'page') setSelection({ kind: 'section', list: { name: 'content', pageId: view.pageId }, sectionId: message.sectionId });
      } else {
        if (view.kind !== 'template' || view.template !== message.list) setView({ kind: 'template', template: message.list });
        setSelection({ kind: 'section', list: { name: message.list }, sectionId: message.sectionId });
      }
    },
    [view, setView, setSelection],
  );

  const bridge = usePreviewBridge({ siteId: site.id, enabled: !!site.previewHost, onMessage });
  const { send } = bridge;
  const onSaved = useCallback(() => void send({ type: 'refresh' }), [send]);
  const autosave = useAutosave({
    siteId: site.id,
    content: history.present,
    initialDocument: site.draft,
    initialRevision: site.draftRevision,
    enabled: canUpdate,
    onSaved,
  });

  const highlighted = selection?.kind === 'section' ? selection.sectionId : null;
  useEffect(() => {
    if (bridge.state === 'ready') send({ type: 'highlight', sectionId: highlighted });
  }, [highlighted, bridge.state, send]);

  useEffect(() => {
    if (bridge.state !== 'ready') return;
    const path = previewPath(view, pages);
    if (path) send({ type: 'navigate', path });
    // Only when the view changes (or the preview first gets ready), not on every page list refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, bridge.state === 'ready']);

  useEffect(() => {
    if (readOnly) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || isTextEntry(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'z') dispatch({ type: event.shiftKey ? 'redo' : 'undo' });
      else if (key === 'y' && event.ctrlKey) dispatch({ type: 'redo' });
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [readOnly, dispatch]);

  const startOver = useCallback(
    (fresh: OnlineStoreSiteDetail) => {
      autosave.reset(fresh.draft, fresh.draftRevision);
      dispatch({ type: 'load', content: { document: fresh.draft, pages: history.present.pages } });
      setFieldErrors({});
    },
    [autosave, dispatch, history.present.pages, setFieldErrors],
  );

  const loadTheirs = async () => {
    const res = await detail.refetch();
    if (res.data) startOver(res.data.data);
  };

  const listKey = viewListKey(view);
  const viewTitle = view.kind === 'page' ? (loadedPage?.title ?? pages.find((p) => p.id === view.pageId)?.title ?? '') : t.editor.templates[view.template];
  const hint = view.kind === 'template' && (view.template === 'product' || view.template === 'category' || view.template === 'page' || view.template === 'notFound') ? t.editor.previewOpenHint : null;
  const errorMessages = Object.values(fieldErrors);

  let middle: React.ReactNode;
  if (view.kind === 'page' && page.isError) {
    const gone = (page.error as { status?: unknown } | null)?.status === 404;
    middle = (
      <div className="p-4">
        {gone ? (
          <p className="text-sm text-muted-foreground">{t.editor.pageNotFound}</p>
        ) : (
          <ErrorState message={t.editor.pageLoadFailed} onRetry={() => void page.refetch()} />
        )}
      </div>
    );
  } else if (view.kind === 'page' && !(view.pageId in history.present.pages)) {
    middle = <PageLoader fullScreen={false} />;
  } else {
    middle = <SectionsPanel listKey={listKey} title={viewTitle} readOnly={readOnly} />;
  }

  return (
    <div className="flex h-dvh flex-col bg-background">
      <EditorTopBar
        storeName={site.channelName}
        view={view}
        pages={pages}
        onViewChange={setView}
        status={autosave.status}
        onRetry={() => void autosave.save()}
        onReloadPreview={() => void bridge.reload()}
        previewAvailable={!!site.previewHost}
        readOnly={readOnly}
        canPublish={canManage}
        onPublish={() => setPublishing(true)}
        onOpenHistory={() => setHistoryOpen(true)}
      />
      {autosave.status === 'conflict' && (
        <InfoBanner
          variant="danger"
          title={t.editor.conflictTitle}
          className="rounded-none border-x-0"
          action={
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => void loadTheirs()}>
                {t.editor.conflictReload}
              </Button>
              <Button type="button" size="sm" onClick={() => void autosave.overwrite()}>
                {t.editor.conflictOverwrite}
              </Button>
            </div>
          }
        >
          {t.editor.conflictDescription}
        </InfoBanner>
      )}
      {autosave.status === 'invalid' && errorMessages.length > 0 && (
        <InfoBanner variant="warning" title={t.editor.invalidTitle} className="rounded-none border-x-0">
          <p>{t.editor.invalidDescription}</p>
          <ul className="mt-1 list-disc pl-5">
            {errorMessages.slice(0, 5).map((message, index) => (
              <li key={`${index}-${message}`}>{message}</li>
            ))}
          </ul>
        </InfoBanner>
      )}
      {readOnly && (
        <InfoBanner variant="neutral" className="rounded-none border-x-0">
          {t.editor.readOnly}
        </InfoBanner>
      )}
      <div className="flex min-h-0 flex-1">
        <aside aria-label={t.editor.panels.sections} className="w-64 shrink-0 border-r lg:w-72">
          {middle}
        </aside>
        <main className="hidden min-w-0 flex-1 flex-col bg-muted/40 md:flex">
          <PreviewArea
            url={bridge.url}
            state={bridge.state}
            frameRef={bridge.frameRef}
            hasHost={!!site.previewHost}
            siteId={site.id}
            hint={hint}
            onRetry={() => void bridge.reload()}
          />
        </main>
        <aside aria-label={t.editor.panels.settings} className="w-72 shrink-0 overflow-y-auto border-l lg:w-80">
          <InspectorPanel siteId={site.id} readOnly={readOnly} />
        </aside>
      </div>
      {canManage && <PublishDialog open={publishing} onOpenChange={setPublishing} siteId={site.id} beforePublish={canUpdate ? autosave.save : undefined} />}
      <VersionsSheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        siteId={site.id}
        canRestore={canManage}
        canCopy={canUpdate}
        onCopied={startOver}
      />
    </div>
  );
}

function Centered({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className="flex h-dvh flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">{children}</div>;
}

export default function OnlineStoreEditorPage() {
  const { siteId } = useParams<{ siteId: string }>();
  const t = getTranslations('commerce');
  const permissions = usePermissionsMaybe();
  const { isInstalled, isLoading } = useAppAccess('weldcommerce');
  const available = isFeatureAvailable('commerce');
  const canRead = permissions?.can('websites:read') ?? false;
  const site = useOnlineStoreSite(siteId ?? '', available && isInstalled && canRead);

  if (!available) return <EditionUnavailablePage />;
  if (isLoading || permissions?.isLoading) return <PageLoader />;
  if (!isInstalled) return <Centered>{t.notInstalled}</Centered>;
  if (!canRead) return <Centered>{t.onlineStore.noPermission}</Centered>;
  if (site.isPending) return <PageLoader />;
  // A failed refetch keeps the data it had: the editor stays, with its unsaved changes.
  if (!site.data) {
    return (
      <Centered>
        <ErrorState message={t.onlineStore.editor.loadFailed} onRetry={() => void site.refetch()} />
        <Link href="/weldcommerce/online-store" className="font-medium text-primary underline underline-offset-4">
          {t.onlineStore.editor.back}
        </Link>
      </Centered>
    );
  }
  const detail = site.data.data;
  if (detail.mode === 'static') {
    return (
      <Centered>
        <p>{t.onlineStore.editor.staticMode}</p>
        <OnlineStoreSettingsLink siteId={detail.id} className="font-medium text-primary underline underline-offset-4">
          {t.onlineStore.editor.openDeployments}
        </OnlineStoreSettingsLink>
        <Link href="/weldcommerce/online-store" className="underline underline-offset-4">
          {t.onlineStore.editor.back}
        </Link>
      </Centered>
    );
  }
  return (
    // A store of its own per site: switching sites starts from a clean history.
    <JotaiProvider key={detail.id}>
      <EditorShell site={detail} />
    </JotaiProvider>
  );
}
