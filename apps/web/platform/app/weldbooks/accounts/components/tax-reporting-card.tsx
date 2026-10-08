import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useTaxLineCatalog } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';
import { FORM_1099_ACCOUNT_BOXES, FORM_1099_OMIT, form1099BoxName } from '@/lib/weldbooks/form-1099';
import { TaxLineSelect } from './tax-line-select';

/** The 1099 select has no empty value either: "not set" is a sentinel. */
const NO_BOX = '__none__';

interface TaxReportingCardProps {
  taxLine: string;
  form1099Box: string;
  onTaxLineChange: (code: string) => void;
  onForm1099BoxChange: (code: string) => void;
  /** The 1099 box applies (the jurisdiction files 1099s). */
  showForm1099: boolean;
}

/**
 * "Tax reporting" of an account (US): the line of the income-tax return the
 * account reports on and the 1099 box payments booked on it go to.
 */
export function TaxReportingCard({
  taxLine,
  form1099Box,
  onTaxLineChange,
  onForm1099BoxChange,
  showForm1099,
}: Readonly<TaxReportingCardProps>) {
  const { t } = useI18n();
  const ta = t.weldbooksUs.setup.accounts;
  const catalogQuery = useTaxLineCatalog();
  const catalog = catalogQuery.data;
  const knownBox = !form1099Box || form1099Box === FORM_1099_OMIT || FORM_1099_ACCOUNT_BOXES.some((b) => b.code === form1099Box);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{ta.reportingTitle}</CardTitle>
        <CardDescription>{ta.reportingDescription}</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="taxLine">{ta.taxLine}</Label>
          <TaxLineSelect
            id="taxLine"
            value={taxLine}
            onChange={onTaxLineChange}
            catalog={catalog}
            disabled={catalogQuery.isLoading}
          />
          <p className="text-xs text-muted-foreground">
            {catalogQuery.isError
              ? ta.taxLineLoadError
              : catalog
                ? ta.taxLineHelp.replace('{form}', catalog.formLabel)
                : ta.taxLineHelpNoForm}
          </p>
        </div>

        {showForm1099 ? (
          <div className="space-y-2">
            <Label htmlFor="form1099Box">{ta.form1099Box}</Label>
            <Select
              value={form1099Box || NO_BOX}
              onValueChange={(next) => onForm1099BoxChange(next === NO_BOX ? '' : next)}
            >
              <SelectTrigger id="form1099Box">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-80">
                <SelectItem value={NO_BOX}>{ta.form1099None}</SelectItem>
                <SelectItem value={FORM_1099_OMIT}>{ta.form1099Omit}</SelectItem>
                {!knownBox ? <SelectItem value={form1099Box}>{form1099BoxName(form1099Box)}</SelectItem> : null}
                {FORM_1099_ACCOUNT_BOXES.map((box) => (
                  <SelectItem key={box.code} value={box.code}>
                    {form1099BoxName(box.code)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{ta.form1099BoxHelp}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
