/** Attendance → Import: paste or upload a CSV, preview and validate client-side, then import. */

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
import { useImportHrAttendance } from '@/hooks/queries/use-weldhr-queries';
import { ErrorBanner, errorMessage } from '../../components/shared';

const STATUSES: HrAttendanceStatus[] = ['present', 'late', 'absent', 'excused', 'remote', 'half_day'];
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
    const iEmployee = idx('employee');
    const iDate = idx('date');
    const iIn = idx('clock_in');
    const iOut = idx('clock_out');
    const iBreak = idx('break_minutes');
    const iStatus = idx('status');
    const iNotes = idx('notes');

    return lines.slice(1).map((cells, i) => {
      const errors: string[] = [];
      const employee = iEmployee >= 0 ? (cells[iEmployee] ?? '') : '';
      const date = iDate >= 0 ? (cells[iDate] ?? '') : '';
      const clockInRaw = iIn >= 0 ? (cells[iIn] ?? '') : '';
      const clockOutRaw = iOut >= 0 ? (cells[iOut] ?? '') : '';
      const breakRaw = iBreak >= 0 ? (cells[iBreak] ?? '') : '';
      const statusRaw = iStatus >= 0 ? (cells[iStatus] ?? '').toLowerCase() : '';
      const notes = iNotes >= 0 ? (cells[iNotes] ?? '') : '';

      if (!employee) errors.push('missingEmployee');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('missingDate');

      const clockIn = toIsoDateTime(date, clockInRaw, 'invalidClockIn', errors);
      const clockOut = toIsoDateTime(date, clockOutRaw, 'invalidClockOut', errors);

      let breakMinutes: number | undefined;
      if (breakRaw) {
        const n = Number(breakRaw);
        if (!Number.isInteger(n) || n < 0 || n > 1440) errors.push('invalidBreak');
        else breakMinutes = n;
      }

      let status: HrAttendanceStatus | undefined;
      if (statusRaw) {
        if (!STATUSES.includes(statusRaw as HrAttendanceStatus)) errors.push('invalidStatus');
        else status = statusRaw as HrAttendanceStatus;
      }

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
    });
  }, [csvText]);

  const validRows = parsed.filter((r) => r.payload).map((r) => r.payload!);

  function handleFile(file: File) {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result ?? ''));
    reader.readAsText(file);
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

  async function submit() {
    if (validRows.length === 0) return;
    setFailure(null);
    setResult(null);
    try {
      const res = await importAttendance.mutateAsync({ rows: validRows });
      setResult(res.data);
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.attendance.import.failed')));
    }
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
          {parsed.length > 0 && <p className="text-xs text-muted-foreground">{t('weldhr.attendance.import.previewHint')}</p>}
        </div>

        {parsed.length === 0 ? (
          <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            {t('weldhr.attendance.import.noRows')}
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('weldhr.attendance.import.rowNumber')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.form.employee')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.form.date')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.form.clockIn')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.form.clockOut')}</TableHead>
                  <TableHead>{t('weldhr.attendance.records.form.status')}</TableHead>
                  <TableHead>{t('weldhr.common.status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {parsed.slice(0, 20).map((row) => (
                  <TableRow key={row.row}>
                    <TableCell>{row.row}</TableCell>
                    <TableCell>{row.preview.employee || '—'}</TableCell>
                    <TableCell>{row.preview.date || '—'}</TableCell>
                    <TableCell>{row.preview.clockIn || '—'}</TableCell>
                    <TableCell>{row.preview.clockOut || '—'}</TableCell>
                    <TableCell>{row.preview.status || '—'}</TableCell>
                    <TableCell>
                      {row.errors.length === 0 ? (
                        <Badge variant="default">{t('weldhr.attendance.import.rowValid')}</Badge>
                      ) : (
                        <Badge variant="destructive" title={row.errors.map((e) => t(`weldhr.attendance.import.parseErrors.${e}`)).join('; ')}>
                          {t('weldhr.attendance.import.rowInvalid')}
                        </Badge>
                      )}
                    </TableCell>
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
                {result.errors.map((e, i) => (
                  <li key={i}>{t('weldhr.attendance.import.result.errorRow', { row: e.row, reason: e.reason })}</li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      <div className="flex justify-end">
        <Button onClick={() => void submit()} disabled={validRows.length === 0 || importAttendance.isPending}>
          {importAttendance.isPending
            ? t('weldhr.attendance.import.submitting')
            : t('weldhr.attendance.import.submit', { count: validRows.length })}
        </Button>
      </div>
    </div>
  );
}
