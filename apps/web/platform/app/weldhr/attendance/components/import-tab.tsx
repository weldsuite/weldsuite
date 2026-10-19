/** Attendance → Import: paste or upload a CSV, preview it (parsed here, then checked by a server dry run), then import. */

import { useMemo, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrAttendanceStatus, HrImportResult } from '@weldsuite/app-api-client/domains/weldhr';
import type { ImportHrAttendanceInput } from '@weldsuite/app-api-client/schemas/weldhr';
import { useDebounce } from '@/hooks/use-debounce';
import { useHrAttendanceImportCheck, useImportHrAttendance } from '@/hooks/queries/use-weldhr-queries';
import { ErrorBanner, errorMessage } from '../../components/shared';
import { readTextFile } from '@/lib/read-text-file';

const STATUSES: Set<HrAttendanceStatus> = new Set(['present', 'late', 'absent', 'excused', 'remote', 'half_day']);
const TEMPLATE = 'employee,date,clock_in,clock_out,break_minutes,status,notes\njane@example.com,2025-01-06,09:00,17:30,30,,\n';

type ParsedRow = {
  row: number;
  errors: string[];
  payload: ImportHrAttendanceInput['rows'][number] | null;
  preview: { employee: string; date: string; clockIn: string; clockOut: string; breakMinutes: string; status: string; notes: string };
};

function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, '')));
}

function toIsoDateTime(date: string, value: string, errorKey: string, errors: string[]): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      errors.push(errorKey);
      return null;
    }
    return d.toISOString();
  }
  if (/^\d{1,2}:\d{2}$/.test(value)) {
    const d = new Date(`${date}T${value}`);
    if (Number.isNaN(d.getTime())) {
      errors.push(errorKey);
      return null;
    }
    return d.toISOString();
  }
  errors.push(errorKey);
  return null;
}

type CsvColumns = {
  employee: number;
  date: number;
  clockIn: number;
  clockOut: number;
  breakMinutes: number;
  status: number;
  notes: number;
};

