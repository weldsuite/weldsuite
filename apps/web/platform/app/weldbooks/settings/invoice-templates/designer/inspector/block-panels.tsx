/** Per-type settings of the block inspector (everything except the line-items table). */
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Braces, ImageUp, Loader2 } from 'lucide-react';
import { TEMPLATE_FIELDS, type BlockOf, type TemplateBlockType, type TemplateField } from '@weldsuite/books-domain/invoice-template/schema';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { useI18n } from '@/lib/i18n/provider';
import { useDesigner } from '../context';
import { isPlaceholderImage } from '../model/block-factory';
import { mergeStyle } from '../model/colors';
import { TEMPLATE_IMAGE_ACCEPT } from '../use-image-upload';
import { AlignControl, ColorControl, Field, InspectorSection, LabelControls, NumberInput, Note, SwitchField, TextStyleControls } from './controls';

export type Patch = Record<string, unknown>;

type P<T extends TemplateBlockType> = {
  block: BlockOf<T>;
  update: (patch: Patch) => void;
};

const IMAGE_URL = /^(https?:\/\/|data:image\/(png|jpeg);base64,)/i;

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function TextPanel({ block, update }: Readonly<P<'text'>>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceTemplates.inspector;
  const { fieldNames, readOnly } = useDesigner();
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  const insert = (field: TemplateField) => {
    const el = ref.current;
    const start = el?.selectionStart ?? block.text.length;
    const end = el?.selectionEnd ?? start;
    const token = `{{${field}}}`;
    update({ text: block.text.slice(0, start) + token + block.text.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <InspectorSection title={ti.text.content}>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={id} className="text-xs text-muted-foreground">
            {ti.text.content}
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="xs" disabled={readOnly}>
                <Braces aria-hidden />
                {ti.text.insertField}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-auto">
              {TEMPLATE_FIELDS.map((field) => (
                <DropdownMenuItem key={field} onSelect={() => insert(field)}>
                  {fieldNames[field]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Textarea
          id={id}
          ref={ref}
          rows={4}
          maxLength={5000}
          value={block.text}
          disabled={readOnly}
          className="min-h-20 resize-y text-sm"
          onChange={(e) => update({ text: e.target.value })}
        />
        <p className="text-[11px] leading-snug text-muted-foreground">{ti.text.hint}</p>
      </div>
      <TextStyleControls value={block.style} onChange={(style) => update({ style })} />
    </InspectorSection>
  );
}

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

export function FieldPanel({ block, update }: Readonly<P<'field'>>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceTemplates.inspector;
  const { fieldNames, readOnly } = useDesigner();
  const layout = block.layout ?? 'stacked';
  return (
    <InspectorSection title={ti.field.field}>
      <Field label={ti.field.field}>
        <Select value={block.field} disabled={readOnly} onValueChange={(field) => update({ field })}>
          <SelectTrigger className="h-8 w-full text-sm" aria-label={ti.field.field}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TEMPLATE_FIELDS.map((field) => (
              <SelectItem key={field} value={field}>
                {fieldNames[field]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label={ti.field.layout}>
        <Select value={layout} disabled={readOnly} onValueChange={(next) => update({ layout: next === 'stacked' ? undefined : next })}>
          <SelectTrigger className="h-8 w-full text-sm" aria-label={ti.field.layout}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stacked">{ti.field.layouts.stacked}</SelectItem>
            <SelectItem value="inline">{ti.field.layouts.inline}</SelectItem>
            <SelectItem value="value">{ti.field.layouts.value}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {layout !== 'value' ? <LabelControls value={block.label} onChange={(label) => update({ label })} /> : null}
      <TextStyleControls value={block.style} onChange={(style) => update({ style })} />
    </InspectorSection>
  );
}

// ---------------------------------------------------------------------------
// Logo and image
// ---------------------------------------------------------------------------

export function LogoPanel({ block, update }: Readonly<P<'logo'>>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceTemplates.inspector;
  return (
    <InspectorSection title={ti.logo.align}>
      <Field label={ti.logo.align}>
        <AlignControl value={block.align} onChange={(align) => update({ align })} aria-label={ti.logo.align} />
      </Field>
      <Note>{ti.logo.note}</Note>
      <TextStyleControls
        title={ti.logo.fallback}
        value={block.fallbackStyle}
        onChange={(fallbackStyle) => update({ fallbackStyle })}
      />
    </InspectorSection>
  );
}

export function ImagePanel({ block, update }: Readonly<P<'image'>>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceTemplates.inspector;
  const { uploadImage, readOnly } = useDesigner();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const id = useId();

  const isPlaceholder = isPlaceholderImage(block.src);
  const shownUrl = url ?? (isPlaceholder ? '' : block.src);
  const invalid = url !== null && url.trim() !== '' && !IMAGE_URL.test(url.trim());

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      update({ src: await uploadImage(file) });
      setUrl(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : ti.branding.uploadFailed);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <InspectorSection title={ti.image.title}>
      <input
        ref={fileRef}
        type="file"
        accept={TEMPLATE_IMAGE_ACCEPT}
        className="hidden"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        disabled={readOnly || uploading}
        onClick={() => fileRef.current?.click()}
      >
        {uploading ? <Loader2 className="animate-spin" aria-hidden /> : <ImageUp aria-hidden />}
        {uploading ? ti.branding.uploading : isPlaceholder ? ti.image.upload : ti.image.replace}
      </Button>
      <Field label={ti.image.url} htmlFor={id} hint={invalid ? undefined : ti.image.help}>
        <Input
          id={id}
          value={shownUrl}
          placeholder={ti.image.urlPlaceholder}
          disabled={readOnly}
          aria-invalid={invalid || undefined}
          className="h-8 text-sm"
          onChange={(e) => {
            setUrl(e.target.value);
            if (IMAGE_URL.test(e.target.value.trim())) update({ src: e.target.value.trim() });
          }}
          onBlur={() => setUrl(null)}
        />
        {invalid ? <p className="text-[11px] text-destructive">{ti.image.help}</p> : null}
      </Field>
      <Field label={ti.image.align}>
        <AlignControl value={block.align} onChange={(align) => update({ align })} aria-label={ti.image.align} />
      </Field>
    </InspectorSection>
  );
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

export function PartyPanel({ block, update }: Readonly<P<'seller' | 'billTo' | 'shipTo'>>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceTemplates.inspector;
  return (
    <InspectorSection title={t.accounting.invoiceTemplates.blocks[block.type]}>
      <LabelControls value={block.label} onChange={(label) => update({ label })} />
      <SwitchField label={ti.party.boldName} checked={block.boldName !== false} onChange={(v) => update({ boldName: v ? undefined : false })} />
      <SwitchField label={ti.party.inline} checked={Boolean(block.inline)} onChange={(v) => update({ inline: v || undefined })} />
      {block.type === 'seller' ? (
        <>
          <SwitchField label={ti.party.showContact} checked={block.showContact !== false} onChange={(v) => update({ showContact: v ? undefined : false })} />
          <SwitchField label={ti.party.showTaxIds} checked={block.showTaxIds !== false} onChange={(v) => update({ showTaxIds: v ? undefined : false })} />
        </>
      ) : null}
      {block.type === 'billTo' ? (
        <SwitchField label={ti.party.showEmail} checked={block.showEmail !== false} onChange={(v) => update({ showEmail: v ? undefined : false })} />
      ) : null}
      <TextStyleControls value={block.style} onChange={(style) => update({ style })} />
    </InspectorSection>
  );
}

// ---------------------------------------------------------------------------
// Totals, payment, notes, terms, legal
// ---------------------------------------------------------------------------

export function TotalsPanel({ block, update }: Readonly<P<'totals'>>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceTemplates.inspector;
  const id = useId();
  const setTotal = (patch: Partial<{ fontSize: number | undefined; color: string | undefined; background: string | undefined; rule: string | undefined }>) =>
    update({ total: mergeStyle(block.total, patch as never) });
  return (
    <>
      <InspectorSection title={t.accounting.invoiceTemplates.blocks.totals}>
        <SwitchField label={ti.totals.showBalance} checked={block.showBalance !== false} onChange={(v) => update({ showBalance: v ? undefined : false })} />
        <TextStyleControls value={block.style} onChange={(style) => update({ style })} />
      </InspectorSection>
      <InspectorSection title={ti.totals.totalRow}>
        <div className="grid grid-cols-2 gap-2">
          <Field label={ti.totals.size} htmlFor={`${id}-size`}>
            <NumberInput
              id={`${id}-size`}
              value={block.total?.fontSize}
              min={5}
              max={36}
              step={0.5}
              suffix="pt"
              placeholder="11"
              onChange={(n) => setTotal({ fontSize: n })}
              onClear={() => setTotal({ fontSize: undefined })}
            />
          </Field>
          <Field label={ti.totals.color}>
            <ColorControl
              value={block.total?.color}
              emptyLabel={ti.colors.text}
              emptyColor="text"
              onChange={(color) => setTotal({ color })}
            />
          </Field>
        </div>
        <Field label={ti.totals.background}>
          <ColorControl value={block.total?.background} emptyLabel={ti.colors.none} onChange={(background) => setTotal({ background })} />
        </Field>
        <Field label={ti.totals.rule}>
          <ColorControl
            value={block.total?.rule}
            emptyLabel={ti.colors.accent}
            emptyColor="accent"
            onChange={(rule) => setTotal({ rule })}
          />
        </Field>
      </InspectorSection>
    </>
  );
}

export function PaymentPanel({ block, update }: Readonly<P<'payment'>>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceTemplates.inspector;
  return (
    <InspectorSection title={t.accounting.invoiceTemplates.blocks.payment}>
      <LabelControls value={block.label} onChange={(label) => update({ label })} />
      <SwitchField label={ti.payment.showBank} checked={block.showBank !== false} onChange={(v) => update({ showBank: v ? undefined : false })} />
      <SwitchField label={ti.payment.showInstructions} checked={block.showInstructions !== false} onChange={(v) => update({ showInstructions: v ? undefined : false })} />
      <TextStyleControls value={block.style} onChange={(style) => update({ style })} />
    </InspectorSection>
  );
}

export function NotesPanel({ block, update }: Readonly<P<'notes'>>) {
  const { t } = useI18n();
  return (
    <InspectorSection title={t.accounting.invoiceTemplates.blocks.notes}>
      <LabelControls value={block.label} onChange={(label) => update({ label })} />
      <TextStyleControls value={block.style} onChange={(style) => update({ style })} />
    </InspectorSection>
  );
}

export function TermsPanel({ block, update }: Readonly<P<'terms'>>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceTemplates.inspector;
  const { readOnly } = useDesigner();
  const id = useId();
  return (
    <InspectorSection title={t.accounting.invoiceTemplates.blocks.terms}>
      <LabelControls value={block.label} onChange={(label) => update({ label })} />
      <Field label={ti.terms.override} htmlFor={id}>
        <Textarea
          id={id}
          rows={4}
          maxLength={5000}
          value={block.text ?? ''}
          placeholder={ti.terms.placeholder}
          disabled={readOnly}
          className="min-h-20 resize-y text-sm"
          onChange={(e) => update({ text: e.target.value === '' ? undefined : e.target.value })}
        />
      </Field>
      <TextStyleControls value={block.style} onChange={(style) => update({ style })} />
    </InspectorSection>
  );
}

export function LegalPanel({ block, update }: Readonly<P<'legal'>>) {
  const { t } = useI18n();
  return (
    <InspectorSection title={t.accounting.invoiceTemplates.blocks.legal}>
      <Note>{t.accounting.invoiceTemplates.inspector.legal.note}</Note>
      <TextStyleControls value={block.style} onChange={(style) => update({ style })} />
    </InspectorSection>
  );
}

// ---------------------------------------------------------------------------
// Shapes and page number
// ---------------------------------------------------------------------------

export function RectPanel() {
  const { t } = useI18n();
  return (
    <InspectorSection title={t.accounting.invoiceTemplates.blocks.rect}>
      <Note>{t.accounting.invoiceTemplates.inspector.rect.note}</Note>
    </InspectorSection>
  );
}

export function LinePanel({ block, update }: Readonly<P<'line'>>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceTemplates.inspector;
  const { readOnly } = useDesigner();
  const orientation = block.orientation ?? 'horizontal';

  const setOrientation = (next: 'horizontal' | 'vertical') => {
    if (next === orientation) return;
    // Turn the box a quarter: the long side becomes the short one.
    update(next === 'vertical' ? { orientation: next, w: 2, h: Math.max(4, block.w) } : { orientation: undefined, w: Math.max(4, block.h), h: 1 });
  };

  return (
    <InspectorSection title={t.accounting.invoiceTemplates.blocks.line}>
      <Field label={ti.line.color}>
        <ColorControl value={block.color} emptyLabel={ti.colors.muted} emptyColor="muted" onChange={(color) => update({ color })} />
      </Field>
      <Field label={ti.line.thickness}>
        <NumberInput
          value={block.thickness}
          placeholder="1"
          min={0.25}
          max={10}
          step={0.25}
          suffix="pt"
          onChange={(n) => update({ thickness: n })}
          onClear={() => update({ thickness: undefined })}
        />
      </Field>
      <Field label={ti.line.orientation}>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={orientation}
          disabled={readOnly}
          aria-label={ti.line.orientation}
          onValueChange={(v) => {
            if (v) setOrientation(v as 'horizontal' | 'vertical');
          }}
          className="w-full"
        >
          <ToggleGroupItem value="horizontal" className="flex-1">
            {ti.line.horizontal}
          </ToggleGroupItem>
          <ToggleGroupItem value="vertical" className="flex-1">
            {ti.line.vertical}
          </ToggleGroupItem>
        </ToggleGroup>
      </Field>
    </InspectorSection>
  );
}

export function PageNumberPanel({ block, update }: Readonly<P<'pageNumber'>>) {
  const { t } = useI18n();
  return (
    <InspectorSection title={t.accounting.invoiceTemplates.blocks.pageNumber}>
      <Note>{t.accounting.invoiceTemplates.inspector.pageNumber.note}</Note>
      <TextStyleControls value={block.style} onChange={(style) => update({ style })} />
    </InspectorSection>
  );
}
