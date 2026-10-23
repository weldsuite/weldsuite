import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { AlertCircle, Check, Eye, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { SheetEditor } from '../editor/sheet-editor';
import { SheetController } from '../editor/model/sheet-controller';
import { sheetLocale } from '../editor/number-formats';
import { useSheetMutations, useSheetStore } from '../store/use-sheet-store';

const SAVE_DELAY_MS = 800;

type SaveState = 'idle' | 'pending' | 'saving' | 'failed';

/** One spreadsheet: loads it from the store, autosaves after every change. */
export default function SheetPage() {
  // Not strict: the same page serves /weldsheets/$sheetId and its /preview mirror.
  const { sheetId = '' } = useParams({ strict: false });
  const preview = usePreviewMode();
  const store = useSheetStore();
  const canUpdate = useCan('sheets:update');
  const { t, language } = useI18n();
  const tw = t.weldsheets;
  const [controller, setController] = useState<SheetController | 'missing' | null>(null);
  const [saving, setSaving] = useState<SaveState>('idle');
  const [name, setName] = useState('');
  const { rename } = useSheetMutations();
  const saveTimer = useRef<number | null>(null);
  /** Changes made since the last successful save. */
  const dirty = useRef(false);
  /** The name as last stored, so renaming back to it is still saved. */
  const savedName = useRef('');
  const languageRef = useRef(language);
  languageRef.current = language;
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
      });
      savedName.current = result.meta.name;
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

  useBreadcrumbs([{ label: tw.breadcrumb.home, href: preview ? '/preview/weldsheets' : '/weldsheets' }, { label: name || tw.home.untitled }], {
    enabled: !!loaded,
  });

  if (controller === 'missing') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <p>{tw.home.notFound}</p>
        <Link to={preview ? '/preview/weldsheets' : '/weldsheets'} className="text-sm text-primary underline">
          {tw.home.backHome}
        </Link>
      </div>
    );
  }
  if (!loaded) return <PageLoader fullScreen={false} />;

  const commitName = (next: string) => {
    const trimmed = next.trim() || tw.home.untitled;
    setName(trimmed);
    if (!canUpdate || trimmed === savedName.current) return;
    const previous = savedName.current;
    savedName.current = trimmed;
    rename.mutate(
      { id: sheetId, name: trimmed },
      {
        onError: () => {
          savedName.current = previous;
          toast.error(tw.editor.saveFailed);
        },
      },
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b px-3">
        <input
          value={name}
          readOnly={!canUpdate}
          onChange={(e) => setName(e.target.value)}
          onBlur={(e) => commitName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          aria-label={tw.home.rename}
          className="min-w-0 max-w-md flex-1 rounded px-1 text-base font-medium outline-none hover:bg-muted focus:bg-muted"
        />
        {canUpdate ? <SaveIndicator state={saving} /> : <ViewOnly label={tw.editor.viewOnly} />}
      </div>
      <div className="min-h-0 flex-1">
        <SheetEditor controller={loaded} />
      </div>
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const { t } = useI18n();
  const te = t.weldsheets.editor;
  if (state === 'failed') {
    return (
      <span className="flex items-center gap-1 text-xs text-destructive" aria-live="polite">
        <AlertCircle className="size-3.5" />
        {te.notSaved}
      </span>
    );
  }
  const busy = state !== 'idle';
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
      {busy ? te.saving : te.saved}
    </span>
  );
}

function ViewOnly({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <Eye className="size-3.5" />
      {label}
    </span>
  );
}
