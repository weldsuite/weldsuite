import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import {
  PAPER_SIZES,
  TEMPLATE_FIELDS,
  invoiceTemplateDocumentSchema,
  type InvoiceTemplate,
  type PaperSize,
  type TemplateBlockType,
  type TemplateField,
  type UpdateInvoiceTemplateInput,
} from '@weldsuite/books-domain/invoice-template/schema';
import { TooltipProvider } from '@weldsuite/ui/components/tooltip';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useUpdateAccountingEntity } from '@/hooks/queries/use-accounting-queries';
import { useUpdateInvoiceTemplate } from '@/hooks/queries/use-invoice-template-queries';
import type { AccountingEntity, UpdateAccountingEntityInput } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { usePreviewData, useTemplateLayout } from '../use-template-preview';
import { DesignerCanvas, type CanvasApi } from './canvas';
import { DesignerProvider } from './context';
import { useElementWidth, useMatchMedia } from './hooks';
import { LayersPanel } from './layers-panel';
import { BlockInspector } from './inspector/block-inspector';
import { DocumentInspector } from './inspector/document-inspector';
import type { EntityBranding } from './inspector/branding-section';
import {
  DEFAULT_SIZES,
  canAddBlock,
  createBlock,
  newBlockId,
  placementForNew,
  removableIds,
} from './model/block-factory';
import { canRedo, canUndo, editorReducer, initialEditorState, type EditorAction, type EditorState } from './model/editor-reducer';
import { BlockPalette } from './palette';
import { PdfPreviewDialog } from './pdf-preview-dialog';
import { DesignerTopBar, ZOOM_STEPS } from './top-bar';
import { useTemplateImageUpload } from './use-image-upload';

/** 96 dpi screen pixels per PDF point: a 100% zoom shows the page at its printed size. */
const PX_PER_PT = 96 / 72;
const CANVAS_PADDING = 80;

type BrandingDraft = EntityBranding;

/** Branding as stored: blanks removed, so an untouched field and an emptied one compare equal. */
function cleanBranding(value: BrandingDraft | undefined | null): BrandingDraft {
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value ?? {})) {
    if (typeof v === 'string' && v.trim() !== '') out[key] = v;
  }
  return out as BrandingDraft;
}

function sameBranding(a: BrandingDraft | undefined | null, b: BrandingDraft | undefined | null): boolean {
  const x = cleanBranding(a) as Record<string, string>;
  const y = cleanBranding(b) as Record<string, string>;
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].every((key) => x[key] === y[key]);
}

/** True for text fields and anything inside an open dialog or menu: shortcuts stay out of the way. */
function shortcutsSuspended(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return true;
  // Dialogs and menus own the keyboard; so do widgets that use the arrow keys themselves.
  return Boolean(
    target.closest(
      '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="radio"], [role="slider"], [role="combobox"], [aria-roledescription="sortable"]',
    ),
  );
}

interface ShortcutContext {
  state: EditorState;
  readOnly: boolean;
  dispatch: (action: EditorAction) => void;
  /** Tells the user the line-items table cannot be deleted. */
  onCantDelete: () => void;
}

const ARROW_STEPS: Record<string, [number, number]> = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };

/** Undo, redo, select all and escape: they work with nothing selected. Returns true when the key was one of them. */
function handleGlobalShortcut(e: KeyboardEvent, mod: boolean, key: string, { state, readOnly, dispatch }: ShortcutContext): boolean {
  if (mod && key === 'z') {
    e.preventDefault();
    if (!readOnly) dispatch({ type: e.shiftKey ? 'redo' : 'undo' });
    return true;
  }
  if (mod && key === 'y') {
    e.preventDefault();
    if (!readOnly) dispatch({ type: 'redo' });
    return true;
  }
  if (mod && key === 'a') {
    e.preventDefault();
    dispatch({ type: 'select', ids: state.doc.blocks.filter((b) => !b.hidden).map((b) => b.id) });
    return true;
  }
  if (key === 'escape') {
    dispatch({ type: 'select', ids: [] });
    return true;
  }
  return false;
}

