import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { Check, Loader2 } from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { SheetEditor } from '../editor/sheet-editor';
import { SheetController } from '../editor/model/sheet-controller';
import { sheetLocale } from '../editor/number-formats';
import { useSheetMutations, useSheetStore, type SheetMeta } from '../store/use-sheet-store';

const SAVE_DELAY_MS = 800;

/** One spreadsheet: loads it from the store, autosaves after every change. */
export default function SheetPage() {
  // Not strict: the same page serves /weldsheets/$sheetId and its /preview mirror.
  const { sheetId = '' } = useParams({ strict: false });
  const preview = usePreviewMode();
  const store = useSheetStore();
  const { t, language } = useI18n();
  const tw = t.weldsheets;
  const [state, setState] = useState<{ meta: SheetMeta; controller: SheetController } | 'missing' | null>(null);
  const [saving, setSaving] = useState<'idle' | 'pending' | 'saving'>('idle');
  const [name, setName] = useState('');
  const { rename } = useSheetMutations();
  const saveTimer = useRef<number | null>(null);
  const languageRef = useRef(language);
  languageRef.current = language;
  const scheduleRef = useRef(() => {});

  useEffect(() => {
    if (!store) return;
    let cancelled = false;
    void store.load(sheetId).then((result) => {
      if (cancelled) return;
      if (!result) {
        setState('missing');
        return;
      }
      // Locale is read once: a language switch applies when the sheet is reopened.
      const locale = sheetLocale(languageRef.current);
      const controller = new SheetController(result.snapshot, {
        locale: locale.format,
        formulaLocale: locale.formula,
        onOp: () => scheduleRef.current(),
      });
      setName(result.meta.name);
      setState({ meta: result.meta, controller });
    });
    return () => {
      cancelled = true;
    };
  }, [store, sheetId]);

  const loaded = state && state !== 'missing' ? state : null;
  const controller = loaded?.controller ?? null;

  const flush = async () => {
    if (!store || !controller) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    setSaving('saving');
    await store.save(sheetId, controller.snapshot());
    setSaving('idle');
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  scheduleRef.current = () => {
    setSaving('pending');
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flushRef.current(), SAVE_DELAY_MS);
  };

  // Save on leaving the page.
  useEffect(() => () => void flushRef.current(), []);

  useBreadcrumbs([{ label: tw.breadcrumb.home, href: preview ? '/preview/weldsheets' : '/weldsheets' }, { label: name || tw.home.untitled }], { enabled: !!controller });

  if (state === 'missing') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <p>{tw.home.notFound}</p>
        <Link to={preview ? '/preview/weldsheets' : '/weldsheets'} className="text-sm text-primary underline">
          {tw.home.backHome}
        </Link>
      </div>
    );
  }
  if (!controller) return <PageLoader fullScreen={false} />;

  const commitName = (next: string) => {
    const trimmed = next.trim() || tw.home.untitled;
    setName(trimmed);
    if (loaded && trimmed !== loaded.meta.name) rename.mutate({ id: sheetId, name: trimmed });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b px-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={(e) => commitName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          aria-label={tw.home.rename}
          className="min-w-0 max-w-md flex-1 rounded px-1 text-base font-medium outline-none hover:bg-muted focus:bg-muted"
        />
        <span className="flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
          {saving === 'idle' ? <Check className="size-3.5" /> : <Loader2 className="size-3.5 animate-spin" />}
          {saving === 'idle' ? tw.editor.saved : tw.editor.saving}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <SheetEditor controller={controller} />
      </div>
    </div>
  );
}
