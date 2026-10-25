import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useI18n } from '@/lib/i18n/provider';
import { DocEditor } from '../editor/doc-editor';
import { DocController } from '../editor/model/doc-controller';
import { useDocMutations, useLocalDocStore } from '../store/use-doc-store';
import { MissingDoc, type DocStatus } from './doc-chrome';

const SAVE_DELAY_MS = 800;

/** A document kept in the browser: loaded from IndexedDB, autosaved after every change. */
export function LocalDoc({ docId }: { docId: string }) {
  const store = useLocalDocStore();
  const preview = usePreviewMode();
  const canUpdate = useCan('docs:update');
  const { t, language } = useI18n();
  const tw = t.welddocs;
  const [controller, setController] = useState<DocController | 'missing' | null>(null);
  const [saving, setSaving] = useState<'idle' | 'pending' | 'saving' | 'failed'>('idle');
  const [name, setName] = useState('');
  const { rename } = useDocMutations();
  const saveTimer = useRef<number | null>(null);
  /** Changes made since the last successful save. */
  const dirty = useRef(false);
  const scheduleRef = useRef(() => {});
  const nameRef = useRef(name);
  nameRef.current = name;

  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    void store.load(docId).then((result) => {
      if (cancelled) return;
      if (!result) {
        setController('missing');
        return;
      }
      const ctl = new DocController(result.snapshot, {
        onOp: () => scheduleRef.current(),
        title: result.meta.name,
        locale: language,
      });
      setName(result.meta.name);
      setController(ctl);
    });
    return () => {
      cancelled = true;
    };
    // The language only matters for date fields; a switch applies when the document is reopened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, docId]);

  const loaded = controller && controller !== 'missing' ? controller : null;

  useEffect(() => {
    loaded?.setReadOnly(!canUpdate);
  }, [loaded, canUpdate]);

  /** Writes the document if it changed since the last save; a failure keeps it dirty and says so. */
  const flush = async () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (!store || !loaded || !dirty.current) return;
    dirty.current = false;
    setSaving('saving');
    try {
      await store.save(docId, loaded.snapshot());
      setSaving(dirty.current ? 'pending' : 'idle');
    } catch {
      dirty.current = true;
      setSaving('failed');
      toast.error(tw.editor.saveFailed);
    }
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  scheduleRef.current = () => {
    dirty.current = true;
    setSaving('pending');
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flushRef.current(), SAVE_DELAY_MS);
  };

  // Save unsaved changes on leaving the page, and when the tab is hidden or
  // closed (no unmount happens then); a document only looked at is not written.
  useEffect(() => {
    const onHide = () => void flushRef.current();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onHide();
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      void flushRef.current();
    };
  }, []);

  useBreadcrumbs([{ label: tw.breadcrumb.home, href: preview ? '/preview/welddocs' : '/welddocs' }, { label: name || tw.home.untitled }], {
    enabled: !!loaded,
  });

  if (controller === 'missing') return <MissingDoc message={tw.home.notFound} />;
  if (!loaded) return <PageLoader fullScreen={false} />;

  let status: DocStatus = 'saved';
  if (!canUpdate) status = 'view-only';
  else if (saving === 'failed') status = 'failed';
  else if (saving !== 'idle') status = 'saving';

  const onRename = (next: string) => {
    const previous = name;
    setName(next);
    loaded.options.title = next;
    rename.mutate(
      { id: docId, name: next },
      {
        onError: () => {
          setName(previous);
          toast.error(tw.editor.renameFailed);
        },
      },
    );
  };

  return <DocEditor controller={loaded} name={name || tw.home.untitled} status={status} canRename={canUpdate} onRename={onRename} />;
}
