/** CSV import sub-tab: bulk-load KPI values for a period in one go. */

import { useRef, useState, type ChangeEvent } from 'react';
import { Download, Upload } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrImportResult } from '@weldsuite/app-api-client/domains/weldhr';
import { useHrKpis, useImportHrKpiValues } from '@/hooks/queries/use-weldhr-queries';
import { ErrorBanner, errorMessage } from '../../components/shared';

interface ParsedRow {
  employee: string;
  value: number;
  companyId?: string;
}

function parseCsv(text: string): { rows: ParsedRow[]; skipped: number } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let skipped = 0;
  const rows: ParsedRow[] = [];
  for (const line of lines) {
    const cols = line.split(',').map((c) => c.trim());
    if (/^employee$/i.test(cols[0] ?? '') && /^value$/i.test(cols[1] ?? '')) continue; // header row
    const [employee, rawValue, companyId] = cols;
    const value = Number(rawValue);
    if (!employee || rawValue === undefined || Number.isNaN(value)) {
      skipped += 1;
      continue;
    }
    rows.push({ employee, value, companyId: companyId || undefined });
  }
  return { rows, skipped };
}

export function ImportTab() {
  const t = useTranslations();
  const { data: kpis } = useHrKpis();
  const importValues = useImportHrKpiValues();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [kpiId, setKpiId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [sharedWithClient, setSharedWithClient] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<HrImportResult | null>(null);

  const { rows, skipped } = parseCsv(csvText);

  function downloadTemplate() {
    const body = 'employee,value,client_id\n';
    const url = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'weldhr-kpi-values-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  function onFileChosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result ?? ''));
    reader.readAsText(file);
    e.target.value = '';
  }

  async function submit() {
    if (!kpiId || !periodStart || !periodEnd || rows.length === 0) return;
    setFailure(null);
    setResult(null);
    try {
      const response = await importValues.mutateAsync({
        kpiId,
        periodStart,
        periodEnd,
        sharedWithClient,
        rows,
      });
      setResult(response.data);
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.performance.import.failed')));
    }
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4">
        <div>
          <h3 className="text-sm font-medium">{t('weldhr.performance.import.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('weldhr.performance.import.description')}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>{t('weldhr.performance.import.kpi')}</Label>
            <Select value={kpiId} onValueChange={setKpiId}>
              <SelectTrigger>
                <SelectValue placeholder={t('weldhr.performance.kpis.selectKpi')} />
              </SelectTrigger>
              <SelectContent>
                {(kpis ?? []).map((k) => (
                  <SelectItem key={k.id} value={k.id}>
                    {k.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="import-period-start">{t('weldhr.common.from')}</Label>
            <Input
              id="import-period-start"
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="import-period-end">{t('weldhr.common.to')}</Label>
            <Input id="import-period-end" type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <p className="text-sm font-medium">{t('weldhr.common.sharedWithClient')}</p>
            <p className="text-xs text-muted-foreground">{t('weldhr.common.sharedWithClientHint')}</p>
          </div>
          <Switch checked={sharedWithClient} onCheckedChange={setSharedWithClient} />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="import-csv">{t('weldhr.performance.import.csvLabel')}</Label>
            <div className="flex gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={onFileChosen}
              />
              <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                {t('weldhr.performance.import.uploadFile')}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={downloadTemplate}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {t('weldhr.performance.import.downloadTemplate')}
              </Button>
            </div>
          </div>
          <Textarea
            id="import-csv"
            rows={6}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder={t('weldhr.performance.import.csvPlaceholder')}
            className="font-mono text-xs"
          />
        </div>

        <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

        {rows.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {t('weldhr.performance.import.previewRows', { count: rows.length })}
              {skipped > 0 ? ` · ${t('weldhr.performance.import.skippedRows', { count: skipped })}` : ''}
            </p>
            <Card className="max-h-48 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('weldhr.common.employee')}</TableHead>
                    <TableHead>{t('weldhr.performance.kpis.dialog.value')}</TableHead>
                    <TableHead>{t('weldhr.common.client')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.slice(0, 50).map((row, i) => (
                    <TableRow key={i}>
                      <TableCell>{row.employee}</TableCell>
                      <TableCell>{row.value}</TableCell>
                      <TableCell>{row.companyId ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </div>
        )}

        <div className="flex justify-end">
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={importValues.isPending || !kpiId || !periodStart || !periodEnd || rows.length === 0}
          >
            {importValues.isPending ? t('weldhr.common.saving') : t('weldhr.common.importCsv')}
          </Button>
        </div>

        {result && (
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm">
              {t('weldhr.common.importResult', { created: result.created, updated: result.updated })}
            </p>
            {result.errors.length > 0 && (
              <div>
                <p className="text-sm text-destructive">
                  {t('weldhr.common.importErrors', { count: result.errors.length })}
                </p>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {result.errors.slice(0, 20).map((e, i) => (
                    <li key={i}>
                      {t('weldhr.performance.import.result.row', { row: e.row })}: {e.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
