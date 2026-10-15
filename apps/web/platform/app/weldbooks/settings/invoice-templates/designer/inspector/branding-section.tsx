/** Company branding: the entity's logo, colours and standard texts, shared by every template of the company. */
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ImageUp, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { AccountingEntity } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { useDesigner } from '../context';
import { TEMPLATE_IMAGE_ACCEPT } from '../use-image-upload';
import { ColorControl, Field, InspectorSection, Note } from './controls';

export type EntityBranding = NonNullable<AccountingEntity['branding']>;

interface BrandingSectionProps {
  value: EntityBranding;
  dirty: boolean;
  saving: boolean;
  /** The viewer may change the company (needs `entities:update`). */
  canEdit: boolean;
  onChange: (patch: Partial<{ [K in keyof EntityBranding]: EntityBranding[K] | undefined }>) => void;
  onSave: () => void;
  onDiscard: () => void;
}

export function BrandingSection({ value, dirty, saving, canEdit, onChange, onSave, onDiscard }: Readonly<BrandingSectionProps>) {
  const { t } = useI18n();
  const tb = t.accounting.invoiceTemplates.inspector.branding;
  const { uploadImage } = useDesigner();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const id = useId();

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      onChange({ logoUrl: await uploadImage(file) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tb.uploadFailed);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const textField = (key: 'footerText' | 'paymentInstructions' | 'termsAndConditions', label: string, rows: number) => (
    <Field label={label} htmlFor={`${id}-${key}`}>
      <Textarea
        id={`${id}-${key}`}
        rows={rows}
        value={value[key] ?? ''}
        disabled={!canEdit}
        className="min-h-16 resize-y text-sm"
        onChange={(e) => onChange({ [key]: e.target.value === '' ? undefined : e.target.value })}
      />
    </Field>
  );

  return (
    <InspectorSection title={tb.title}>
      <Note>{tb.shared}</Note>
      {canEdit ? null : <p className="text-xs text-muted-foreground">{tb.readOnly}</p>}

      <Field label={tb.logo} hint={tb.logoHelp}>
        <input
          ref={fileRef}
          type="file"
          accept={TEMPLATE_IMAGE_ACCEPT}
          className="hidden"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        {value.logoUrl ? (
          <div className="flex h-20 items-center justify-center rounded-md border border-border bg-white p-2">
            <img src={value.logoUrl} alt="" className="max-h-full max-w-full object-contain" />
          </div>
        ) : null}
        <div className="flex gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1 shadow-none"
            disabled={!canEdit || uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? <Loader2 className="animate-spin" aria-hidden /> : <ImageUp aria-hidden />}
            {uploading ? tb.uploading : value.logoUrl ? tb.replaceLogo : tb.uploadLogo}
          </Button>
          {value.logoUrl ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shadow-none"
              disabled={!canEdit || uploading}
              onClick={() => onChange({ logoUrl: undefined })}
            >
              <Trash2 aria-hidden />
              {tb.removeLogo}
            </Button>
          ) : null}
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label={tb.primaryColor}>
          <ColorControl
            tokens={false}
            emptyLabel={t.accounting.invoiceTemplates.inspector.colors.none}
            value={value.primaryColor}
            disabled={!canEdit}
            onChange={(c) => onChange({ primaryColor: c })}
          />
        </Field>
        <Field label={tb.accentColor}>
          <ColorControl
            tokens={false}
            emptyLabel={t.accounting.invoiceTemplates.inspector.colors.none}
            value={value.accentColor}
            disabled={!canEdit}
            onChange={(c) => onChange({ accentColor: c })}
          />
        </Field>
      </div>

      {textField('footerText', tb.footerText, 2)}
      {textField('paymentInstructions', tb.paymentInstructions, 3)}
      {textField('termsAndConditions', tb.terms, 4)}

      {dirty ? (
        <div className="flex gap-1.5 pt-1">
          <Button type="button" size="sm" className="flex-1" disabled={!canEdit || saving || uploading} onClick={onSave}>
            {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {saving ? tb.saving : tb.save}
          </Button>
          <Button type="button" variant="outline" size="sm" className="shadow-none" disabled={saving} onClick={onDiscard}>
            {tb.discard}
          </Button>
        </div>
      ) : null}
    </InspectorSection>
  );
}
