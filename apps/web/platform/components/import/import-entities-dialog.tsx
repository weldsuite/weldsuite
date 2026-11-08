/**
 * The platform's CSV / Excel import wizard: CRM Companies and People, and the
 * record list of every custom object.
 *
 * Upload → map columns → run → result. Modeled on the WeldFlow task importer
 * but synchronous and client-chunked: valid rows are split into batches and
 * each batch is POSTed to the entity's import endpoint via `onImportBatch`,
 * accumulating counts to drive the progress bar. No background-job infra.
 *
 * Parameterized per entity via `fields` / `requireOneOf` / `templateExample`
 * (and `tips`, `showUpdated`, `batchSize`), so every importer reuses one
 * dialog. Its texts live in `common.import`.
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
import { useI18n } from '@weldsuite/i18n/provider';

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
import { readImportRows } from './import-file';
import { asText } from '@weldsuite/text';

export interface ImportFieldDef {
  /** Localized label shown in the mapping UI + template header. */
  header: string;
  /** Field key sent to the server (matches the create schema). */
  accessorKey: string;
  /**
   * Extra header text(s) that should also auto-map to this field — notably
   * the grid column's own display name, which is often worded differently
   * from the import field's label (e.g. the Companies grid's "Company"
   * column vs. the import field's "Name"; "Employees" vs. "Employee
   * count"). Without this, re-importing the app's own CSV/Excel export
   * requires manually remapping every such column. Compared the same way
   * as `header`/`accessorKey` (normalized, substring-tolerant).
   */
  aliases?: string[];
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
  /**
   * Fields the server needs to CREATE a new row (not just to match an
   * existing one) — e.g. Companies require `name` on create, but a row
   * missing it can still "valid" per `requireOneOf` because it matches an
   * existing company by party code/email. When set, rows that are valid
   * per `requireOneOf` but missing every field here are called out before
   * import instead of only surfacing as a per-row server error afterward.
   */
  requiredForCreate?: string[];
  /** Example values for the downloadable template, keyed by accessorKey. */
  templateExample?: Record<string, string>;
  /** Base filename (no extension) for the template, e.g. "companies". */
  templateName: string;
  /** The upload step's tips; default: match columns, download the template. */
  tips?: string[];
  /**
   * Whether the import can update existing rows (CRM upserts). An import that
   * only creates (custom objects) hides the "Updated" counts.
   */
  showUpdated?: boolean;
  /** Rows per `onImportBatch` call (default 200, the import endpoints' limit). */
  batchSize?: number;
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
    return asText(value).trim();
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

/** Resolve a raw cell string to the value stored for a field, or undefined to skip it. */
function resolveFieldValue(raw: string, field: ImportFieldDef): unknown {
  if (field.multiValue) {
    const arr = raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    return arr.length ? arr : undefined;
  }
  return coerceScalar(raw, field.valueType);
}

/** Build one import record from a source row using the column -> field mappings. */
function buildRecord(
  row: Record<string, unknown>,
  mappings: Mappings,
  fieldByKey: Map<string, ImportFieldDef>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [sourceCol, key] of Object.entries(mappings)) {
    if (!key) continue;
    const field = fieldByKey.get(key);
    if (!field) continue;
    const raw = safeString(row[sourceCol]);
    if (!raw) continue;

    const value = resolveFieldValue(raw, field);
    if (value === undefined) continue;

    if (field.customFieldSlug) {
      const bag = (record.customFields as Record<string, unknown> | undefined) ?? {};
      bag[field.customFieldSlug] = value;
      record.customFields = bag;
    } else {
      record[key] = value;
    }
  }
  return record;
}

// ── Field picker (one per file column) ───────────────────────────────────────

