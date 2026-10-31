/**
 * Placing fields on the pages. Pick a signer and a field type, then click on a
 * page; drag a field to move it, drag its corner to resize it. The field set is
 * saved as a whole with "Save" and when the editor is left.
 *
 * `useFieldEditor` holds the field set; `FieldTools` (signer, types, selected
 * field) and `FieldPages` (the pages) show it. A request puts the tools in its
 * side panel and the pages in its preview; a template's step puts them side by
 * side (`FieldsStep`).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  Calendar,
  CheckSquare,
  Loader2,
  Mail,
  PenLine,
  Save,
  Signature,
  Trash2,
  Type,
  User,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import {
  SIGN_FIELD_TYPES,
  type SignDocumentDto,
  type SignEnvelopeDetail,
  type SignFieldInput,
  type SignFieldType,
  type SignPageSize,
  type SignRecipientDto,
} from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { targetOf, useSaveSignFields, useSignDocumentContent, type SignTarget } from '@/hooks/queries/use-weldsign-queries';
import { moveBox, placeField, pointOnPage, resizeBox, scaleFor, type Box } from '../lib/geometry';
import { recipientColor, type RecipientColor } from '../lib/recipient-colors';
import { recipientLabel } from '../lib/recipients';
import { openPdf } from '../lib/pdf';
import { apiErrorMessage } from '../lib/errors';
import { PdfPage } from './pdf-page';

export type DraftField = SignFieldInput & { id: string };

const FIELD_ICONS: Record<SignFieldType, LucideIcon> = {
  signature: Signature,
  initials: PenLine,
  date_signed: Calendar,
  name: User,
  email: Mail,
  text: Type,
  checkbox: CheckSquare,
};

/** The id of a document's pages in the preview, to scroll to. */
export const documentAnchor = (documentId: string) => `sign-document-${documentId}`;

/** Widest a page is drawn, in pixels. */
const MAX_PAGE_WIDTH = 900;

let tempCounter = 0;
const tempId = () => `new_${++tempCounter}`;

function toDraft(fields: SignEnvelopeDetail['fields']): DraftField[] {
  return fields.map((f) => ({ ...f, label: f.label ?? null }));
}

/** The field set being edited, shared by the tools that change it and the pages that show it. */
export interface FieldEditor {
  envelope: SignEnvelopeDetail;
  target: SignTarget;
  editable: boolean;
  /** Editable and not saving: the field set is frozen while a save is in flight. */
  canEdit: boolean;
  fields: DraftField[];
  dirty: boolean;
  saving: boolean;
  signers: SignRecipientDto[];
  signerId: string | null;
  setSignerId: (id: string) => void;
  armed: SignFieldType | null;
  setArmed: (type: SignFieldType | null) => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  colorOf: (recipientId: string) => RecipientColor;
  place: (doc: SignDocumentDto, page: number, at: { x: number; y: number }) => void;
  updateField: (id: string, patch: Partial<DraftField>) => void;
  removeField: (id: string) => void;
  /** Saves the whole field set; rejects when the save fails (which is reported already). */
  save: () => Promise<void>;
}

/**
 * The fields of a request or template while they are placed. Changes stay local
 * until `save`, and are saved when the editor goes away.
 */
