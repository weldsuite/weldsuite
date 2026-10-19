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
import { Cuboid, Layers2 } from 'lucide-react';
import { PageTabs } from '@weldsuite/ui/components/page-tabs';
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
import { SquareDimensions } from './block-icons';
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
import { MobilePreview } from './mobile-preview';
import { DesignerTopBar, type DesignerView } from './top-bar';
import { useTemplateImageUpload } from './use-image-upload';
import { PX_PER_PT, scaleOf } from './model/zoom';
import { useCanvasZoom } from './use-canvas-zoom';
import { ZoomControls } from './zoom-controls';

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

type SidebarTab = 'properties' | 'blocks' | 'layers';

interface InvoiceTemplateDesignerProps {
  template: InvoiceTemplate;
  entity: AccountingEntity | undefined;
}

/**
 * The invoice designer: the page on a canvas, and one sidebar on the right with
 * tabs for the inspector, the block palette and the layers. Everything on the
 * page is the real output of the layout engine, with interaction boxes on top.
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
  // The default template is chosen on the templates list, not here.
  const [meta, setMeta] = useState({ name: template.name });
  const [savedMeta, setSavedMeta] = useState({ name: template.name });
  const [sampleRows, setSampleRows] = useState(3);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('properties');
  const [view, setView] = useState<DesignerView>('desktop');

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
  // Fit the page to the canvas width, but never past its printed size: on a wide screen 100% reads best.
  const fitPercent = hostWidth > 0 ? Math.min(100, Math.max(20, ((hostWidth - CANVAS_PADDING) / paper.width / PX_PER_PT) * 100)) : 100;
  const canvasElements = useMemo(
    () => ({ scroller: () => canvasApi.current?.scroller() ?? null, page: () => canvasApi.current?.page() ?? null }),
    [],
  );
  const zoom = useCanvasZoom(fitPercent, canvasElements);
  const scale = scaleOf(zoom.shownPercent);

  const docDirty = state.doc !== state.saved;
  const metaDirty = meta.name.trim() !== savedMeta.name;
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

    setSaving(true);
    try {
      await updateTemplate.mutateAsync({ id: template.id, data });
      // Only what was sent is saved: edits made while the request ran stay unsaved.
      dispatch({ type: 'markSaved', doc });
      setMeta((m) => (m.name === meta.name ? { ...m, name } : m));
      setSavedMeta({ name });
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

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------
  const live = useRef({ state, save, readOnly, zoom });
  live.current = { state, save, readOnly, zoom };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const { state: s, save: doSave, readOnly: ro, zoom: z } = live.current;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      // Save works from anywhere, text fields included.
      if (mod && key === 's') {
        e.preventDefault();
        void doSave();
        return;
      }
      // Zoom the page, not the browser: Cmd/Ctrl + plus, minus, and 0 to fit.
      if (mod && !e.altKey && (key === '=' || key === '+' || key === '-' || key === '0')) {
        e.preventDefault();
        if (key === '-') z.zoomOut();
        else if (key === '0') z.zoomToFit();
        else z.zoomIn();
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
            entityId={template.entityId}
            name={meta.name}
            onNameChange={(name) => setMeta((m) => ({ ...m, name }))}
            onNameBlur={() => setMeta((m) => (m.name.trim() === '' ? { ...m, name: savedMeta.name } : m))}
            paperSize={doc.paperSize}
            onPaperSizeChange={setPaperSize}
            canUndo={canUndo(state)}
            canRedo={canRedo(state)}
            onUndo={() => dispatch({ type: 'undo' })}
            onRedo={() => dispatch({ type: 'redo' })}
            view={view}
            onViewChange={setView}
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
            <main ref={hostRef} className="relative flex min-w-0 flex-1 flex-col">
              {view === 'mobile' ? (
                <MobilePreview doc={doc} data={preview.data} selection={state.selection} dispatch={dispatch} />
              ) : (
                <>
                  <DesignerCanvas
                    doc={doc}
                    layout={layout}
                    selection={state.selection}
                    scale={scale}
                    readOnly={readOnly}
                    dispatch={dispatch}
                    apiRef={canvasApi}
                    onDropBlock={addBlock}
                    onWheelZoom={zoom.zoomWithWheel}
                  />
                  <ZoomControls
                    onZoomIn={zoom.zoomIn}
                    onZoomOut={zoom.zoomOut}
                    onFit={zoom.zoomToFit}
                    canZoomIn={zoom.canZoomIn}
                    canZoomOut={zoom.canZoomOut}
                  />
                </>
              )}
            </main>

            <aside className="hidden w-[399px] shrink-0 flex-col border-l border-border bg-background lg:flex">
              {selectedBlocks.length > 0 ? (
                // A selected block takes the whole sidebar: no tabs while editing it; the back arrow (or Escape,
                // or a click on empty canvas) returns to the tab you were on.
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <BlockInspector blocks={selectedBlocks} dispatch={dispatch} onBack={() => dispatch({ type: 'select', ids: [] })} />
                </div>
              ) : (
                <>
                  {/* The same underlined tabs as the other detail panels (task details and friends), in a 50px row;
                      each tab's icon and label sit 1px higher, the underline stays on the line. */}
                  <div className="flex h-[50px] shrink-0 flex-col justify-end [&_[role=tab]>span:first-child]:-translate-y-px">
                    <PageTabs
                      tabs={[
                        { id: 'properties', label: ti.designer.propertiesTab, icon: SquareDimensions },
                        { id: 'blocks', label: ti.palette.title, icon: Cuboid },
                        { id: 'layers', label: ti.layers.title, icon: Layers2 },
                      ]}
                      activeTab={sidebarTab}
                      onTabChange={(id) => setSidebarTab(id as SidebarTab)}
                      className="border-border"
                      innerClassName="px-4"
                    />
                  </div>
                  {sidebarTab === 'properties' ? (
                    <div className="min-h-0 flex-1 overflow-y-auto">
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
                    </div>
                  ) : null}
                  {sidebarTab === 'blocks' ? (
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      <BlockPalette doc={doc} readOnly={readOnly} onAdd={(type) => addBlock(type)} />
                    </div>
                  ) : null}
                  {sidebarTab === 'layers' ? (
                    <div className="flex min-h-0 flex-1 flex-col">
                      <LayersPanel blocks={doc.blocks} selection={state.selection} readOnly={readOnly} fieldNames={fieldNames} dispatch={dispatch} />
                    </div>
                  ) : null}
                </>
              )}
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
