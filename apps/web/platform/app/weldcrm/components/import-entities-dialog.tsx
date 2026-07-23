/**
 * Shared CRM import wizard for Companies and People.
 *
 * Upload → map columns → run → result. Modeled on the WeldFlow task importer
 * but synchronous and client-chunked: valid rows are split into batches and
 * each batch is POSTed to the entity's upsert endpoint via `onImportBatch`,
 * accumulating counts to drive the progress bar. No background-job infra.
 *
 * Parameterized per entity via `fields` / `requireOneOf` / `templateExample`,
 * so Companies and People reuse one dialog.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  Check,
  ChevronRight,
  ChevronsUpDown,
  Download,
  FileSpreadsheet,
  Loader2,
  AlertCircle,
  CheckCircle2,
  XCircle,
  UploadIcon,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';

import { cn } from '@/lib/utils';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Progress } from '@weldsuite/ui/components/progress';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { Dropzone } from '@weldsuite/ui/components/dropzone';
import { coerceScalar, type ImportValueType } from './import-value';

export interface ImportFieldDef {
  /** Localized label shown in the mapping UI + template header. */
  header: string;
  /** Field key sent to the server (matches the create schema). */
  accessorKey: string;
  /** Split the cell on `,`/`;` into an array (tags, interests). */
  multiValue?: boolean;
  /**
   * When set, the value is written under `record.customFields[slug]` instead
   * of a top-level key. Used for user-defined custom fields.
   */
  customFieldSlug?: string;
  /** Coerce the cell value before sending (default `'string'`). */
  valueType?: ImportValueType;
}

export interface ImportEntitiesResult {
  imported: number;
  updated: number;
  failed: number;
  total: number;
  errors: { row: number; ref: string; error: string }[];
}

interface ImportEntitiesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Localized plural entity label, e.g. "companies" / "people". */
  entityLabel: string;
  fields: ImportFieldDef[];
  /** A row is importable if at least one of these mapped fields has a value. */
  requireOneOf: string[];
  /** Example values for the downloadable template, keyed by accessorKey. */
  templateExample?: Record<string, string>;
  /** Base filename (no extension) for the template, e.g. "companies". */
  templateName: string;
  onImportBatch: (records: Record<string, unknown>[]) => Promise<ImportEntitiesResult>;
}

const BATCH_SIZE = 200;
const MAX_ROWS = 50_000;

type Step = 'upload' | 'mapping' | 'running' | 'result';
type Mappings = Record<string, string>;

type Tfn = (path: string, params?: Record<string, unknown>) => string;

function normalizeString(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function safeString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  try {
    return String(value).trim();
  } catch {
    return '';
  }
}

function buildTemplateRows(
  fields: ImportFieldDef[],
  example?: Record<string, string>,
): { headers: string[]; row: string[] } {
  const headers = fields.map((f) => f.header);
  const row = fields.map((f) => example?.[f.accessorKey] ?? '');
  return { headers, row };
}

// ── Field picker (one per file column) ───────────────────────────────────────

