import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { CSV_DATE_FORMATS, type CsvDateFormat } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { GL_COLUMN_FIELDS, SUMMARY_COLUMN_FIELDS, type MappingDraft } from '../csv-mapping';

/** Radix Select cannot hold an empty value, so "not in the file" travels as this. */
const NOT_IN_FILE = '__none__';

interface ColumnMappingProps {
  draft: MappingDraft;
  headers: readonly string[];
  onChange: (next: MappingDraft) => void;
}

/** Which column of the file means what, for the shape the user chose, and how its dates are written. */
export function ColumnMapping({ draft, headers, onChange }: Readonly<ColumnMappingProps>) {
  const { t } = useI18n();
  const tc = t.weldbooksUs.assets.payroll.wizard.columns;
  const labels = tc.fields as Record<string, string>;
  const fields = draft.shape === 'summary' ? SUMMARY_COLUMN_FIELDS : GL_COLUMN_FIELDS;
  const chosen: Record<string, string | undefined> = draft.shape === 'summary' ? draft.summaryColumns : draft.glColumns;

  const setColumn = (key: string, value: string) => {
    if (draft.shape === 'summary') {
      onChange({ ...draft, summaryColumns: { ...draft.summaryColumns, [key]: value || undefined } });
    } else {
      onChange({ ...draft, glColumns: { ...draft.glColumns, [key]: value || undefined } });
    }
  };

  return (
    <div className="space-y-4" data-testid="column-mapping">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((field) => {
          const id = `column-${field.key}`;
          const value = chosen[field.key] ?? '';
          return (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={id}>
                {labels[field.key]}
                {field.required ? <span aria-hidden> *</span> : null}
              </Label>
              <Select value={value === '' ? NOT_IN_FILE : value} onValueChange={(next) => setColumn(field.key, next === NOT_IN_FILE ? '' : next)}>
                <SelectTrigger id={id} data-testid={`column-${field.key}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NOT_IN_FILE}>{tc.notInFile}</SelectItem>
                  {headers.map((header) => (
                    <SelectItem key={header} value={header}>
                      {header}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>

      <div className="max-w-sm space-y-1.5">
        <Label htmlFor="column-date-format">{tc.dateFormat}</Label>
        <Select value={draft.dateFormat} onValueChange={(next) => onChange({ ...draft, dateFormat: next as CsvDateFormat })}>
          <SelectTrigger id="column-date-format">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CSV_DATE_FORMATS.map((format) => (
              <SelectItem key={format} value={format}>
                {tc.dateFormats[format]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
