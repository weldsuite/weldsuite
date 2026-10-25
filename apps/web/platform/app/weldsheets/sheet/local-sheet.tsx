import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { SheetEditor } from '../editor/sheet-editor';
import { SheetController } from '../editor/model/sheet-controller';
import { sheetLocale } from '../editor/number-formats';
import { useLocalSheetStore, useSheetMutations } from '../store/use-sheet-store';
import { MissingSheet, SheetHeader, type SheetStatus } from './sheet-chrome';
import { DownloadMenu } from './download-menu';

const SAVE_DELAY_MS = 800;

/** A spreadsheet in the signed-out preview: loaded from the browser, autosaved after every change. */
export function LocalSheet({ sheetId }: { sheetId: string }) {
  const store = useLocalSheetStore();
  const canUpdate = useCan('sheets:update');
  const { t, language } = useI18n();
  const tw = t.weldsheets;
  const [controller, setController] = useState<SheetController | 'missing' | null>(null);
  const [saving, setSaving] = useState<'idle' | 'pending' | 'saving' | 'failed'>('idle');
  const [name, setName] = useState('');
  const { rename } = useSheetMutations();
  const saveTimer = useRef<number | null>(null);
  /** Changes made since the last successful save. */
  const dirty = useRef(false);
  const languageRef = useRef(language);
  languageRef.current = language;
  const stringsRef = useRef(tw);
  stringsRef.current = tw;
  const scheduleRef = useRef(() => {});

  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    void store.load(sheetId).then((result) => {
      if (cancelled) return;
      if (!result) {
        setController('missing');
        return;
      }
      // Locale is read once: a language switch applies when the sheet is reopened.
      const locale = sheetLocale(languageRef.current);
      const ctl = new SheetController(result.snapshot, {
        locale: locale.format,
        formulaLocale: locale.formula,
        onOp: () => scheduleRef.current(),
        onInputRefused: (rule) => toast.error(rule.help ?? stringsRef.current.validation.refused),
      });
      setName(result.meta.name);
      setController(ctl);
    });
    return () => {
      cancelled = true;
    };
  }, [store, sheetId]);

  const loaded = controller && controller !== 'missing' ? controller : null;

  useEffect(() => {
    loaded?.setReadOnly(!canUpdate);
  }, [loaded, canUpdate]);

  /** Writes the sheet if it changed since the last save; a failure keeps it dirty and says so. */
  const flush = async () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (!store || !loaded || !dirty.current) return;
    dirty.current = false;
    setSaving('saving');
    try {
      await store.save(sheetId, loaded.snapshot());
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

  // Save unsaved changes on leaving the page; a sheet only looked at is not written.
  useEffect(() => () => void flushRef.current(), []);

  useBreadcrumbs([{ label: tw.breadcrumb.home, href: '/preview/weldsheets' }, { label: name || tw.home.untitled }], {
    enabled: !!loaded,
  });

  if (controller === 'missing') return <MissingSheet message={tw.home.notFound} />;
  if (!loaded) return <PageLoader fullScreen={false} />;

  let status: SheetStatus = 'saved';
  if (!canUpdate) status = 'view-only';
  else if (saving === 'failed') status = 'failed';
  else if (saving !== 'idle') status = 'saving';

  const onRename = (next: string) => {
    const previous = name;
    setName(next);
    rename.mutate(
      { id: sheetId, name: next },
      {
        onError: () => {
          setName(previous);
          toast.error(tw.editor.renameFailed);
        },
      },
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SheetHeader name={name} canRename={canUpdate} onRename={onRename} status={status}>
        <DownloadMenu controller={loaded} name={name || tw.home.untitled} />
      </SheetHeader>
      <div className="min-h-0 flex-1">
        <SheetEditor controller={loaded} />
      </div>
    </div>
  );
}