export function useFieldEditor(envelope: SignEnvelopeDetail, editable: boolean): FieldEditor {
  const { t } = useI18n();
  const target = targetOf(envelope);
  const saveFields = useSaveSignFields(target, (err) => toast.error(`${t.weldsign.editor.saveFailed}: ${apiErrorMessage(err)}`));

  const signers = envelope.recipientList.filter((r) => r.role === 'signer');
  const colorOf = useMemo(() => {
    const map = new Map(envelope.recipientList.map((r, i) => [r.id, recipientColor(i)]));
    return (recipientId: string) => map.get(recipientId) ?? recipientColor(0);
  }, [envelope.recipientList]);

  const [fields, setFields] = useState<DraftField[]>(() => toDraft(envelope.fields));
  const [dirty, setDirty] = useState(false);
  const [signerId, setSignerId] = useState<string | null>(signers[0]?.id ?? null);
  const [armed, setArmed] = useState<SignFieldType | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // While a save is in flight the field set is frozen: the save replaces the
  // list with the server's copy, which would drop anything changed meanwhile.
  const canEdit = editable && !saveFields.isPending;

  // Keep the active signer valid when recipients change.
  useEffect(() => {
    if (!signerId || !signers.some((s) => s.id === signerId)) setSignerId(signers[0]?.id ?? null);
  }, [signers, signerId]);

  // Removing a document or a recipient removes its fields on the server. Without
  // unsaved changes the server's set is taken over; with them, the fields that
  // lost their document or recipient are dropped.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!dirtyRef.current) {
      setFields(toDraft(envelope.fields));
      return;
    }
    const documents = new Set(envelope.documents.map((d) => d.id));
    const recipients = new Set(envelope.recipientList.map((r) => r.id));
    setFields((prev) => prev.filter((f) => documents.has(f.documentId) && recipients.has(f.recipientId)));
  }, [envelope.fields, envelope.documents, envelope.recipientList]);

  const change = useCallback((next: (prev: DraftField[]) => DraftField[]) => {
    setFields(next);
    setDirty(true);
  }, []);

  const persist = useCallback(
    (list: DraftField[]) =>
      saveFields.mutateAsync(list).then((saved) => {
        setFields(toDraft(saved));
        setDirty(false);
        setSelectedId(null);
      }),
    [saveFields],
  );

  // Save on the way out.
  const latest = useRef({ fields, dirty, editable });
  latest.current = { fields, dirty, editable };
  const saveRef = useRef(saveFields);
  saveRef.current = saveFields;
  useEffect(
    () => () => {
      const { fields: last, dirty: unsaved, editable: canSave } = latest.current;
      if (unsaved && canSave) saveRef.current.mutate(last);
    },
    [],
  );

  // Esc stops placing / deselects; Delete removes the selected field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName));
      if (e.key === 'Escape') {
        setArmed(null);
        setSelectedId(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && canEdit && !typing) {
        e.preventDefault();
        change((prev) => prev.filter((f) => f.id !== selectedId));
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, canEdit, change]);

  return {
    envelope,
    target,
    editable,
    canEdit,
    fields,
    dirty,
    saving: saveFields.isPending,
    signers,
    signerId,
    setSignerId,
    armed,
    setArmed,
    selectedId,
    setSelectedId,
    colorOf,
    place: (doc, page, at) => {
      if (!armed || !signerId) return;
      const box = placeField(armed, at, doc.pageSizes[page]!);
      const field: DraftField = { id: tempId(), documentId: doc.id, recipientId: signerId, type: armed, page, ...box, required: armed !== 'checkbox', label: null };
      change((prev) => [...prev, field]);
      setSelectedId(field.id);
    },
    updateField: (id, patch) => change((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f))),
    removeField: (id) => {
      change((prev) => prev.filter((f) => f.id !== id));
      setSelectedId(null);
    },
    save: () => persist(fields),
  };
}

/** The template editor's step: the tools on the left, the pages on the right. */
export function FieldsStep({ envelope, editable }: Readonly<{ envelope: SignEnvelopeDetail; editable: boolean }>) {
  const { t, format } = useI18n();
  const tf = t.weldsign.editor.fields;
  const editor = useFieldEditor(envelope, editable);

  if (envelope.documents.length === 0) return <Notice text={tf.needDocuments} />;
  if (editor.signers.length === 0) return <Notice text={envelope.kind === 'template' ? tf.needRoles : tf.needSigners} />;

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col gap-5 border-b p-4 lg:w-72 lg:overflow-y-auto lg:border-r lg:border-b-0">
        <FieldTools editor={editor} />

        {editable && (
          <div className="mt-auto flex flex-col gap-2">
            {editor.dirty && <p className="text-xs text-muted-foreground">{tf.unsaved}</p>}
            <Button
              size="sm"
              disabled={!editor.dirty || editor.saving}
              // The mutation's own onError reports the failure.
              onClick={() => editor.save().catch(() => undefined)}
            >
              {editor.saving ? <Loader2 className="animate-spin" /> : <Save />}
              {editor.saving ? t.weldsign.editor.saving : tf.save}
            </Button>
          </div>
        )}
      </aside>

      <div className="min-h-0 flex-1 overflow-auto bg-muted/40">
        {editor.armed && (
          <div className="sticky top-0 z-10 border-b bg-background/95 px-4 py-2 text-sm backdrop-blur">
            {format(tf.placing, { type: tf.types[editor.armed] })}
          </div>
        )}
        <div className="p-4 sm:p-8">
          <FieldPages editor={editor} />
        </div>
      </div>
    </div>
  );
}

/**
 * Who fills in the next field, the field types, and the selected field. In a
 * side panel (`panel`) the types sit two by two under the panel's own heading.
 */
