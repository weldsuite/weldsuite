/**
 * The parts of the "Create labels" form: the notice without a carrier, the
 * pieces, the options, customs and the price on WeldSuite's contract.
 */

import type { Control, UseFieldArrayReturn } from 'react-hook-form';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { DialogFooter } from '@weldsuite/ui/components/dialog';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { CUSTOMS_CONTENT_TYPES } from '@weldsuite/app-api-client/schemas/shipping';
import { getTranslations } from '@/lib/i18n';
import { useRouter } from '@/lib/router';
import { emptyCustomsLine, emptyPiece, type BOOLEAN_OPTION_KEYS, type LabelsFormValues } from '../lib/labels-form';
import { CheckboxField, SelectField, TextField } from './form-fields';

type FormControl = Control<LabelsFormValues>;
type OptionKey = (typeof BOOLEAN_OPTION_KEYS)[number];

export function Section({ legend, children }: Readonly<{ legend: string; children: React.ReactNode }>) {
  return (
    <fieldset className="space-y-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">{legend}</legend>
      {children}
    </fieldset>
  );
}

/** No active carrier account: a link to Settings > Apps > WeldStash. */
export function NoCarriers({ onCancel }: Readonly<{ onCancel: () => void }>) {
  const t = getTranslations('weldstash').shipping.labels;
  const router = useRouter();

  const openSettings = () => {
    try {
      sessionStorage.setItem('settings-return-url', window.location.pathname);
    } catch {
      // Private mode: the Settings back button then goes to its default.
    }
    router.push('/settings/apps/weldstash');
  };

  return (
    <div className="space-y-4">
      <InfoBanner
        variant="warning"
        title={t.noCarrierTitle}
        action={
          <Button type="button" size="sm" variant="outline" onClick={openSettings}>
            {t.noCarrierLink}
          </Button>
        }
      >
        {t.noCarrierBody}
      </InfoBanner>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t.close}
        </Button>
      </DialogFooter>
    </div>
  );
}

interface PiecesSectionProps {
  control: FormControl;
  pieces: UseFieldArrayReturn<LabelsFormValues, 'pieces'>;
  multiCollo: boolean;
}

