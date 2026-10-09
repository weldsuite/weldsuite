import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import {
  exemptNoticeText,
  taxWarningText,
  uniqueWarnings,
  type JurisdictionTaxGroup,
} from '@/lib/weldbooks/document-tax';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

interface TaxBreakdownListProps {
  groups: readonly JurisdictionTaxGroup[];
  currency?: string | null;
  /** Label of a VAT / GST total row when the rows carry no name. */
  taxLabel: string;
  /** Rows only: no "use tax accrued" heading and note (the caller has its own). */
  plain?: boolean;
}

/**
 * A document's tax per jurisdiction: name and level, the rate on the taxable
 * amount, and the tax. US use tax rows follow, apart from the sales tax; VAT /
 * GST documents keep one row per rate. Shows what the server answered.
 */
export function TaxBreakdownList({ groups, currency, taxLabel, plain = false }: Readonly<TaxBreakdownListProps>) {
  const td = useDocumentTexts();
  const { formatMoney } = useWeldbooksFormat();

  const charged = plain ? groups : groups.filter((g) => g.kind === 'tax');
  const use = plain ? [] : groups.filter((g) => g.kind === 'use');

  const row = (group: JurisdictionTaxGroup) => {
    const level = group.level ? td.levels[group.level] : null;
    const detail =
      group.isJurisdiction && group.rate > 0
        ? td.panel.rateOn.replace('{rate}', String(group.rate)).replace('{amount}', formatMoney(group.taxableAmount, currency))
        : null;
    return (
      <div key={group.key} className="flex items-start justify-between gap-3 text-sm" data-testid="tax-breakdown-row">
        <span className="min-w-0 text-muted-foreground">
          <span className="block">
            {group.name || taxLabel}
            {level && <span className="ml-1 text-xs">({level})</span>}
          </span>
          {detail && <span className="block text-xs">{detail}</span>}
          {group.exemptAmount > 0 && (
            <span className="block text-xs">{td.panel.exemptAmount.replace('{amount}', formatMoney(group.exemptAmount, currency))}</span>
          )}
        </span>
        <span className="shrink-0">{formatMoney(group.taxAmount, currency)}</span>
      </div>
    );
  };

  return (
    <div className="space-y-2">
      {charged.map(row)}
      {use.length > 0 && (
        <div className="space-y-2 border-t pt-2">
          <p className="text-xs font-medium uppercase text-muted-foreground">{td.panel.useTaxTitle}</p>
          {use.map(row)}
          <p className="text-xs text-muted-foreground">{td.panel.useTaxNote}</p>
        </div>
      )}
    </div>
  );
}

interface TaxWarningsProps {
  warnings: readonly string[] | null | undefined;
  /** The ship-to state, named by "not registered in {state}". */
  state?: string | null;
  title?: string;
  className?: string;
}

/** The engine's warnings as readable messages (not the codes). Nothing renders without any. */
export function TaxWarnings({ warnings, state, title, className }: Readonly<TaxWarningsProps>) {
  const td = useDocumentTexts();
  const list = uniqueWarnings(warnings);
  if (list.length === 0) return null;

  const texts = td.warnings as unknown as Record<string, string>;
  return (
    <InfoBanner variant="warning" title={title ?? td.panel.warningsTitle} className={className}>
      <ul className="list-disc space-y-1 pl-4" data-testid="tax-warnings">
        {list.map((warning) => (
          <li key={warning}>{taxWarningText(warning, texts, { state, stateFallback: td.warnings.stateFallback })}</li>
        ))}
      </ul>
    </InfoBanner>
  );
}

interface ExemptNoticeProps {
  reasons: readonly string[];
  certificateNumbers: readonly string[];
  className?: string;
}

/** "Exempt sale: resale. Certificate no. A-123." for a sale a certificate exempts. */
export function ExemptNotice({ reasons, certificateNumbers, className }: Readonly<ExemptNoticeProps>) {
  const td = useDocumentTexts();
  return (
    <p className={className ?? 'text-sm text-muted-foreground'} data-testid="exempt-notice">
      {exemptNoticeText(td.exempt, reasons, certificateNumbers)}
    </p>
  );
}
