import { useId } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useI18n } from '@/lib/i18n/provider';
import {
  CSV_DATE_FORMATS,
  CSV_DELIMITERS,
  CSV_NEGATIVE_STYLES,
  draftProblems,
  type CsvColumnKey,
  type CsvFormatDraft,
  type CsvTable,
} from './csv-format-model';

const NONE = '__none__';
const AUTO = '__auto__';

const DELIMITER_KEYS = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' } as const;

/** The warnings books-api writes with a proposed layout, mapped to translation keys. */
const WARNING_KEYS: Readonly<Record<string, 'noDate' | 'noAmount' | 'dateAmbiguous' | 'noHeader'>> = {
  'No date column found; pick one': 'noDate',
  'No amount column found; pick one': 'noAmount',
  'Every date could be month-first or day-first; confirm the order': 'dateAmbiguous',
  'No header row found; columns are given by position': 'noHeader',
};

interface CsvFormatEditorProps {
  draft: CsvFormatDraft;
  onDraftChange: (draft: CsvFormatDraft) => void;
  /** The head of the file under the draft's delimiter, skipped rows and header setting. */
  table: CsvTable;
  /** The server could not tell month-first from day-first dates. */
  dateOrderAmbiguous: boolean;
  /** The user has confirmed the date order (always true when it is not ambiguous). */
  dateOrderConfirmed: boolean;
  onDateOrderConfirmedChange: (confirmed: boolean) => void;
  warnings: readonly string[];
  remember: boolean;
  onRememberChange: (remember: boolean) => void;
}

function OptionSelect({
  label,
  value,
  onValueChange,
  options,
  testId,
}: Readonly<{
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  testId: string;
}>) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id} data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Edit how a bank's CSV is read: date order, number separators, how negatives
 * are written and which column holds what. US banks don't share a CSV layout
 * and a wrong guess misbooks money, so the layout is always confirmed here
 * before a file is imported.
 */