export function PiecesSection({ control, pieces, multiCollo }: Readonly<PiecesSectionProps>) {
  const t = getTranslations('weldstash').shipping.labels;
  const removable = pieces.fields.length > 1;
  return (
    <Section legend={t.pieces}>
      <p className="text-sm text-muted-foreground">{t.dimensionsHint}</p>
      {pieces.fields.map((field, index) => {
        const number = String(index + 1);
        return (
          <div key={field.id} className="grid grid-cols-2 items-end gap-3 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
            <TextField control={control} name={`pieces.${index}.weightKg`} label={`${t.piece.replace('{number}', number)}: ${t.weightKg}`} inputMode="decimal" required />
            <TextField control={control} name={`pieces.${index}.lengthCm`} label={t.lengthCm} inputMode="decimal" />
            <TextField control={control} name={`pieces.${index}.widthCm`} label={t.widthCm} inputMode="decimal" />
            <TextField control={control} name={`pieces.${index}.heightCm`} label={t.heightCm} inputMode="decimal" />
            {removable ? (
              <Button type="button" variant="ghost" size="icon" onClick={() => pieces.remove(index)} aria-label={t.removePiece.replace('{number}', number)}>
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        );
      })}
      {multiCollo ? (
        <Button type="button" size="sm" variant="outline" onClick={() => pieces.append(emptyPiece())}>
          <Plus className="size-4" aria-hidden="true" />
          {t.addPiece}
        </Button>
      ) : null}
    </Section>
  );
}

interface OptionsSectionProps {
  control: FormControl;
  optionKeys: OptionKey[];
  insurance: boolean;
  showReturn: boolean;
}

/** The product's options; nothing when the product has none. */
export function OptionsSection({ control, optionKeys, insurance, showReturn }: Readonly<OptionsSectionProps>) {
  const ts = getTranslations('weldstash').shipping;
  const t = ts.labels;
  if (optionKeys.length === 0 && !insurance && !showReturn) return null;
  return (
    <Section legend={t.options}>
      <div className="grid gap-2 sm:grid-cols-2">
        {optionKeys.map((key) => (
          <CheckboxField key={key} control={control} name={key} label={ts.options[key]} />
        ))}
        {showReturn ? <CheckboxField control={control} name="returnLabel" label={t.returnLabel} /> : null}
      </div>
      {insurance ? <TextField className="max-w-48" control={control} name="insuredValue" label={t.insuredValue} inputMode="decimal" /> : null}
    </Section>
  );
}

interface CustomsSectionProps {
  control: FormControl;
  lines: UseFieldArrayReturn<LabelsFormValues, 'customs.lines'>;
}

export function CustomsSection({ control, lines }: Readonly<CustomsSectionProps>) {
  const ts = getTranslations('weldstash').shipping;
  const t = ts.labels;
  const contentOptions = CUSTOMS_CONTENT_TYPES.map((c) => ({ value: c, label: ts.customsContent[c] }));
  const removable = lines.fields.length > 1;
  return (
    <Section legend={t.customs}>
      <p className="text-sm text-muted-foreground">{t.customsHint}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField control={control} name="customs.content" label={t.customsContent} options={contentOptions} required />
        <TextField control={control} name="customs.invoiceNumber" label={t.invoiceNumber} />
        <TextField control={control} name="customs.currency" label={t.currency} required />
      </div>
      <p className="text-sm font-medium">{t.customsLines}</p>
      {lines.fields.map((field, index) => (
        <div key={field.id} className="grid grid-cols-6 items-end gap-3 rounded-md border p-3">
          <TextField className="col-span-6 sm:col-span-3" control={control} name={`customs.lines.${index}.description`} label={t.lineDescription} required />
          <TextField className="col-span-2 sm:col-span-1" control={control} name={`customs.lines.${index}.quantity`} label={t.lineQuantity} inputMode="numeric" required />
          <TextField className="col-span-2 sm:col-span-1" control={control} name={`customs.lines.${index}.value`} label={t.lineValue} inputMode="decimal" required />
          <TextField className="col-span-2 sm:col-span-1" control={control} name={`customs.lines.${index}.weightGrams`} label={t.lineWeightGrams} inputMode="numeric" />
          <TextField className="col-span-3 sm:col-span-2" control={control} name={`customs.lines.${index}.hsCode`} label={t.lineHsCode} inputMode="numeric" />
          <TextField className="col-span-3 sm:col-span-2" control={control} name={`customs.lines.${index}.originCountry`} label={t.lineOrigin} required />
          <div className="col-span-6 flex justify-end sm:col-span-2">
            {removable ? (
              <Button type="button" variant="ghost" size="icon" onClick={() => lines.remove(index)} aria-label={t.removeLine.replace('{number}', String(index + 1))}>
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" onClick={() => lines.append(emptyCustomsLine())}>
        <Plus className="size-4" aria-hidden="true" />
        {t.addLine}
      </Button>
    </Section>
  );
}

interface PriceRowProps {
  fetching: boolean;
  credits: number | null | undefined;
  failed: boolean;
}

function PriceValue({ fetching, credits, failed }: Readonly<PriceRowProps>) {
  const t = getTranslations('weldstash').shipping.labels;
  if (fetching) {
    return (
      <span className="flex items-center gap-2 text-muted-foreground">
        <InlineSpinner /> {t.priceLoading}
      </span>
    );
  }
  if (credits !== null && credits !== undefined) {
    return <>{t.priceCredits.replace('{credits}', new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(credits))}</>;
  }
  if (failed) return <span className="text-destructive">{t.priceUnavailable}</span>;
  return <>—</>;
}

/** The price of the labels on WeldSuite's contract, in credits. */
export function PriceRow(props: Readonly<PriceRowProps>) {
  const t = getTranslations('weldstash').shipping.labels;
  return (
    <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-4 py-3 text-sm" aria-live="polite">
      <div>
        <p className="font-medium">{t.price}</p>
        <p className="text-xs text-muted-foreground">{t.priceHint}</p>
      </div>
      <p className="font-medium tabular-nums">
        <PriceValue {...props} />
      </p>
    </div>
  );
}