export function FieldTools({ editor, panel = false }: Readonly<{ editor: FieldEditor; panel?: boolean }>) {
  const { t } = useI18n();
  const tf = t.weldsign.editor.fields;
  const { envelope, signers, editable, armed } = editor;
  const isTemplate = envelope.kind === 'template';

  if (envelope.documents.length === 0) return <p className="text-sm text-muted-foreground">{tf.needDocuments}</p>;
  if (signers.length === 0) return <p className="text-sm text-muted-foreground">{isTemplate ? tf.needRoles : tf.needSigners}</p>;

  const selected = editor.fields.find((f) => f.id === editor.selectedId) ?? null;

  return (
    <>
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{isTemplate ? tf.role : tf.signer}</h3>
        {signers.map((signer) => (
          <SignerButton
            key={signer.id}
            label={recipientLabel(signer, envelope.kind)}
            color={editor.colorOf(signer.id)}
            active={signer.id === editor.signerId}
            onClick={() => editor.setSignerId(signer.id)}
          />
        ))}
      </section>

      {editable && (
        <section className="flex flex-col gap-2">
          {!panel && <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tf.fieldTypes}</h3>}
          <div className={cn('grid grid-cols-2 gap-2', !panel && 'lg:grid-cols-1')}>
            {SIGN_FIELD_TYPES.map((type) => {
              const Icon = FIELD_ICONS[type];
              return (
                <button
                  key={type}
                  type="button"
                  aria-pressed={armed === type}
                  onClick={() => editor.setArmed(armed === type ? null : type)}
                  className={cn(
                    'flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                    armed === type ? 'border-primary bg-primary/10 text-foreground' : 'hover:bg-muted',
                  )}
                >
                  <Icon className="size-4 text-muted-foreground" />
                  {tf.types[type]}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {selected && (
        <SelectedFieldPanel
          field={selected}
          signers={signers}
          kind={envelope.kind}
          editable={editor.canEdit}
          onChange={(patch) => editor.updateField(selected.id, patch)}
          onDelete={() => editor.removeField(selected.id)}
        />
      )}
    </>
  );
}

/** Every document's pages, with the fields on top: click to place, drag to move. */
export function FieldPages({ editor }: Readonly<{ editor: FieldEditor }>) {
  return (
    <div className="flex flex-col items-center gap-8">
      {editor.envelope.documents.map((doc) => (
        <DocumentPages
          key={doc.id}
          target={editor.target}
          doc={doc}
          fields={editor.fields.filter((f) => f.documentId === doc.id)}
          colorOf={editor.colorOf}
          selectedId={editor.selectedId}
          placing={editor.canEdit && editor.armed !== null && editor.signerId !== null}
          editable={editor.canEdit}
          onPlace={(page, at) => editor.place(doc, page, at)}
          onSelect={editor.setSelectedId}
          onBoxChange={(id, box) => editor.updateField(id, box)}
        />
      ))}
    </div>
  );
}

function Notice({ text }: Readonly<{ text: string }>) {
  return <div className="p-10 text-center text-sm text-muted-foreground">{text}</div>;
}

function SignerButton({ label, color, active, onClick }: Readonly<{ label: string; color: RecipientColor; active: boolean; onClick: () => void }>) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn('flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors', active ? 'bg-muted' : 'hover:bg-muted/60')}
      style={active ? { borderColor: color.border } : undefined}
    >
      <span className={cn('size-2.5 shrink-0 rounded-full', color.chip)} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function SelectedFieldPanel({
  field,
  signers,
  kind,
  editable,
  onChange,
  onDelete,
}: Readonly<{
  field: DraftField;
  signers: SignRecipientDto[];
  kind: SignEnvelopeDetail['kind'];
  editable: boolean;
  onChange: (patch: Partial<DraftField>) => void;
  onDelete: () => void;
}>) {
  const { t } = useI18n();
  const tf = t.weldsign.editor.fields;
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-3">
      <h3 className="text-sm font-medium">
        {tf.selected}: {tf.types[field.type]}
      </h3>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">{tf.assignedTo}</span>
        <Select value={field.recipientId} disabled={!editable} onValueChange={(recipientId) => onChange({ recipientId })}>
          <SelectTrigger aria-label={tf.assignedTo} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {signers.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {recipientLabel(s, kind)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <label className="flex items-center justify-between gap-2 text-sm">
        {tf.required}
        <Switch checked={field.required} disabled={!editable} onCheckedChange={(required) => onChange({ required })} />
      </label>
      {(field.type === 'text' || field.type === 'checkbox') && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`field-label-${field.id}`} className="text-xs">
            {tf.label}
          </Label>
          <Input
            id={`field-label-${field.id}`}
            value={field.label ?? ''}
            maxLength={255}
            disabled={!editable}
            placeholder={tf.labelPlaceholder}
            onChange={(e) => onChange({ label: e.target.value || null })}
          />
        </div>
      )}
      {editable && (
        <Button variant="outline" size="sm" onClick={onDelete}>
          <Trash2 />
          {tf.delete}
        </Button>
      )}
    </section>
  );
}

/** All pages of one document, with its fields on top. */
function DocumentPages({
  target,
  doc,
  fields,
  colorOf,
  selectedId,
  placing,
  editable,
  onPlace,
  onSelect,
  onBoxChange,
}: Readonly<{
  target: SignTarget;
  doc: SignDocumentDto;
  fields: DraftField[];
  colorOf: (recipientId: string) => RecipientColor;
  selectedId: string | null;
  placing: boolean;
  editable: boolean;
  onPlace: (page: number, at: { x: number; y: number }) => void;
  onSelect: (id: string | null) => void;
  onBoxChange: (id: string, box: Box) => void;
}>) {
  const { t, format } = useI18n();
  const tf = t.weldsign.editor.fields;
  const content = useSignDocumentContent(target, doc.id);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(MAX_PAGE_WIDTH);

  useEffect(() => {
    if (!content.data) return;
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    openPdf(content.data).then(
      (doc) => {
        opened = doc;
        if (cancelled) void doc.destroy();
        else setPdf(doc);
      },
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
      void opened?.destroy();
    };
  }, [content.data]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.min(entry!.contentRect.width, MAX_PAGE_WIDTH)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={containerRef} id={documentAnchor(doc.id)} className="flex w-full max-w-[900px] scroll-mt-6 flex-col items-center gap-4">
      <h3 className="self-start text-sm font-medium">{doc.name}</h3>
      {(content.isError || failed) && <p className="text-sm text-destructive">{format(tf.documentFailed, { name: doc.name })}</p>}
      {!pdf && !content.isError && !failed && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {format(tf.loadingDocument, { name: doc.name })}
        </p>
      )}
      {doc.pageSizes.map((size, pageIndex) => {
        const scale = scaleFor(size.width, width);
        return (
          <div key={pageIndex} className="flex flex-col items-center gap-1">
            <PdfPage pdf={pdf} pageIndex={pageIndex} size={size} scale={scale}>
              <div
                className={cn('absolute inset-0', placing && 'cursor-crosshair')}
                onPointerDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (placing) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    onPlace(pageIndex, pointOnPage(e.clientX - rect.left, e.clientY - rect.top, scale));
                  } else onSelect(null);
                }}
              >
                {fields
                  .filter((f) => f.page === pageIndex)
                  .map((field) => (
                    <FieldBox
                      key={field.id}
                      field={field}
                      scale={scale}
                      color={colorOf(field.recipientId)}
                      selected={field.id === selectedId}
                      editable={editable}
                      label={tf.types[field.type]}
                      onSelect={() => onSelect(field.id)}
                      page={size}
                      onBoxChange={(box) => onBoxChange(field.id, box)}
                    />
                  ))}
              </div>
            </PdfPage>
            <span className="text-xs text-muted-foreground">{format(tf.page, { page: pageIndex + 1 })}</span>
          </div>
        );
      })}
    </section>
  );
}