export function CsvFormatEditor({
  draft,
  onDraftChange,
  table,
  dateOrderAmbiguous,
  dateOrderConfirmed,
  onDateOrderConfirmedChange,
  warnings,
  remember,
  onRememberChange,
}: Readonly<CsvFormatEditorProps>) {
  const { t } = useI18n();
  const tc = t.weldbooksUs.banking.csvEditor;
  const problems = draftProblems(draft);
  const split = draft.negativeStyle === 'debit_credit_columns';

  const update = (patch: Partial<CsvFormatDraft>) => onDraftChange({ ...draft, ...patch });
  const setColumn = (key: CsvColumnKey, value: string) =>
    onDraftChange({ ...draft, columns: { ...draft.columns, [key]: value === NONE ? null : Number.parseInt(value, 10) } });

  const sampleRow = table.rows[0] ?? [];
  const columnOptions = (required: boolean) => [
    ...(required ? [] : [{ value: NONE, label: tc.noColumn }]),
    ...table.headers.map((header, index) => ({
      value: String(index),
      label: draft.hasHeader && header
        ? `${index + 1}. ${header}`
        : `${index + 1}. ${tc.columnN.replace('{n}', String(index + 1))}${sampleRow[index] ? ` (${sampleRow[index]})` : ''}`,
    })),
  ];
  const columnValue = (key: CsvColumnKey, required: boolean) => {
    const index = draft.columns[key];
    if (index === null) return required ? '' : NONE;
    return String(index);
  };

  const columnFields: Array<{ key: CsvColumnKey; label: string; required: boolean }> = [
    { key: 'date', label: tc.columns.date, required: true },
    { key: 'description', label: tc.columns.description, required: true },
    ...(split
      ? [
          { key: 'debit' as const, label: tc.columns.debit, required: false },
          { key: 'credit' as const, label: tc.columns.credit, required: false },
        ]
      : [{ key: 'amount' as const, label: tc.columns.amount, required: true }]),
    { key: 'checkNumber', label: tc.columns.checkNumber, required: false },
    { key: 'payee', label: tc.columns.payee, required: false },
    { key: 'reference', label: tc.columns.reference, required: false },
  ];

  return (
    <div className="space-y-5" data-testid="csv-format-editor">
      <div>
        <h3 className="text-sm font-semibold">{tc.title}</h3>
        <p className="text-sm text-muted-foreground">{tc.description}</p>
      </div>

      {warnings.length > 0 ? (
        <ul className="space-y-1 text-sm text-amber-700 dark:text-amber-400">
          {warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{WARNING_KEYS[warning] ? tc.serverWarnings[WARNING_KEYS[warning]] : warning}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <OptionSelect
          label={tc.dateOrder}
          testId="csv-date-order"
          value={draft.dateFormat}
          onValueChange={(value) => update({ dateFormat: value as CsvFormatDraft['dateFormat'] })}
          options={CSV_DATE_FORMATS.map((f) => ({ value: f, label: tc.dateOrders[f] }))}
        />
        <OptionSelect
          label={tc.decimalSeparator}
          testId="csv-decimal-separator"
          value={draft.decimalSeparator}
          onValueChange={(value) => update({ decimalSeparator: value as CsvFormatDraft['decimalSeparator'] })}
          options={[
            { value: '.', label: tc.decimalDot },
            { value: ',', label: tc.decimalComma },
          ]}
        />
        <OptionSelect
          label={tc.thousandsSeparator}
          testId="csv-thousands-separator"
          value={draft.thousandsSeparator === '' ? NONE : draft.thousandsSeparator}
          onValueChange={(value) =>
            update({ thousandsSeparator: value === NONE ? '' : (value as CsvFormatDraft['thousandsSeparator']) })
          }
          options={[
            { value: ',', label: tc.thousandsComma },
            { value: '.', label: tc.thousandsDot },
            { value: ' ', label: tc.thousandsSpace },
            { value: NONE, label: tc.thousandsNone },
          ]}
        />
        <OptionSelect
          label={tc.negativeStyle}
          testId="csv-negative-style"
          value={draft.negativeStyle}
          onValueChange={(value) => update({ negativeStyle: value as CsvFormatDraft['negativeStyle'] })}
          options={CSV_NEGATIVE_STYLES.map((s) => ({ value: s, label: tc.negativeStyles[s] }))}
        />
      </div>
      {problems.includes('separators') ? (
        <p className="text-sm text-destructive" role="alert">{tc.problems.separators}</p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="csv-skip-rows">{tc.skipRows}</Label>
          <Input
            id="csv-skip-rows"
            type="number"
            min={0}
            max={100}
            value={draft.skipRows}
            onChange={(e) => update({ skipRows: Math.min(100, Math.max(0, Number.parseInt(e.target.value, 10) || 0)) })}
          />
          <p className="text-xs text-muted-foreground">{tc.skipRowsHint}</p>
        </div>
        <OptionSelect
          label={tc.delimiter}
          testId="csv-delimiter"
          value={draft.delimiter ?? AUTO}
          onValueChange={(value) => update({ delimiter: value === AUTO ? null : (value as CsvFormatDraft['delimiter']) })}
          options={[
            { value: AUTO, label: tc.delimiterAuto },
            ...CSV_DELIMITERS.map((d) => ({ value: d, label: tc.delimiters[DELIMITER_KEYS[d]] })),
          ]}
        />
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <Checkbox checked={draft.hasHeader} onCheckedChange={(checked) => update({ hasHeader: !!checked })} data-testid="csv-has-header" />
          {tc.hasHeader}
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {columnFields.map((field) => (
          <OptionSelect
            key={field.key}
            label={field.required ? `${field.label} *` : field.label}
            testId={`csv-column-${field.key}`}
            value={columnValue(field.key, field.required)}
            onValueChange={(value) => setColumn(field.key, value)}
            options={columnOptions(field.required)}
          />
        ))}
      </div>
      {split ? <p className="text-xs text-muted-foreground">{tc.debitCreditHint}</p> : null}
      {problems.filter((p) => p !== 'separators').length > 0 ? (
        <p className="text-sm text-destructive" role="alert" data-testid="csv-problems">
          {problems.filter((p) => p !== 'separators').map((p) => tc.problems[p]).join(' ')}
        </p>
      ) : null}

      {dateOrderAmbiguous ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-medium">{tc.dateAmbiguousTitle}</p>
          <p className="mt-1">{tc.dateAmbiguousBody.replace('{order}', tc.dateOrders[draft.dateFormat])}</p>
          <label className="mt-2 flex items-center gap-2">
            <Checkbox
              checked={dateOrderConfirmed}
              onCheckedChange={(checked) => onDateOrderConfirmedChange(!!checked)}
              data-testid="csv-confirm-date-order"
            />
            {tc.dateAmbiguousConfirm}
          </label>
        </div>
      ) : null}

      <div className="space-y-2">
        <p className="text-sm font-medium">{tc.fileSample}</p>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                {table.headers.map((header, index) => (
                  <TableHead key={`${index}:${header}`} className="whitespace-nowrap">
                    {header}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {table.rows.map((row, rowIndex) => (
                <TableRow key={rowIndex}>
                  {table.headers.map((_, cellIndex) => (
                    <TableCell key={cellIndex} className="whitespace-nowrap text-xs">
                      {row[cellIndex] ?? ''}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={remember} onCheckedChange={(checked) => onRememberChange(!!checked)} data-testid="csv-remember" />
        {tc.remember}
      </label>
    </div>
  );
}