/** `YYYY-MM-DD` that is a real day: 2026-13-45 matches the pattern but is not one. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function cellAt(cells: string[], index: number): string {
  return index >= 0 ? (cells[index] ?? '') : '';
}

function parseBreakMinutes(breakRaw: string, errors: string[]): number | undefined {
  if (!breakRaw) return undefined;
  const n = Number(breakRaw);
  if (!Number.isInteger(n) || n < 0 || n > 1440) {
    errors.push('invalidBreak');
    return undefined;
  }
  return n;
}

function parseStatus(statusRaw: string, errors: string[]): HrAttendanceStatus | undefined {
  if (!statusRaw) return undefined;
  if (!STATUSES.has(statusRaw as HrAttendanceStatus)) {
    errors.push('invalidStatus');
    return undefined;
  }
  return statusRaw as HrAttendanceStatus;
}

function parseRow(cells: string[], i: number, columns: CsvColumns): ParsedRow {
  const errors: string[] = [];
  const employee = cellAt(cells, columns.employee);
  const date = cellAt(cells, columns.date);
  const clockInRaw = cellAt(cells, columns.clockIn);
  const clockOutRaw = cellAt(cells, columns.clockOut);
  const breakRaw = cellAt(cells, columns.breakMinutes);
  const statusRaw = cellAt(cells, columns.status).toLowerCase();
  const notes = cellAt(cells, columns.notes);

  if (!employee) errors.push('missingEmployee');
  if (!isCalendarDate(date)) errors.push('missingDate');

  const clockIn = toIsoDateTime(date, clockInRaw, 'invalidClockIn', errors);
  const clockOut = toIsoDateTime(date, clockOutRaw, 'invalidClockOut', errors);
  const breakMinutes = parseBreakMinutes(breakRaw, errors);
  const status = parseStatus(statusRaw, errors);

  const payload =
    errors.length === 0
      ? { employee, date, clockIn, clockOut, breakMinutes, status, notes: notes || undefined }
      : null;

  return {
    row: i + 1,
    errors,
    payload,
    preview: { employee, date, clockIn: clockInRaw, clockOut: clockOutRaw, breakMinutes: breakRaw, status: statusRaw, notes },
  };
}

function downloadTemplate() {
  const blob = new Blob([TEMPLATE], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'weldhr-attendance-template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

const PREVIEW_LIMIT = 20;

export function ImportTab() {
  const t = useTranslations();
  const importAttendance = useImportHrAttendance();

  const [csvText, setCsvText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<HrImportResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const parsed = useMemo<ParsedRow[]>(() => {
    if (!csvText.trim()) return [];
    const lines = parseCsv(csvText);
    if (lines.length === 0) return [];
    const header = lines[0]!.map((h) => h.toLowerCase());
    const idx = (name: string) => header.indexOf(name);
    const columns: CsvColumns = {
      employee: idx('employee'),
      date: idx('date'),
      clockIn: idx('clock_in'),
      clockOut: idx('clock_out'),
      breakMinutes: idx('break_minutes'),
      status: idx('status'),
      notes: idx('notes'),
    };

    return lines.slice(1).map((cells, i) => parseRow(cells, i, columns));
  }, [csvText]);

  // Rows that parse go to the server for a dry run, which knows what the browser cannot:
  // whether the employee exists, and the time checks the import itself applies.
  const parsedValid = useMemo(() => parsed.filter((r) => r.payload), [parsed]);
  const validPayloads = useMemo(() => parsedValid.map((r) => r.payload!), [parsedValid]);
  const debouncedRows = useDebounce(validPayloads, 400);
  const { data: check, isFetching: checking } = useHrAttendanceImportCheck(debouncedRows);
  const checkCurrent = debouncedRows === validPayloads && !checking;

  /** CSV row number → why the server would refuse it. Dry-run rows are numbered by position among the parsed rows. */
  const serverErrors = useMemo(() => {
    const out = new Map<number, string>();
    if (!check || !checkCurrent) return out;
    for (const error of check.errors) {
      const row = parsedValid[error.row - 1];
      if (row) out.set(row.row, error.reason);
    }
    return out;
  }, [check, checkCurrent, parsedValid]);

  const importable = checkCurrent ? parsedValid.filter((r) => !serverErrors.has(r.row)) : [];

  function rowProblems(row: ParsedRow): string[] {
    const problems = row.errors.map((e) => t(`weldhr.attendance.import.parseErrors.${e}`));
    const server = serverErrors.get(row.row);
    if (server) problems.push(server);
    return problems;
  }

  function handleFile(file: File) {
    setFileName(file.name);
    readTextFile(file).then(setCsvText).catch(() => {
      // An unreadable file leaves the previous CSV, as FileReader did.
    });
  }

  async function submit() {
    if (importable.length === 0) return;
    setFailure(null);
    setResult(null);
    try {
      const res = await importAttendance.mutateAsync({ rows: importable.map((r) => r.payload!) });
      // The server numbers rows by position in what was sent; show the CSV row numbers instead.
      setResult({
        ...res.data,
        errors: res.data.errors.map((e) => ({ ...e, row: importable[e.row - 1]?.row ?? e.row })),
      });
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.attendance.import.failed')));
    }
  }

  function renderCheck(row: ParsedRow) {
    const problems = rowProblems(row);
    if (problems.length > 0) {
      return (
        <div className="space-y-1">
          <Badge variant="destructive">{t('weldhr.attendance.import.rowInvalid')}</Badge>
          <ul className="space-y-0.5 text-xs text-destructive">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      );
    }
    if (!checkCurrent) return <span className="text-xs text-muted-foreground">{t('weldhr.attendance.import.checking')}</span>;
    return <Badge variant="default">{t('weldhr.attendance.import.rowValid')}</Badge>;
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">{t('weldhr.attendance.import.description')}</p>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">{t('weldhr.attendance.import.pasteLabel')}</label>
          <Textarea
            value={csvText}
            onChange={(e) => {
              setCsvText(e.target.value);
              setFileName(null);
              setResult(null);
            }}
            placeholder={t('weldhr.attendance.import.pastePlaceholder')}
            rows={6}
            className="font-mono text-xs"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
            <Upload className="h-4 w-4" />
            {t('weldhr.attendance.import.uploadLabel')}
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
          </label>
          {fileName && <span className="text-xs text-muted-foreground">{fileName}</span>}
          <Button variant="outline" size="sm" onClick={downloadTemplate} className="ml-auto">
            <Download className="mr-1.5 h-4 w-4" />
            {t('weldhr.attendance.import.downloadTemplate')}
          </Button>
        </div>
      </Card>

      <ErrorBanner error={failure} />

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-medium">{t('weldhr.attendance.import.preview')}</p>
          {parsed.length > PREVIEW_LIMIT && (
            <p className="text-xs text-muted-foreground">
              {t('weldhr.attendance.import.previewHint', { shown: PREVIEW_LIMIT, total: parsed.length })}
            </p>
          )}
        </div>

        {parsed.length === 0 ? (
          <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            {t('weldhr.attendance.import.noRows')}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('weldhr.attendance.import.rowNumber')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.form.employee')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.form.date')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.form.clockIn')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.form.clockOut')}</TableHead>
                  <TableHead>{t('weldhr.attendance.import.recordStatus')}</TableHead>
                  <TableHead>{t('weldhr.attendance.import.check')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {parsed.slice(0, PREVIEW_LIMIT).map((row) => (
                  <TableRow key={row.row}>
                    <TableCell>{row.row}</TableCell>
                    <TableCell>{row.preview.employee || '—'}</TableCell>
                    <TableCell>{row.preview.date || '—'}</TableCell>
                    <TableCell>{row.preview.clockIn || '—'}</TableCell>
                    <TableCell>{row.preview.clockOut || '—'}</TableCell>
                    <TableCell>{row.preview.status || '—'}</TableCell>
                    <TableCell>{renderCheck(row)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {result && (
        <Card className="space-y-1.5 p-4 text-sm">
          <p className="font-medium">{t('weldhr.attendance.import.result.title')}</p>
          <p>{t('weldhr.attendance.import.result.created', { count: result.created })}</p>
          <p>{t('weldhr.attendance.import.result.updated', { count: result.updated })}</p>
          {result.errors.length > 0 && (
            <div className="pt-1 text-destructive">
              <p>{t('weldhr.attendance.import.result.errors', { count: result.errors.length })}</p>
              <ul className="mt-1 list-inside list-disc">
                {result.errors.map((e) => (
                  <li key={`${e.row}-${e.reason}`}>{t('weldhr.attendance.import.result.errorRow', { row: e.row, reason: e.reason })}</li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      <div className="flex justify-end">
        <Button onClick={() => void submit()} disabled={importable.length === 0 || importAttendance.isPending}>
          {importAttendance.isPending
            ? t('weldhr.attendance.import.submitting')
            : t('weldhr.attendance.import.submit', { count: importable.length })}
        </Button>
      </div>
    </div>
  );
}