function FieldCombobox({
  t,
  fields,
  value,
  onValueChange,
  onFocus,
  usedFields,
}: Readonly<{
  t: Tfn;
  fields: ImportFieldDef[];
  value: string;
  onValueChange: (value: string) => void;
  onFocus: () => void;
  usedFields: Set<string>;
}>) {
  const [open, setOpen] = useState(false);
  const selected = fields.find((f) => f.accessorKey === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild onClick={onFocus}>
        <Button variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between h-9">
          <span className="truncate">
            {selected ? selected.header : t('common.import.skipThisColumn')}
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
          <CommandInput placeholder={t('common.import.searchFields')} />
          <CommandList>
            <CommandEmpty>{t('common.import.noFieldFound')}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__skip__"
                onSelect={() => {
                  onValueChange('');
                  setOpen(false);
                }}
                className={cn(value === '' && 'bg-accent text-accent-foreground')}
              >
                <span className="text-muted-foreground">{t('common.import.skipThisColumn')}</span>
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
                        {t('common.import.usedBadge')}
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
}: Readonly<{
  t: Tfn;
  focusedColumn: string | null;
  data: Record<string, unknown>[];
}>) {
  if (!focusedColumn || data.length === 0) return null;
  const preview = data.slice(0, 5).map((item, index) => ({
    rowId: `sample-row-${index}`,
    value: safeString(item[focusedColumn]),
  }));
  return (
    <div className="space-y-2 border bg-background p-4 pb-1 rounded-md">
      <p className="text-sm font-semibold">
        {t('common.import.sampleValuesFor', { field: focusedColumn })}
      </p>
      <ul>
        {preview.map(({ rowId, value }) => (
          <li key={rowId} className="border-b py-3 text-sm first:border-t last:border-b-0 truncate">
            {value || <span className="text-muted-foreground italic">{t('common.import.emptyValue')}</span>}
          </li>
        ))}
      </ul>
      {data.length > 5 && (
        <p className="text-xs text-muted-foreground">
          {t('common.import.andMoreRows', { n: data.length - 5 })}
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
  requiredForCreate,
  templateExample,
  templateName,
  tips,
  showUpdated = true,
  batchSize = BATCH_SIZE,
  onImportBatch,
}: Readonly<ImportEntitiesDialogProps>) {
  const t = useTranslations();
  const { plural } = useI18n();
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
    a.remove();
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
        toast.success(t('common.import.templateDownloaded'));
      } catch (err) {
        console.error('[import] template error:', err);
        toast.error(t('common.import.failedToDownloadTemplate'));
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
        setParseError(t('common.import.fileReadError'));
        setFile(null);
      };
      reader.onload = (e) => {
        try {
          const data = e.target?.result;
          if (!(data instanceof ArrayBuffer) || data.byteLength === 0) throw new Error('empty');
          const json = readImportRows(data);
          if (json.length === 0) {
            setParseError(t('common.import.fileEmpty'));
            setFile(null);
            return;
          }
          if (json.length > MAX_ROWS) {
            setParseError(t('common.import.fileTooManyRows'));
            setFile(null);
            return;
          }
          const columns = Object.keys(json[0]!).filter((c) => c?.trim());
          if (columns.length === 0) {
            setParseError(t('common.import.fileNoColumns'));
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
              if (nKey === nCol || nHeader === nCol || nKey.includes(nCol) || nCol.includes(nKey)) {
                return true;
              }
              return (field.aliases ?? []).some((alias) => {
                const nAlias = normalizeString(alias);
                return nAlias === nCol || nAlias.includes(nCol) || nCol.includes(nAlias);
              });
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
          setParseError(t('common.import.fileParseError', { error: msg }));
          setFile(null);
        }
      };
      reader.readAsArrayBuffer(f);
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

  // With a `requiredForCreate` column mapped (Companies: Name) the file is
  // meant to create rows, so a row that is blank in all of them cannot be
  // created and is skipped like any other unusable row. Without one mapped the
  // file can only update rows that already exist (matched by party code /
  // email), so every row that passes `requireOneOf` is still sent.
  const createFieldMapped = useMemo(
    () =>
      !requiredForCreate ||
      requiredForCreate.length === 0 ||
      Object.values(mappings).some((key) => requiredForCreate.includes(key)),
    [mappings, requiredForCreate],
  );

  // The rows the import will send: what the footer calls "valid" and what the
  // Import button counts, so the two always agree.
  const importableRows = useMemo(() => {
    if (!createFieldMapped || !requiredForCreate) return validRows;
    return validRows.filter((row) => {
      const record = buildRecord(row, mappings, fieldByKey);
      return requiredForCreate.some((key) => safeString(record[key]));
    });
  }, [validRows, createFieldMapped, requiredForCreate, mappings, fieldByKey]);

  // Update-only file (no create column mapped): rows import only when they
  // match an existing record, which the server decides — say so up front.
  const matchOnlyRows = createFieldMapped ? 0 : validRows.length;
  const missingCreateParams = {
    n: matchOnlyRows,
    fields: requiredForCreate?.map((key) => fieldByKey.get(key)?.header ?? key).join(', ') ?? '',
  };
  const fileStatsParams = {
    name: file?.name ?? '',
    rows: parsedData.length,
    valid: importableRows.length,
  };
  const skippedRows = parsedData.length - importableRows.length;

  const mappedCount = useMemo(() => Object.values(mappings).filter(Boolean).length, [mappings]);

  const buildRecords = useCallback(
    (): Record<string, unknown>[] => importableRows.map((row) => buildRecord(row, mappings, fieldByKey)),
    [importableRows, mappings, fieldByKey],
  );

  const handleImport = useCallback(async () => {
    const records = buildRecords();
    if (records.length === 0) {
      toast.error(t('common.import.noValidRows'));
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
      for (let start = 0; start < records.length; start += batchSize) {
        if (cancelledRef.current) break;
        const batch = records.slice(start, start + batchSize);
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
      const counts = { imported: agg.imported, updated: agg.updated, failed: agg.failed };
      if (agg.failed === 0) {
        toast.success(t(showUpdated ? 'common.import.importSuccess' : 'common.import.importCreatedOnly', counts));
      } else if (ok > 0) {
        toast.warning(
          t(showUpdated ? 'common.import.importPartial' : 'common.import.importPartialCreatedOnly', counts),
        );
      } else {
        toast.error(t('common.import.importAllFailed', { failed: agg.failed }));
      }
    } catch (err) {
      console.error('[import] failed:', err);
      toast.error(t('common.import.importFailed'));
      setResult(agg);
      setStep('result');
    } finally {
      setIsImporting(false);
    }
  }, [buildRecords, onImportBatch, t, batchSize, showUpdated]);

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
          <DialogTitle>{t('common.import.dialogTitle', { entity: entityLabel })}</DialogTitle>
          <DialogDescription>
            {t('common.import.dialogDescription', { entity: entityLabel })}
          </DialogDescription>
        </DialogHeader>

        {step === 'upload' && (
          <div className="px-6 pt-3.5 pb-6">
            <h3 className="text-lg font-semibold mb-4">
              {t('common.import.uploadHeading', { entity: entityLabel })}
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
                  setParseError(t('common.import.invalidFileType'));
                  return;
                }
                if (accepted[0]) parseFile(accepted[0]);
              }}
              className="py-12"
            >
              <div className="flex flex-col items-center gap-3 text-center">
                <UploadIcon className="size-6 text-muted-foreground" />
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">{t('common.import.dropFileHere')}</p>
                  <p className="text-muted-foreground text-xs">{t('common.import.dropFileFormats')}</p>
                </div>
              </div>
            </Dropzone>

            <div className="mt-4 p-4 bg-muted rounded-lg">
              <h4 className="font-medium mb-2">{t('common.import.tipsHeading')}</h4>
              <ul className="text-sm text-muted-foreground space-y-1 list-disc pl-4">
                {(tips ?? [t('common.import.tipMatch'), t('common.import.tipTemplate')]).map((tip) => (
                  <li key={tip}>{tip}</li>
                ))}
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
                        {t('common.import.downloadTemplate')}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t('common.import.downloadTemplateDesc')}
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
              <h3 className="text-lg font-semibold">{t('common.import.configureMappingHeading')}</h3>
            </div>

            <div className="grid md:grid-cols-9">
              <div className="col-span-5 pt-6">
                <div className="px-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">{t('common.import.matchSourceColumns')}</p>
                    <Badge variant="outline" className="rounded font-mono text-[12px]">
                      {t('common.import.mappedOf', { mapped: mappedCount, total: sourceColumns.length })}
                    </Badge>
                  </div>

                  {!hasRequireMapped && (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertTitle>{t('common.import.noKeyMappedTitle')}</AlertTitle>
                      <AlertDescription>
                        {t('common.import.noKeyMappedDesc', { fields: requireLabels })}
                      </AlertDescription>
                    </Alert>
                  )}

                  {hasRequireMapped && skippedRows > 0 && (
                    <Alert>
                      <AlertCircle className="h-4 w-4" />
                      <AlertTitle>{t('common.import.someRowsSkipped')}</AlertTitle>
                      <AlertDescription>
                        {plural(skippedRows, {
                          one: t('common.import.someRowsSkippedDescOne', { n: skippedRows }),
                          other: t('common.import.someRowsSkippedDesc', { n: skippedRows }),
                        })}
                      </AlertDescription>
                    </Alert>
                  )}

                  {hasRequireMapped && matchOnlyRows > 0 && (
                    <Alert>
                      <AlertCircle className="h-4 w-4" />
                      <AlertTitle>{t('common.import.missingCreateFieldTitle')}</AlertTitle>
                      <AlertDescription>
                        {plural(matchOnlyRows, {
                          one: t('common.import.missingCreateFieldDescOne', missingCreateParams),
                          other: t('common.import.missingCreateFieldDesc', missingCreateParams),
                        })}
                      </AlertDescription>
                    </Alert>
                  )}
                </div>

                <ScrollArea className="h-[400px] mt-4">
                  <div className="px-6 pb-6 space-y-4">
                    <div className="grid grid-cols-2 gap-4 text-xs font-semibold text-muted-foreground uppercase sticky top-0 bg-background py-2">
                      <p>{t('common.import.sourceColumns')}</p>
                      <p>{t('common.import.targetFields')}</p>
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
                    {t('common.import.previewHint')}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 border-t px-6 py-4">
              <p className="font-mono text-sm text-muted-foreground truncate min-w-0">
                {plural(parsedData.length, {
                  one: t('common.import.fileStatsOne', fileStatsParams),
                  other: t('common.import.fileStats', fileStatsParams),
                })}
              </p>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button variant="outline" onClick={() => setStep('upload')}>
                  {t('common.import.backBtn')}
                </Button>
                <Button disabled={!hasRequireMapped || importableRows.length === 0 || isImporting} onClick={handleImport}>
                  {isImporting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />
                      {t('common.import.importingBtn')}
                    </>
                  ) : (
                    t('common.import.importBtn', { n: importableRows.length })
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}

        {step === 'running' && (
          <div className="p-6">
            <h3 className="text-lg font-semibold mb-6">
              {t('common.import.importingHeading', { entity: entityLabel })}
            </h3>
            <div className="space-y-6">
              <div className="flex items-center gap-3">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
                <p className="text-sm font-medium">
                  {t('common.import.importingProgress', {
                    processed: progress.processed,
                    total: progress.total,
                  })}
                </p>
              </div>
              <Progress value={progressPct} />
              <div className={cn('grid gap-4 text-center', showUpdated ? 'grid-cols-3' : 'grid-cols-2')}>
                <div className="p-3 border rounded-md">
                  <p className="text-2xl font-bold text-green-600">{running.imported}</p>
                  <p className="text-xs text-muted-foreground">{t('common.import.createdLabel')}</p>
                </div>
                {showUpdated && (
                  <div className="p-3 border rounded-md">
                    <p className="text-2xl font-bold text-blue-600">{running.updated}</p>
                    <p className="text-xs text-muted-foreground">{t('common.import.updatedLabel')}</p>
                  </div>
                )}
                <div className="p-3 border rounded-md">
                  <p className="text-2xl font-bold text-red-600">{running.failed}</p>
                  <p className="text-xs text-muted-foreground">{t('common.import.failedLabel')}</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 'result' && result && (
          <div className="p-6">
            <h3 className="text-lg font-semibold mb-6">{t('common.import.completeHeading')}</h3>
            <div className="space-y-4">
              {(result.imported > 0 || result.updated > 0) && (
                <Alert>
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <AlertTitle>{t('common.import.successfullyProcessed')}</AlertTitle>
                  <AlertDescription>
                    {result.imported > 0 && t('common.import.createdN', { n: result.imported }) + ' '}
                    {result.updated > 0 && t('common.import.updatedN', { n: result.updated })}
                  </AlertDescription>
                </Alert>
              )}

              {result.failed > 0 && (
                <Alert variant="destructive">
                  <XCircle className="h-4 w-4" />
                  <AlertTitle>{t('common.import.failedToProcess')}</AlertTitle>
                  <AlertDescription>
                    {plural(result.failed, {
                      one: t('common.import.failedNOne'),
                      other: t('common.import.failedN'),
                    })}
                  </AlertDescription>
                </Alert>
              )}

              {result.errors.length > 0 && (
                <div>
                  <h4 className="font-medium mb-2">{t('common.import.errorDetailsHeading')}</h4>
                  <ScrollArea className="h-[180px] border rounded-md p-3">
                    <ul className="space-y-1.5 text-sm">
                      {result.errors.slice(0, 100).map((e, index) => ({ e, errorId: `import-error-${index}` })).map(({ e, errorId }) => (
                        <li key={errorId} className="flex items-start gap-2">
                          <span className="text-muted-foreground whitespace-nowrap">
                            {t('common.import.rowPrefix', { n: e.row })}
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

              <div className={cn('grid gap-3', showUpdated ? 'grid-cols-4' : 'grid-cols-3')}>
                {[
                  { value: result.imported, label: t('common.import.createdLabel') },
                  ...(showUpdated ? [{ value: result.updated, label: t('common.import.updatedLabel') }] : []),
                  { value: result.failed, label: t('common.import.failedLabel') },
                  { value: result.total, label: t('common.import.totalLabel') },
                ].map((cell) => (
                  <div key={cell.label} className="rounded-lg border bg-card p-4 text-center">
                    <p className="font-mono text-xl font-bold text-foreground">{cell.value}</p>
                    <p className="text-sm text-muted-foreground">{cell.label}</p>
                  </div>
                ))}
              </div>

              <div className="flex justify-end">
                <Button onClick={handleClose}>{t('common.import.doneButton')}</Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