/** A field on the page; drag to move, drag the corner to resize. */
function FieldBox({
  field,
  page,
  scale,
  color,
  selected,
  editable,
  label,
  onSelect,
  onBoxChange,
}: Readonly<{
  field: DraftField;
  page: SignPageSize;
  scale: number;
  color: RecipientColor;
  selected: boolean;
  editable: boolean;
  label: string;
  onSelect: () => void;
  onBoxChange: (box: Box) => void;
}>) {
  const Icon = FIELD_ICONS[field.type];

  /**
   * Pointer drag: every move is applied to the box as it was when the pointer
   * went down, so the field follows the pointer exactly.
   */
  const drag = (mode: 'move' | 'resize') => (e: ReactPointerEvent<HTMLElement>) => {
    if (!editable || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    const start: Box = { x: field.x, y: field.y, width: field.width, height: field.height };
    const startX = e.clientX;
    const startY = e.clientY;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const onPointerMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      onBoxChange(mode === 'move' ? moveBox(start, dx, dy, scale, page) : resizeBox(start, dx, dy, scale, page));
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    };
    target.addEventListener('pointermove', onPointerMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected}
      onPointerDown={drag('move')}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
      className={cn(
        'absolute flex touch-none select-none items-center gap-1 overflow-hidden rounded-sm border-2 px-1 text-[11px] font-medium',
        editable && 'cursor-move',
      )}
      style={{
        left: field.x * scale,
        top: field.y * scale,
        width: field.width * scale,
        height: field.height * scale,
        borderColor: color.border,
        background: color.fill,
        color: color.border,
        boxShadow: selected ? `0 0 0 2px ${color.border}55` : undefined,
      }}
    >
      {field.type !== 'checkbox' && field.height * scale >= 14 && (
        <>
          <Icon className="size-3 shrink-0" />
          <span className="truncate">{field.label || label}</span>
        </>
      )}
      {selected && editable && (
        <span
          aria-hidden
          onPointerDown={drag('resize')}
          className="absolute right-0 bottom-0 size-3 cursor-se-resize rounded-tl-sm border-t-2 border-l-2 bg-white"
          style={{ borderColor: color.border }}
        />
      )}
    </div>
  );
}