function FieldCombobox({
  t,
  fields,
  value,
  onValueChange,
  onFocus,
  usedFields,
}: {
  t: Tfn;
  fields: ImportFieldDef[];
  value: string;
  onValueChange: (value: string) => void;
  onFocus: () => void;
  usedFields: Set<string>;
}) {
  const [open, setOpen] = useState(false);
  const selected = fields.find((f) => f.accessorKey === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild onClick={onFocus}>
        <Button variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between h-9">
          <span className="truncate">
            {selected ? selected.header : t('crm.importExport.skipThisColumn')}
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0 w-[250px]"
        onWheel={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      >
        <Command>
          <CommandInput placeholder={t('crm.importExport.searchFields')} />
          <CommandList>
            <CommandEmpty>{t('crm.importExport.noFieldFound')}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__skip__"
                onSelect={() => {
                  onValueChange('');
                  setOpen(false);
                }}
                className={cn(value === '' && 'bg-accent text-accent-foreground')}
              >
                <span className="text-muted-foreground">{t('crm.importExport.skipThisColumn')}</span>
                <Check className={cn('size-4 ml-auto', value !== '' && 'opacity-0')} />
              </CommandItem>
              {fields.map((field) => {
                const isUsed = usedFields.has(field.accessorKey) && value !== field.accessorKey;
                const isSelected = value === field.accessorKey;
                return (
                  <CommandItem
                    key={field.accessorKey}
                    value={`${field.header} ${field.accessorKey}`}
                    onSelect={() => {
                      onValueChange(value === field.accessorKey ? '' : field.accessorKey);
                      setOpen(false);
                    }}
                    disabled={isUsed}
                    className={cn(isUsed && 'opacity-50', isSelected && 'bg-accent text-accent-foreground')}
                  >
                    <span>{field.header}</span>
                    {isUsed && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        {t('crm.importExport.usedBadge')}
                      </span>
                    )}
                    <Check
                      className={cn('size-4', !isUsed && 'ml-auto', value !== field.accessorKey && 'opacity-0')}
                    />
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function DataPreviewList({
  t,
  focusedColumn,
  data,
}: {
  t: Tfn;
  focusedColumn: string | null;
  data: Record<string, unknown>[];
}) {
  if (!focusedColumn || data.length === 0) return null;
  const preview = data.slice(0, 5);
  return (
    <div className="space-y-2 border bg-background p-4 pb-1 rounded-md">
      <p className="text-sm font-semibold">
        {t('crm.importExport.sampleValuesFor', { field: focusedColumn })}
      </p>
      <ul>
        {preview.map((item, i) => {
          const value = safeString(item[focusedColumn]);
          return (
            <li key={i} className="border-b py-3 text-sm first:border-t last:border-b-0 truncate">
              {value || <span className="text-muted-foreground italic">{t('crm.importExport.emptyValue')}</span>}
            </li>
          );
        })}
      </ul>
      {data.length > 5 && (
        <p className="text-xs text-muted-foreground">
          {t('crm.importExport.andMoreRows', { n: data.length - 5 })}
        </p>
      )}
    </div>
  );
}

export function ImportEntitiesDialog({
  open,
  onOpenChange,
  entityLabel,
  fields,
  requireOneOf,
  templateExample,
  templateName,
  onImportBatch,
}: ImportEntitiesDialogProps) {
  const t = useTranslations();
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [parsedData, setParsedData] = useState<Record<string, unknown>[]>([]);
  const [sourceColumns, setSourceColumns] = useState<string[]>([]);
  const [mappings, setMappings] = useState<Mappings>({});
  const [focusedColumn, setFocusedColumn] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState({ processed: 0, total: 0 });
  const [running, setRunning] = useState({ imported: 0, updated: 0, failed: 0 });
  const [result, setResult] = useState<ImportEntitiesResult | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    // Reset whenever the dialog is (re)opened.
    cancelledRef.current = false;
    setStep('upload');
    setFile(null);
    setParsedData([]);
    setSourceColumns([]);
    setMappings({});
    setFocusedColumn(null);
    setParseError(null);
    setIsImporting(false);
    setProgress({ processed: 0, total: 0 });
    setRunning({ imported: 0, updated: 0, failed: 0 });
    setResult(null);
  }, [open]);

  const usedFields = useMemo(() => new Set(Object.values(mappings).filter(Boolean)), [mappings]);

  const requireLabels = useMemo(
    () =>
      requireOneOf
        .map((key) => fields.find((f) => f.accessorKey === key)?.header)
        .filter(Boolean)
        .join(', '),
    [requireOneOf, fields],
  );

  const triggerDownload = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const handleDownloadTemplate = useCallback(
    (format: 'csv' | 'xlsx') => {
      try {
        const { headers, row } = buildTemplateRows(fields, templateExample);
        if (format === 'csv') {
          const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
          const csv = [headers, row].map((r) => r.map(escape).join(',')).join('\n');
          triggerDownload(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `${templateName}.csv`);
        } else {
          const ws = XLSX.utils.aoa_to_sheet([headers, row]);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, templateName);
          const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
          triggerDownload(
            new Blob([buf], {
              type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            }),
            `${templateName}.xlsx`,
          );
        }
        toast.success(t('crm.importExport.templateDownloaded'));
      } catch (err) {
        console.error('[CRM import] template error:', err);
        toast.error(t('crm.importExport.failedToDownloadTemplate'));
      }
    },
    [fields, templateExample, templateName, triggerDownload, t],
  );

  const parseFile = useCallback(
    (f: File) => {
      setParseError(null);
      setFile(f);
      const reader = new FileReader();
      reader.onerror = () => {
        setParseError(t('crm.importExport.fileReadError'));
        setFile(null);
      };
      reader.onload = (e) => {
        try {
          const data = e.target?.result;
          if (!data) throw new Error('empty');
          const wb = XLSX.read(data, { type: 'binary', cellDates: true, cellNF: false, cellText: false });
          const sheet = wb.Sheets[wb.SheetNames[0]!];
          if (!sheet) throw new Error('no sheet');
          const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
            raw: false,
            defval: '',
            blankrows: false,
          });
          if (json.length === 0) {
            setParseError(t('crm.importExport.fileEmpty'));
            setFile(null);
            return;
          }
          if (json.length > MAX_ROWS) {
            setParseError(t('crm.importExport.fileTooManyRows'));
            setFile(null);
            return;
          }
          const columns = Object.keys(json[0]!).filter((c) => c && c.trim());
          if (columns.length === 0) {
            setParseError(t('crm.importExport.fileNoColumns'));
            setFile(null);
            return;
          }

          // Auto-map by normalized header/accessorKey match.
          const auto: Mappings = {};
          const used = new Set<string>();
          for (const col of columns) {
            const nCol = normalizeString(col);
            const match = fields.find((field) => {
              if (used.has(field.accessorKey)) return false;
              const nKey = normalizeString(field.accessorKey);
              const nHeader = normalizeString(field.header);
              return nKey === nCol || nHeader === nCol || nKey.includes(nCol) || nCol.includes(nKey);
            });
            if (match) {
              auto[col] = match.accessorKey;
              used.add(match.accessorKey);
            }
          }
          setSourceColumns(columns);
          setParsedData(json);
          setMappings(auto);
          setStep('mapping');
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'unknown';
          setParseError(t('crm.importExport.fileParseError', { error: msg }));
          setFile(null);
        }
      };
      reader.readAsBinaryString(f);
    },
    [fields, t],
  );

  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.accessorKey, f])), [fields]);

  const rowIsValid = useCallback(
    (row: Record<string, unknown>) => {
      for (const [sourceCol, key] of Object.entries(mappings)) {
        if (key && requireOneOf.includes(key) && safeString(row[sourceCol])) return true;
      }
      return false;
    },
    [mappings, requireOneOf],
  );

  const hasRequireMapped = useMemo(
    () => Object.values(mappings).some((key) => requireOneOf.includes(key)),
    [mappings, requireOneOf],
  );

  const validRows = useMemo(
    () => (hasRequireMapped ? parsedData.filter(rowIsValid) : []),
    [hasRequireMapped, parsedData, rowIsValid],
  );

  const mappedCount = useMemo(() => Object.values(mappings).filter(Boolean).length, [mappings]);

  const buildRecords = useCallback((): Record<string, unknown>[] => {
    const records: Record<string, unknown>[] = [];
    for (const row of validRows) {
      const record: Record<string, unknown> = {};
      for (const [sourceCol, key] of Object.entries(mappings)) {
        if (!key) continue;
        const field = fieldByKey.get(key);
        if (!field) continue;
        const raw = safeString(row[sourceCol]);
        if (!raw) continue;

        let value: unknown;
        if (field.multiValue) {
          const arr = raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
          if (!arr.length) continue;
          value = arr;
        } else {
          value = coerceScalar(raw, field.valueType);
          if (value === undefined) continue;
        }

        if (field.customFieldSlug) {
          const bag = (record.customFields as Record<string, unknown> | undefined) ?? {};
          bag[field.customFieldSlug] = value;
          record.customFields = bag;
        } else {
          record[key] = value;
        }
      }
      records.push(record);
    }
    return records;
  }, [validRows, mappings, fieldByKey]);

  const handleImport = useCallback(async () => {
    const records = buildRecords();
    if (records.length === 0) {
      toast.error(t('crm.importExport.noValidRows'));
      return;
    }

    cancelledRef.current = false;
    setIsImporting(true);
    setProgress({ processed: 0, total: records.length });
    setRunning({ imported: 0, updated: 0, failed: 0 });
    setStep('running');

    const agg: ImportEntitiesResult = {
      imported: 0,
      updated: 0,
      failed: 0,
      total: records.length,
      errors: [],
    };

    try {
      for (let start = 0; start < records.length; start += BATCH_SIZE) {
        if (cancelledRef.current) break;
        const batch = records.slice(start, start + BATCH_SIZE);
        const res = await onImportBatch(batch);
        agg.imported += res.imported;
        agg.updated += res.updated;
        agg.failed += res.failed;
        for (const e of res.errors) {
          // File line = header (1) + 0-based global index (start + e.row-1) + 1.
          agg.errors.push({ ...e, row: start + e.row + 1 });
        }
        setRunning({ imported: agg.imported, updated: agg.updated, failed: agg.failed });
        setProgress({ processed: Math.min(start + batch.length, records.length), total: records.length });
      }

      setResult(agg);
      setStep('result');

      const ok = agg.imported + agg.updated;
      if (agg.failed === 0) {
        toast.success(t('crm.importExport.importSuccess', { imported: agg.imported, updated: agg.updated }));
      } else if (ok > 0) {
        toast.warning(
          t('crm.importExport.importPartial', {
            imported: agg.imported,
            updated: agg.updated,
            failed: agg.failed,
          }),
        );
      } else {
        toast.error(t('crm.importExport.importAllFailed', { failed: agg.failed }));
      }
    } catch (err) {
      console.error('[CRM import] failed:', err);
      toast.error(t('crm.importExport.importFailed'));
      setResult(agg);
      setStep('result');
    } finally {
      setIsImporting(false);
    }
  }, [buildRecords, onImportBatch, t]);

  const handleClose = useCallback(() => {
    cancelledRef.current = true;
    onOpenChange(false);
  }, [onOpenChange]);

  const progressPct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className={cn('overflow-hidden p-0', step === 'mapping' ? 'md:!max-w-3xl lg:!max-w-5xl' : 'md:!max-w-lg lg:!max-w-2xl')}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t('crm.importExport.dialogTitle', { entity: entityLabel })}</DialogTitle>
          <DialogDescription>
            {t('crm.importExport.dialogDescription', { entity: entityLabel })}
          </DialogDescription>
        </DialogHeader>

        {step === 'upload' && (
          <div className="px-6 pt-3.5 pb-6">
            <h3 className="text-lg font-semibold mb-4">
              {t('crm.importExport.uploadHeading', { entity: entityLabel })}
            </h3>

            {parseError && (
              <Alert variant="destructive" className="mb-4">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{parseError}</AlertDescription>
              </Alert>
            )}

            <Dropzone
              accept={{
                'text/csv': ['.csv'],
                'application/vnd.ms-excel': ['.xls'],
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
              }}
              maxFiles={1}
              multiple={false}
              onDrop={(accepted, rejected) => {
                if (rejected.length > 0) {
                  setParseError(t('crm.importExport.invalidFileType'));
                  return;
                }
                if (accepted[0]) parseFile(accepted[0]);
              }}
              className="py-12"
            >
              <div className="flex flex-col items-center gap-3 text-center">
                <UploadIcon className="size-6 text-muted-foreground" />
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">{t('crm.importExport.dropFileHere')}</p>
                  <p className="text-muted-foreground text-xs">{t('crm.importExport.dropFileFormats')}</p>
                </div>
              </div>
            </Dropzone>

            <div className="mt-4 p-4 bg-muted rounded-lg">
              <h4 className="font-medium mb-2">{t('crm.importExport.tipsHeading')}</h4>
              <ul className="text-sm text-muted-foreground space-y-1 list-disc pl-4">
                <li>{t('crm.importExport.tip1')}</li>
                <li>{t('crm.importExport.tip2')}</li>
                <li>{t('crm.importExport.tip3')}</li>
              </ul>
            </div>

            <div className="mt-4">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    type="button"
                    className="w-full flex items-center gap-3 rounded-lg border border-border bg-background hover:bg-accent transition-colors px-4 py-3 text-left"
                  >
                    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted shrink-0">
                      <Download className="h-4 w-4 text-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground">
                        {t('crm.importExport.downloadTemplate')}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t('crm.importExport.downloadTemplateDesc')}
                      </div>
                    </div>
                    <ChevronsUpDown className="h-4 w-4 text-muted-foreground shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[--radix-dropdown-menu-trigger-width]">
                  <DropdownMenuItem onClick={() => handleDownloadTemplate('xlsx')}>
                    <FileSpreadsheet className="h-4 w-4 mr-0.5" />
                    Excel (.xlsx)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleDownloadTemplate('csv')}>
                    <FileSpreadsheet className="h-4 w-4 mr-0.5" />
                    CSV (.csv)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )}

        {step === 'mapping' && (
          <div>
            <div className="border-b px-6 py-4">
              <h3 className="text-lg font-semibold">{t('crm.importExport.configureMappingHeading')}</h3>
            </div>

            <div className="grid md:grid-cols-9">
              <div className="col-span-5 pt-6">
                <div className="px-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">{t('crm.importExport.matchSourceColumns')}</p>
                    <Badge variant="outline" className="rounded font-mono text-[12px]">
                      {t('crm.importExport.mappedOf', { mapped: mappedCount, total: sourceColumns.length })}
                    </Badge>
                  </div>

                  {!hasRequireMapped && (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertTitle>{t('crm.importExport.noKeyMappedTitle')}</AlertTitle>
                      <AlertDescription>
                        {t('crm.importExport.noKeyMappedDesc', { fields: requireLabels })}
                      </AlertDescription>
                    </Alert>
                  )}

                  {hasRequireMapped && validRows.length < parsedData.length && (
                    <Alert>
                      <AlertCircle className="h-4 w-4" />
                      <AlertTitle>{t('crm.importExport.someRowsSkipped')}</AlertTitle>
                      <AlertDescription>
                        {t('crm.importExport.someRowsSkippedDesc', { n: parsedData.length - validRows.length })}
                      </AlertDescription>
                    </Alert>
                  )}
                </div>

                <ScrollArea className="h-[400px] mt-4">
                  <div className="px-6 pb-6 space-y-4">
                    <div className="grid grid-cols-2 gap-4 text-xs font-semibold text-muted-foreground uppercase sticky top-0 bg-background py-2">
                      <p>{t('crm.importExport.sourceColumns')}</p>
                      <p>{t('crm.importExport.targetFields')}</p>
                    </div>
                    <ul className="space-y-3">
                      {sourceColumns.map((col) => (
                        <li key={col} className="grid grid-cols-2 gap-4 items-center">
                          <div className="flex items-center justify-between">
                            <Badge variant="outline" className="rounded font-mono text-[12px] max-w-[150px] truncate">
                              {col}
                            </Badge>
                            <ChevronRight className="size-4 text-muted-foreground flex-shrink-0" />
                          </div>
                          <FieldCombobox
                            t={t}
                            fields={fields}
                            value={mappings[col] || ''}
                            onValueChange={(value) => setMappings((prev) => ({ ...prev, [col]: value }))}
                            onFocus={() => setFocusedColumn(col)}
                            usedFields={usedFields}
                          />
                        </li>
                      ))}
                    </ul>
                  </div>
                </ScrollArea>
              </div>

              <div className="col-span-4 hidden bg-muted p-6 md:block">
                <DataPreviewList t={t} focusedColumn={focusedColumn} data={parsedData} />
                {!focusedColumn && (
                  <div className="text-sm text-muted-foreground text-center py-8">
                    {t('crm.importExport.previewHint')}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 border-t px-6 py-4">
              <p className="font-mono text-sm text-muted-foreground truncate min-w-0">
                {t('crm.importExport.fileStats', {
                  name: file?.name ?? '',
                  rows: parsedData.length,
                  valid: validRows.length,
                })}
              </p>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button variant="outline" onClick={() => setStep('upload')}>
                  {t('crm.importExport.backBtn')}
                </Button>
                <Button disabled={!hasRequireMapped || validRows.length === 0 || isImporting} onClick={handleImport}>
                  {isImporting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />
                      {t('crm.importExport.importingBtn')}
                    </>
                  ) : (
                    t('crm.importExport.importBtn', { n: validRows.length })
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}

        {step === 'running' && (
          <div className="p-6">
            <h3 className="text-lg font-semibold mb-6">
              {t('crm.importExport.importingHeading', { entity: entityLabel })}
            </h3>
            <div className="space-y-6">
              <div className="flex items-center gap-3">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
                <p className="text-sm font-medium">
                  {t('crm.importExport.importingProgress', {
                    processed: progress.processed,
                    total: progress.total,
                  })}
                </p>
              </div>
              <Progress value={progressPct} />
              <div className="grid grid-cols-3 gap-4 text-center">
                <div className="p-3 border rounded-md">
                  <p className="text-2xl font-bold text-green-600">{running.imported}</p>
                  <p className="text-xs text-muted-foreground">{t('crm.importExport.createdLabel')}</p>
                </div>
                <div className="p-3 border rounded-md">
                  <p className="text-2xl font-bold text-blue-600">{running.updated}</p>
                  <p className="text-xs text-muted-foreground">{t('crm.importExport.updatedLabel')}</p>
                </div>
                <div className="p-3 border rounded-md">
                  <p className="text-2xl font-bold text-red-600">{running.failed}</p>
                  <p className="text-xs text-muted-foreground">{t('crm.importExport.failedLabel')}</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 'result' && result && (
          <div className="p-6">
            <h3 className="text-lg font-semibold mb-6">{t('crm.importExport.completeHeading')}</h3>
            <div className="space-y-4">
              {(result.imported > 0 || result.updated > 0) && (
                <Alert>
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <AlertTitle>{t('crm.importExport.successfullyProcessed')}</AlertTitle>
                  <AlertDescription>
                    {result.imported > 0 && t('crm.importExport.createdN', { n: result.imported }) + ' '}
                    {result.updated > 0 && t('crm.importExport.updatedN', { n: result.updated })}
                  </AlertDescription>
                </Alert>
              )}

              {result.failed > 0 && (
                <Alert variant="destructive">
                  <XCircle className="h-4 w-4" />
                  <AlertTitle>{t('crm.importExport.failedToProcess')}</AlertTitle>
                  <AlertDescription>{t('crm.importExport.failedN', { n: result.failed })}</AlertDescription>
                </Alert>
              )}

              {result.errors.length > 0 && (
                <div>
                  <h4 className="font-medium mb-2">{t('crm.importExport.errorDetailsHeading')}</h4>
                  <ScrollArea className="h-[180px] border rounded-md p-3">
                    <ul className="space-y-1.5 text-sm">
                      {result.errors.slice(0, 100).map((e, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="text-muted-foreground whitespace-nowrap">
                            {t('crm.importExport.rowPrefix', { n: e.row })}
                          </span>
                          <span className="text-red-600">
                            {e.ref ? `${e.ref} — ` : ''}
                            {e.error}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </ScrollArea>
                </div>
              )}

              <div className="grid grid-cols-4 gap-3">
                {[
                  { value: result.imported, label: t('crm.importExport.createdLabel') },
                  { value: result.updated, label: t('crm.importExport.updatedLabel') },
                  { value: result.failed, label: t('crm.importExport.failedLabel') },
                  { value: result.total, label: t('crm.importExport.totalLabel') },
                ].map((cell, i) => (
                  <div key={i} className="rounded-lg border bg-card p-4 text-center">
                    <p className="font-mono text-xl font-bold text-foreground">{cell.value}</p>
                    <p className="text-sm text-muted-foreground">{cell.label}</p>
                  </div>
                ))}
              </div>

              <div className="flex justify-end">
                <Button onClick={handleClose}>{t('crm.importExport.doneButton')}</Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
