/** The right-hand panel when nothing is selected: theme, margins, presets and the company branding. */
import { useId, useState, type Dispatch } from 'react';
import { LayoutTemplate } from 'lucide-react';
import { TEMPLATE_PRESETS, presetTemplate, type TemplatePreset } from '@weldsuite/books-domain/invoice-template/presets';
import { TEMPLATE_FONTS, type InvoiceTemplateDocument, type TemplateFont } from '@weldsuite/books-domain/invoice-template/schema';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { useDesigner } from '../context';
import type { EditorAction } from '../model/editor-reducer';
import { BrandingSection, type EntityBranding } from './branding-section';
import { ColorControl, Field, InspectorSection, NumberInput } from './controls';

interface DocumentInspectorProps {
  doc: InvoiceTemplateDocument;
  dispatch: Dispatch<EditorAction>;
  branding: {
    value: EntityBranding;
    dirty: boolean;
    saving: boolean;
    canEdit: boolean;
    onChange: (patch: Partial<{ [K in keyof EntityBranding]: EntityBranding[K] | undefined }>) => void;
    onSave: () => void;
    onDiscard: () => void;
  };
}

export function DocumentInspector({ doc, dispatch, branding }: Readonly<DocumentInspectorProps>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceTemplates;
  const tn = ti.inspector;
  const { readOnly } = useDesigner();
  const [pendingPreset, setPendingPreset] = useState<TemplatePreset | null>(null);
  const id = useId();

  const setTheme = (patch: Partial<InvoiceTemplateDocument['theme']>, key: string) =>
    dispatch({ type: 'updateDoc', update: (d) => ({ ...d, theme: { ...d.theme, ...patch } }), coalesce: `doc:theme.${key}` });
  const setMargin = (patch: Partial<InvoiceTemplateDocument['margins']>, key: string) =>
    dispatch({ type: 'updateDoc', update: (d) => ({ ...d, margins: { ...d.margins, ...patch } }), coalesce: `doc:margins.${key}` });

  return (
    <div>
      <div className="space-y-1 border-b border-border px-4 py-4">
        <h2 className="text-sm font-semibold">{tn.document}</h2>
        <p className="text-xs text-muted-foreground">{tn.noSelection}</p>
      </div>

      <InspectorSection title={tn.theme}>
        <Field label={tn.font}>
          <Select value={doc.theme.font} disabled={readOnly} onValueChange={(font) => setTheme({ font: font as TemplateFont }, 'font')}>
            <SelectTrigger className="h-8 w-full text-sm" aria-label={tn.font}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEMPLATE_FONTS.map((font) => (
                <SelectItem key={font} value={font}>
                  {tn.fonts[font]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={tn.accent}>
          <ColorControl tokens={false} value={doc.theme.accent} onChange={(c) => c && setTheme({ accent: c }, 'accent')} aria-label={tn.accent} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={tn.textColor}>
            <ColorControl tokens={false} value={doc.theme.text} onChange={(c) => c && setTheme({ text: c }, 'text')} aria-label={tn.textColor} />
          </Field>
          <Field label={tn.mutedColor}>
            <ColorControl tokens={false} value={doc.theme.muted} onChange={(c) => c && setTheme({ muted: c }, 'muted')} aria-label={tn.mutedColor} />
          </Field>
        </div>
        <Field label={tn.baseFontSize} htmlFor={`${id}-size`}>
          <NumberInput
            id={`${id}-size`}
            value={doc.theme.fontSize}
            min={6}
            max={14}
            step={0.5}
            suffix={tn.pt}
            disabled={readOnly}
            onChange={(fontSize) => setTheme({ fontSize }, 'fontSize')}
          />
        </Field>
      </InspectorSection>

      <InspectorSection title={tn.page}>
        <div className="grid grid-cols-2 gap-2">
          <Field label={tn.marginTop} htmlFor={`${id}-mt`}>
            <NumberInput id={`${id}-mt`} value={doc.margins.top} min={0} max={300} suffix={tn.pt} disabled={readOnly} onChange={(top) => setMargin({ top }, 'top')} />
          </Field>
          <Field label={tn.marginBottom} htmlFor={`${id}-mb`}>
            <NumberInput id={`${id}-mb`} value={doc.margins.bottom} min={0} max={300} suffix={tn.pt} disabled={readOnly} onChange={(bottom) => setMargin({ bottom }, 'bottom')} />
          </Field>
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">{tn.marginHint}</p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="w-full shadow-none" disabled={readOnly}>
              <LayoutTemplate aria-hidden />
              {tn.replacePreset}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {TEMPLATE_PRESETS.map((preset) => (
              <DropdownMenuItem key={preset} onSelect={() => setPendingPreset(preset)}>
                {ti.newDialog.presets[preset].name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </InspectorSection>

      <BrandingSection {...branding} />

      <ConfirmDialog
        open={pendingPreset !== null}
        onOpenChange={(open) => {
          if (!open) setPendingPreset(null);
        }}
        title={tn.replaceTitle}
        description={tn.replaceDescription.replace('{preset}', pendingPreset ? ti.newDialog.presets[pendingPreset].name : '')}
        confirmLabel={tn.replaceConfirm}
        cancelLabel={tn.cancel}
        onConfirm={() => {
          if (pendingPreset) dispatch({ type: 'replaceDoc', doc: presetTemplate(pendingPreset, doc.paperSize, doc.theme.accent) });
          setPendingPreset(null);
        }}
      />
    </div>
  );
}
