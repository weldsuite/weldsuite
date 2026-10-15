import { useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@weldsuite/ui/components/collapsible';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { useSuggestBrWithholdings } from '@/hooks/queries/use-weldbooks-br-queries';
import type { WithholdingServiceKind } from '@/lib/api/domains/weldbooks-br';
import { useI18n } from '@/lib/i18n/provider';
import {
  EMPTY_BR_DOCUMENT,
  BR_IRRF_PRESETS,
  BR_ORIGINS,
  groupBrTaxRows,
  hasBrLineDetails,
  hasBrWithholdings,
  type BrBuyerIcms,
  type BrDocumentValues,
  type BrLineValues,
  type BrOrigin,
  type BrTaxRow,
} from '@/lib/weldbooks/br-fiscal';
import { uniqueWarnings } from '@/lib/weldbooks/document-tax';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

const NONE = '__none__';

// ---------------------------------------------------------------------------
// Line
// ---------------------------------------------------------------------------

interface BrLineFieldsProps {
  idPrefix: string;
  value: Partial<BrLineValues>;
  onChange: (patch: Partial<BrLineValues>) => void;
  errors?: Partial<Record<keyof BrLineValues, string>>;
  disabled?: boolean;
}

/**
 * Brazil: NCM and CFOP of a document line, with a collapsible "Fiscal
 * details": origin, ICMS / IPI / ISS rate overrides, LC 116 service code and
 * CEST. Empty rates mean "the rate of the tax profile".
 */
export function BrLineFields({ idPrefix, value, onChange, errors = {}, disabled }: Readonly<BrLineFieldsProps>) {
  const { t } = useI18n();
  const tb = t.weldbooksBr.document;
  const [open, setOpen] = useState(() => hasBrLineDetails(value));
  const expanded = open || Boolean(errors.brCest || errors.brIcmsRate || errors.brIpiRate || errors.brIssRate);
  const id = (field: string) => `${idPrefix}-${field}`;
  const origins = tb.origins as Record<string, string>;

  return (
    <div className="space-y-3" data-testid="br-line-fields">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor={id('ncm')}>{tb.ncm}</Label>
          <Input
            id={id('ncm')}
            inputMode="numeric"
            maxLength={8}
            placeholder="84713012"
            className="shadow-none"
            value={value.ncm ?? ''}
            disabled={disabled}
            aria-invalid={Boolean(errors.ncm)}
            onChange={(e) => onChange({ ncm: e.target.value.replace(/\D/g, '') })}
          />
          {errors.ncm ? (
            <p className="text-sm text-destructive">{errors.ncm}</p>
          ) : (
            <p className="text-xs text-muted-foreground">{tb.ncmHelp}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor={id('cfop')}>{tb.cfop}</Label>
          <Input
            id={id('cfop')}
            inputMode="numeric"
            maxLength={4}
            placeholder="5102"
            className="shadow-none"
            value={value.cfop ?? ''}
            disabled={disabled}
            aria-invalid={Boolean(errors.cfop)}
            onChange={(e) => onChange({ cfop: e.target.value.replace(/\D/g, '') })}
          />
          {errors.cfop ? (
            <p className="text-sm text-destructive">{errors.cfop}</p>
          ) : (
            <p className="text-xs text-muted-foreground">{tb.cfopHelp}</p>
          )}
        </div>
      </div>

      <Collapsible open={expanded} onOpenChange={setOpen}>
        <CollapsibleTrigger
          type="button"
          className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          {expanded ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
          {tb.fiscalDetails}
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label htmlFor={id('origin')}>{tb.origin}</Label>
              <Select
                value={value.brOrigin || NONE}
                onValueChange={(next) => onChange({ brOrigin: next === NONE ? '' : (next as BrOrigin) })}
                disabled={disabled}
              >
                <SelectTrigger id={id('origin')} className="shadow-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{tb.originNone}</SelectItem>
                  {BR_ORIGINS.map((origin) => (
                    <SelectItem key={origin} value={origin}>
                      {origins[origin]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(
              [
                ['brIcmsRate', 'icmsRate'],
                ['brIpiRate', 'ipiRate'],
                ['brIssRate', 'issRate'],
              ] as const
            ).map(([field, label]) => (
              <div key={field} className="space-y-2">
                <Label htmlFor={id(field)}>{tb[label]}</Label>
                <Input
                  id={id(field)}
                  inputMode="decimal"
                  className="shadow-none"
                  placeholder={tb.rateFromProfile}
                  value={value[field] ?? ''}
                  disabled={disabled}
                  aria-invalid={Boolean(errors[field])}
                  onChange={(e) => onChange({ [field]: e.target.value })}
                />
                {errors[field] && <p className="text-sm text-destructive">{errors[field]}</p>}
              </div>
            ))}
            <div className="space-y-2">
              <Label htmlFor={id('serviceCode')}>{tb.serviceCode}</Label>
              <Input
                id={id('serviceCode')}
                className="shadow-none"
                placeholder="01.07"
                value={value.brServiceCode ?? ''}
                disabled={disabled}
                onChange={(e) => onChange({ brServiceCode: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">{tb.serviceCodeHelp}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('cest')}>{tb.cest}</Label>
              <Input
                id={id('cest')}
                inputMode="numeric"
                maxLength={7}
                className="shadow-none"
                value={value.brCest ?? ''}
                disabled={disabled}
                aria-invalid={Boolean(errors.brCest)}
                onChange={(e) => onChange({ brCest: e.target.value.replace(/\D/g, '') })}
              />
              {errors.brCest && <p className="text-sm text-destructive">{errors.brCest}</p>}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

interface BrDocumentSectionProps {
  idPrefix: string;
  value: Partial<BrDocumentValues>;
  onChange: (patch: Partial<BrDocumentValues>) => void;
  errors?: Partial<Record<keyof BrDocumentValues, string>>;
  /** Sales: the buyer switches and the withholding suggestion. Purchases: the supplier's NF-e access key. */
  direction: 'sales' | 'purchase';
  /** The customer of the invoice, for the withholding suggestion. */
  contactId?: string | null;
  disabled?: boolean;
}

/**
 * Brazil: the document's withholdings (ISS, IRRF, CSRF, INSS), a "Suggest"
 * button that asks the server what the customer usually withholds, and the
 * buyer switches (final consumer, ICMS taxpayer) that change the ICMS base.
 */
export function BrDocumentSection({
  idPrefix,
  value: partial,
  onChange,
  errors = {},
  direction,
  contactId,
  disabled,
}: Readonly<BrDocumentSectionProps>) {
  const { t } = useI18n();
  const tb = t.weldbooksBr.document;
  const value: BrDocumentValues = { ...EMPTY_BR_DOCUMENT, ...partial };
  const suggest = useSuggestBrWithholdings();
  const [kind, setKind] = useState<WithholdingServiceKind>('professional');
  const [open, setOpen] = useState(() => hasBrWithholdings(value));
  const id = (field: string) => `${idPrefix}-${field}`;
  const irrfOptions: string[] = [...BR_IRRF_PRESETS];
  if (value.brIrrf && !irrfOptions.includes(value.brIrrf)) irrfOptions.push(value.brIrrf);

  const applySuggestion = async () => {
    try {
      const s = await suggest.mutateAsync({ contactId, serviceKind: kind });
      const patch: Partial<BrDocumentValues> = {
        brIssWithheld: s.iss ? String(s.iss) : '',
        brIrrf: s.irrf ? String(s.irrf) : '',
        brCsrf: s.csrf === true,
        brInss: s.inss ? String(s.inss) : '',
      };
      onChange(patch);
      setOpen(true);
      if (!s.iss && !s.irrf && !s.csrf && !s.inss) toast.info(tb.suggestNone);
      else toast.success(tb.suggestApplied);
    } catch (err) {
      toast.error(tb.suggestFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <div className="space-y-4" data-testid="br-document-fiscal">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          type="button"
          className="flex items-center gap-1 text-sm font-medium hover:text-foreground"
        >
          {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
          {tb.withholdingsTitle}
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-3">
          <p className="text-xs text-muted-foreground">{tb.withholdingsHelp}</p>

          {direction === 'sales' && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-2">
                <Label htmlFor={id('suggestKind')}>{tb.suggestKind}</Label>
                <Select value={kind} onValueChange={(next) => setKind(next as WithholdingServiceKind)} disabled={disabled}>
                  <SelectTrigger id={id('suggestKind')} className="w-56 shadow-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="professional">{tb.serviceKinds.professional}</SelectItem>
                    <SelectItem value="cleaning_security">{tb.serviceKinds.cleaning_security}</SelectItem>
                    <SelectItem value="other">{tb.serviceKinds.other}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shadow-none"
                disabled={disabled || suggest.isPending || !contactId}
                onClick={() => void applySuggestion()}
              >
                {suggest.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Sparkles className="mr-1 h-4 w-4" aria-hidden />
                )}
                {tb.suggest}
              </Button>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="space-y-2">
              <Label htmlFor={id('iss')}>{tb.issWithheld}</Label>
              <Input
                id={id('iss')}
                inputMode="decimal"
                className="shadow-none"
                placeholder="0"
                value={value.brIssWithheld}
                disabled={disabled}
                aria-invalid={Boolean(errors.brIssWithheld)}
                onChange={(e) => onChange({ brIssWithheld: e.target.value })}
              />
              {errors.brIssWithheld && <p className="text-sm text-destructive">{errors.brIssWithheld}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('irrf')}>{tb.irrf}</Label>
              <Select
                value={value.brIrrf || NONE}
                onValueChange={(next) => onChange({ brIrrf: next === NONE ? '' : next })}
                disabled={disabled}
              >
                <SelectTrigger id={id('irrf')} className="shadow-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{tb.irrfNone}</SelectItem>
                  {irrfOptions.map((rate) => (
                    <SelectItem key={rate} value={rate}>
                      {rate}%
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('inss')}>{tb.inss}</Label>
              <Input
                id={id('inss')}
                inputMode="decimal"
                className="shadow-none"
                placeholder="0"
                value={value.brInss}
                disabled={disabled}
                aria-invalid={Boolean(errors.brInss)}
                onChange={(e) => onChange({ brInss: e.target.value })}
              />
              {errors.brInss && <p className="text-sm text-destructive">{errors.brInss}</p>}
            </div>
            <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
              <div className="space-y-1">
                <Label htmlFor={id('csrf')}>{tb.csrf}</Label>
                <p className="text-xs text-muted-foreground">{tb.csrfHelp}</p>
              </div>
              <Switch
                id={id('csrf')}
                checked={value.brCsrf}
                disabled={disabled}
                onCheckedChange={(checked) => onChange({ brCsrf: checked })}
              />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {direction === 'sales' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
            <div className="space-y-1">
              <Label htmlFor={id('finalConsumer')}>{tb.finalConsumer}</Label>
              <p className="text-xs text-muted-foreground">{tb.finalConsumerHelp}</p>
            </div>
            <Switch
              id={id('finalConsumer')}
              checked={value.brFinalConsumer}
              disabled={disabled}
              onCheckedChange={(checked) => onChange({ brFinalConsumer: checked })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={id('buyerIcms')}>{tb.buyerIcms}</Label>
            <Select
              value={value.brBuyerIcms}
              onValueChange={(next) => onChange({ brBuyerIcms: next as BrBuyerIcms })}
              disabled={disabled}
            >
              <SelectTrigger id={id('buyerIcms')} className="shadow-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{tb.buyerIcmsOptions.auto}</SelectItem>
                <SelectItem value="yes">{tb.buyerIcmsOptions.yes}</SelectItem>
                <SelectItem value="no">{tb.buyerIcmsOptions.no}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{tb.buyerIcmsHelp}</p>
          </div>
        </div>
      )}

      {direction === 'purchase' && (
        <div className="space-y-2">
          <Label htmlFor={id('accessKey')}>{tb.accessKey}</Label>
          <Input
            id={id('accessKey')}
            inputMode="numeric"
            maxLength={54}
            className="shadow-none"
            value={value.brAccessKey}
            disabled={disabled}
            aria-invalid={Boolean(errors.brAccessKey)}
            onChange={(e) => onChange({ brAccessKey: e.target.value.replace(/[^\d\s]/g, '') })}
          />
          {errors.brAccessKey ? (
            <p className="text-sm text-destructive">{errors.brAccessKey}</p>
          ) : (
            <p className="text-xs text-muted-foreground">{tb.accessKeyHelp}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Breakdown
// ---------------------------------------------------------------------------

interface BrTaxSummaryProps {
  rows: readonly BrTaxRow[] | null | undefined;
  /** The engine's notes (plain sentences). */
  warnings?: readonly string[] | null;
  currency?: string | null;
  /** The form's preview does not cover withholdings and fiscal details yet: say so. */
  previewNote?: boolean;
}

/**
 * A Brazilian document's taxes grouped by how they relate to the price: taxes
 * on top of it, taxes included in it, withholdings (taken off what the
 * customer pays) and the CBS / IBS of the 2026 test year, for information.
 */
export function BrTaxSummary({ rows, warnings, currency, previewNote }: Readonly<BrTaxSummaryProps>) {
  const { t } = useI18n();
  const tb = t.weldbooksBr.document;
  const { formatMoney } = useWeldbooksFormat();
  const groups = groupBrTaxRows(rows);
  const notes = uniqueWarnings(warnings);
  const titles = tb.groups as Record<string, string>;

  return (
    <div className="space-y-3" data-testid="br-tax-summary">
      {groups.map((group) => (
        <div key={group.treatment} className="space-y-1" data-testid={`br-tax-group-${group.treatment}`}>
          <p className="text-xs font-medium uppercase text-muted-foreground">{titles[group.treatment]}</p>
          {group.rows.map((row) => (
            <div key={`${row.component ?? row.taxRateName}-${row.taxRate}`} className="flex items-start justify-between gap-3 text-sm">
              <span className="min-w-0 text-muted-foreground">
                <span className="block">{row.taxRateName}</span>
                <span className="block text-xs">{tb.onBase.replace('{amount}', formatMoney(row.taxableAmount, currency ?? undefined))}</span>
              </span>
              <span className={group.treatment === 'withheld' ? 'shrink-0 text-destructive' : 'shrink-0'}>
                {group.treatment === 'withheld' ? `-${formatMoney(row.taxAmount, currency ?? undefined)}` : formatMoney(row.taxAmount, currency ?? undefined)}
              </span>
            </div>
          ))}
          {group.treatment === 'embedded' && <p className="text-xs text-muted-foreground">{tb.embeddedNote}</p>}
          {group.treatment === 'informational' && <p className="text-xs text-muted-foreground">{tb.informationalNote}</p>}
        </div>
      ))}
      {notes.length > 0 && (
        <InfoBanner variant="warning" title={tb.warningsTitle}>
          <ul className="list-disc space-y-1 pl-4" data-testid="br-tax-warnings">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </InfoBanner>
      )}
      {previewNote && <p className="text-xs text-muted-foreground">{tb.previewNote}</p>}
    </div>
  );
}