/** Duplicate, delete and nudge: they act on the selection. */
function handleSelectionShortcut(e: KeyboardEvent, mod: boolean, key: string, { state, dispatch, onCantDelete }: ShortcutContext): void {
  if (mod && key === 'd') {
    e.preventDefault();
    dispatch({ type: 'duplicateBlocks', ids: state.selection });
    return;
  }
  if (key === 'delete' || key === 'backspace') {
    e.preventDefault();
    if (removableIds(state.doc, state.selection).length === 0) onCantDelete();
    else dispatch({ type: 'deleteBlocks', ids: state.selection });
    return;
  }
  const arrow = ARROW_STEPS[key];
  if (arrow && !mod) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    dispatch({ type: 'nudge', ids: state.selection, dx: arrow[0] * step, dy: arrow[1] * step });
  }
}

interface InvoiceTemplateDesignerProps {
  template: InvoiceTemplate;
  entity: AccountingEntity | undefined;
}

/**
 * The invoice designer: block palette and layers on the left, the page on a
 * canvas in the middle, the inspector on the right. Everything on the page is
 * the real output of the layout engine, with interaction boxes on top.
 */
export function InvoiceTemplateDesigner({ template, entity }: Readonly<InvoiceTemplateDesignerProps>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceTemplates;
  const canUpdate = useCan('accounts:update');
  const canEditEntity = useCan('entities:update');
  const wide = useMatchMedia('(min-width: 1024px)');
  const readOnly = !canUpdate || !wide;

  const [state, dispatch] = useReducer(editorReducer, template.document, initialEditorState);
  const { doc } = state;
  const [meta, setMeta] = useState({ name: template.name, isDefault: template.isDefault });
  const [savedMeta, setSavedMeta] = useState({ name: template.name, isDefault: template.isDefault });
  const [sampleRows, setSampleRows] = useState(3);
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const updateTemplate = useUpdateInvoiceTemplate();
  const updateEntity = useUpdateAccountingEntity();
  const uploadImage = useTemplateImageUpload();
  const canvasApi = useRef<CanvasApi | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const hostWidth = useElementWidth(hostRef);

  // ---------------------------------------------------------------------------
  // Branding (the company's, shared by every template): edited as a draft
  // ---------------------------------------------------------------------------
  const storedBranding = (entity?.branding ?? {}) as BrandingDraft;
  const [brandingDraft, setBrandingDraft] = useState<BrandingDraft | null>(null);
  const branding = brandingDraft ?? storedBranding;
  const brandingDirty = brandingDraft !== null && !sameBranding(brandingDraft, storedBranding);
  const [brandingSaving, setBrandingSaving] = useState(false);

  const previewEntity = useMemo(() => (entity ? { ...entity, branding } : undefined), [entity, branding]);
  const preview = usePreviewData(previewEntity, sampleRows);
  const layout = useTemplateLayout(doc, preview.data);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------
  const paper = PAPER_SIZES[doc.paperSize];
  const fitScale = hostWidth > 0 ? Math.max(0.3, (hostWidth - CANVAS_PADDING) / paper.width) : PX_PER_PT;
  const scale = zoom === 'fit' ? fitScale : (zoom / 100) * PX_PER_PT;
  const zoomPercent = Math.round((scale / PX_PER_PT) * 100);

  const docDirty = state.doc !== state.saved;
  const metaDirty = meta.name.trim() !== savedMeta.name || meta.isDefault !== savedMeta.isDefault;
  const dirty = docDirty || metaDirty;
  const anyUnsaved = dirty || brandingDirty;

  const fieldNames = useMemo(() => {
    const names = t.accounting.invoiceTemplateDocument.fields as Record<TemplateField, string>;
    return Object.fromEntries(TEMPLATE_FIELDS.map((f) => [f, names[f]])) as Record<TemplateField, string>;
  }, [t]);

  const selectedBlocks = useMemo(() => {
    const selected = new Set(state.selection);
    return doc.blocks.filter((b) => selected.has(b.id));
  }, [doc.blocks, state.selection]);

  // ---------------------------------------------------------------------------
  // Leaving with unsaved changes
  // ---------------------------------------------------------------------------
  const { proceed, reset, status } = useBlocker({
    shouldBlockFn: () => anyUnsaved,
    withResolver: true,
    enableBeforeUnload: anyUnsaved,
  });

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  const addBlock = useCallback(
    (type: TemplateBlockType, at?: { x: number; y: number }) => {
      if (readOnly || !canAddBlock(doc, type)) return;
      const id = newBlockId(type, doc.blocks.map((b) => b.id));
      const size = DEFAULT_SIZES[type];
      const position = at
        ? {
            x: Math.max(0, Math.min(Math.round(at.x / 4) * 4, paper.width - size.w)),
            y: Math.max(0, Math.min(Math.round(at.y / 4) * 4, paper.height - size.h)),
          }
        : placementForNew(doc, size, canvasApi.current?.visibleOrigin() ?? { x: 24, y: 24 }, { width: paper.width, height: paper.height });
      dispatch({ type: 'addBlock', block: createBlock(type, id, { ...position, text: ti.blocks.newText }) });
    },
    [doc, paper.height, paper.width, readOnly, ti.blocks.newText],
  );

  const setPaperSize = (paperSize: PaperSize) => dispatch({ type: 'updateDoc', update: (d) => ({ ...d, paperSize }) });

  const save = useCallback(async () => {
    if (readOnly || !dirty || saving) return;
    const parsed = invoiceTemplateDocumentSchema.safeParse(doc);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      toast.error(ti.designer.invalid.replace('{message}', `${where}${issue.message}`));
      return;
    }
    const name = meta.name.trim() || savedMeta.name;
    const data: UpdateInvoiceTemplateInput = {};
    if (docDirty) data.document = parsed.data;
    if (name !== savedMeta.name) data.name = name;
    if (meta.isDefault !== savedMeta.isDefault) data.isDefault = meta.isDefault;

    setSaving(true);
    try {
      await updateTemplate.mutateAsync({ id: template.id, data });
      dispatch({ type: 'markSaved' });
      setMeta({ name, isDefault: meta.isDefault });
      setSavedMeta({ name, isDefault: meta.isDefault });
      toast.success(ti.designer.saved);
    } catch (err) {
      toast.error(ti.designer.saveFailed, { description: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  }, [dirty, doc, docDirty, meta, readOnly, saving, savedMeta, template.id, ti.designer, updateTemplate]);

  const saveBranding = useCallback(async () => {
    if (!entity || !brandingDraft || !canEditEntity) return;
    const tb = ti.inspector.branding;
    setBrandingSaving(true);
    try {
      // The API replaces the whole branding object.
      const data: UpdateAccountingEntityInput = { branding: cleanBranding(brandingDraft) };
      await updateEntity.mutateAsync({ id: entity.id, data });
      toast.success(tb.saved);
    } catch (err) {
      toast.error(tb.saveFailed, { description: err instanceof Error ? err.message : undefined });
    } finally {
      setBrandingSaving(false);
    }
  }, [brandingDraft, canEditEntity, entity, ti.inspector.branding, updateEntity]);

  const stepZoom = useCallback(
    (direction: 1 | -1) => {
      const current = zoomPercent;
      const next =
        direction === 1 ? ZOOM_STEPS.find((s) => s > current + 0.5) : [...ZOOM_STEPS].reverse().find((s) => s < current - 0.5);
      if (next) setZoom(next);
    },
    [zoomPercent],
  );

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------
  const live = useRef({ state, save, readOnly });
  live.current = { state, save, readOnly };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const { state: s, save: doSave, readOnly: ro } = live.current;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // Save works from anywhere, text fields included.
      if (mod && key === 's') {
        e.preventDefault();
        void doSave();
        return;
      }
      if (shortcutsSuspended(e.target)) return;

      const context: ShortcutContext = {
        state: s,
        readOnly: ro,
        dispatch,
        onCantDelete: () => toast.info(t.accounting.invoiceTemplates.canvas.cantDeleteTable),
      };
      if (handleGlobalShortcut(e, mod, key, context)) return;
      if (s.selection.length === 0 || ro) return;
      handleSelectionShortcut(e, mod, key, context);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [t]);

  // A run of arrow-key nudges, or of typing in one inspector field, is one undo step; a pause ends it.
  useEffect(() => {
    const timer = window.setTimeout(() => dispatch({ type: 'endCoalesce', prefixes: ['nudge:', 'inspector:', 'doc:'] }), 600);
    return () => window.clearTimeout(timer);
  }, [state.doc]);

  const context = useMemo(() => ({ theme: doc.theme, readOnly, fieldNames, uploadImage }), [doc.theme, readOnly, fieldNames, uploadImage]);

  return (
    <TooltipProvider delayDuration={250}>
      <DesignerProvider value={context}>
        <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
          <DesignerTopBar
            name={meta.name}
            onNameChange={(name) => setMeta((m) => ({ ...m, name }))}
            onNameBlur={() => setMeta((m) => (m.name.trim() === '' ? { ...m, name: savedMeta.name } : m))}
            isDefault={meta.isDefault}
            onDefaultChange={(isDefault) => setMeta((m) => ({ ...m, isDefault }))}
            paperSize={doc.paperSize}
            onPaperSizeChange={setPaperSize}
            canUndo={canUndo(state)}
            canRedo={canRedo(state)}
            onUndo={() => dispatch({ type: 'undo' })}
            onRedo={() => dispatch({ type: 'redo' })}
            zoomPercent={zoomPercent}
            fit={zoom === 'fit'}
            onFit={() => setZoom('fit')}
            onZoomPercent={setZoom}
            onZoomStep={stepZoom}
            sampleRows={sampleRows}
            onSampleRows={setSampleRows}
            onPreview={() => setPreviewOpen(true)}
            onSave={() => void save()}
            dirty={dirty}
            saving={saving}
            readOnly={readOnly}
            canEdit={canUpdate && wide}
          />

          {!canUpdate ? (
            <p className="border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">{ti.designer.readOnly}</p>
          ) : null}
          {!wide ? <p className="border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">{ti.designer.narrow}</p> : null}

          <div className="flex min-h-0 flex-1">
            <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-background lg:flex">
              <div className="max-h-[58%] shrink-0 overflow-y-auto border-b border-border">
                <BlockPalette doc={doc} readOnly={readOnly} onAdd={(type) => addBlock(type)} />
              </div>
              <LayersPanel blocks={doc.blocks} selection={state.selection} readOnly={readOnly} fieldNames={fieldNames} dispatch={dispatch} />
            </aside>

            <main ref={hostRef} className="flex min-w-0 flex-1 flex-col">
              <DesignerCanvas
                doc={doc}
                layout={layout}
                selection={state.selection}
                scale={scale}
                readOnly={readOnly}
                dispatch={dispatch}
                apiRef={canvasApi}
                onDropBlock={addBlock}
                onWheelZoom={stepZoom}
              />
              <p className="border-t border-border bg-background px-3 py-1.5 text-[11px] text-muted-foreground">{ti.designer.sampleNotice}</p>
            </main>

            <aside className="hidden w-80 shrink-0 border-l border-border bg-background lg:block">
              <div className="h-full overflow-y-auto">
                {selectedBlocks.length > 0 ? (
                  <BlockInspector blocks={selectedBlocks} dispatch={dispatch} />
                ) : (
                  <DocumentInspector
                    doc={doc}
                    dispatch={dispatch}
                    branding={{
                      value: branding,
                      dirty: brandingDirty,
                      saving: brandingSaving,
                      canEdit: canEditEntity && Boolean(entity),
                      onChange: (patch) => setBrandingDraft((d) => cleanPatch({ ...(d ?? storedBranding), ...patch })),
                      onSave: () => void saveBranding(),
                      onDiscard: () => setBrandingDraft(null),
                    }}
                  />
                )}
              </div>
            </aside>
          </div>
        </div>

        <PdfPreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} layout={layout} />

        <ConfirmDialog
          open={status === 'blocked'}
          onOpenChange={(open) => {
            if (!open) reset?.();
          }}
          title={ti.designer.unsavedTitle}
          description={ti.designer.unsavedDescription}
          confirmLabel={ti.designer.leave}
          cancelLabel={ti.designer.stay}
          variant="destructive"
          onConfirm={() => proceed?.()}
        />
      </DesignerProvider>
    </TooltipProvider>
  );
}

/** A branding object with the keys the editor cleared (set to undefined) dropped. */
function cleanPatch(value: Record<string, unknown>): BrandingDraft {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as BrandingDraft;
}
