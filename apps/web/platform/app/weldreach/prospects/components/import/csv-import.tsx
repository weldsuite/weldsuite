/**
 * Import prospects from a CSV file. The file is read and parsed in the
 * browser, the user maps its columns, sees what is likely to be skipped, and
 * the rows go up in chunks of `REACH_IMPORT_MAX_ROWS` per request.
 */

import { useMemo, useRef, useState } from 'react';
import { FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { DialogFooter } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Progress } from '@weldsuite/ui/components/progress';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
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
import { useTranslations } from '@weldsuite/i18n/client';
import {
  REACH_IMPORT_MAX_ROWS,
  type ReachImportReport,
} from '@weldsuite/app-api-client/schemas/reach';
import { readTextFile } from '@/lib/read-text-file';
import { cn } from '@/lib/utils';
import {
  useImportReachProspects,
  useReachProspectLists,
} from '@/hooks/queries/use-reach-prospect-queries';
import { useReachFormat } from '@/app/weldreach/components/engage/format';
import {
  ErrorBanner,
  Notice,
  errorMessage,
  withoutTrailingPeriod,
} from '@/app/weldreach/components/engage/kit';
import { parseCsv, type ParsedCsv } from '../../lib/csv';
import {
  CUSTOM_FIELDS_MAX,
  PROSPECT_FIELDS,
  chunk,
  customFieldKeys,
  guessMapping,
  mergeReports,
  prepareImport,
  unmappedColumns,
  type ColumnMapping,
  type ProspectField,
} from '../../lib/import-mapping';
import { ImportReportView } from './import-report';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILE_ROWS = 50_000;
const NO_COLUMN = '__none__';
const PREVIEW_ROWS = 5;

const FIELD_LABEL_KEYS: Record<ProspectField, string> = {
  email: 'reachEngage.import.csv.fields.email',
  firstName: 'reachEngage.import.csv.fields.firstName',
  lastName: 'reachEngage.import.csv.fields.lastName',
  companyName: 'reachEngage.import.csv.fields.companyName',
  title: 'reachEngage.import.csv.fields.title',
  timezone: 'reachEngage.import.csv.fields.timezone',
};

type Destination = 'new' | 'existing' | 'none';

interface Loaded {
  fileName: string;
  parsed: ParsedCsv;
}

interface Outcome {
  report: ReachImportReport;
  error: string | null;
}

export function CsvImport({
  onClose,
  onViewList,
}: Readonly<{ onClose: () => void; onViewList: (listId: string) => void }>) {
  const t = useTranslations();
  const format = useReachFormat();
  const importRows = useImportReachProspects();
  const lists = useReachProspectLists();
  const fileInput = useRef<HTMLInputElement>(null);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [customColumns, setCustomColumns] = useState<Set<number>>(new Set());
  const [destination, setDestination] = useState<Destination>('new');
  const [listName, setListName] = useState('');
  const [existingListId, setExistingListId] = useState<string | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function load(file: File) {
    setFailure(null);
    if (file.size > MAX_FILE_BYTES) {
      setFailure(t('reachEngage.import.csv.tooLarge'));
      return;
    }
    try {
      const parsed = parseCsv(await readTextFile(file));
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        setFailure(t('reachEngage.import.csv.empty'));
        return;
      }
      if (parsed.rows.length > MAX_FILE_ROWS) {
        setFailure(t('reachEngage.import.csv.tooManyRows', { count: format.number(MAX_FILE_ROWS) }));
        return;
      }
      const guessed = guessMapping(parsed.headers);
      setLoaded({ fileName: file.name, parsed });
      setMapping(guessed);
      setCustomColumns(
        new Set(unmappedColumns(parsed.headers, guessed).slice(0, CUSTOM_FIELDS_MAX)),
      );
      setListName(file.name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      setFailure(errorMessage(err, t('reachEngage.import.csv.readFailed')));
    }
  }

  function reset() {
    setLoaded(null);
    setMapping(null);
    setFailure(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  function chooseColumn(field: ProspectField, value: string) {
    setMapping((current) => {
      if (!current) return current;
      const index = value === NO_COLUMN ? null : Number(value);
      const next = { ...current };
      // A column feeds one field: taking it from another field unmaps that one.
      for (const other of PROSPECT_FIELDS) {
        if (index !== null && other !== field && next[other] === index) next[other] = null;
      }
      next[field] = index;
      return next;
    });
    // A column that became a field is no longer a custom field.
    if (value !== NO_COLUMN) {
      setCustomColumns((current) => {
        const next = new Set(current);
        next.delete(Number(value));
        return next;
      });
    }
  }

  function toggleCustom(column: number) {
    setCustomColumns((current) => {
      const next = new Set(current);
      if (next.has(column)) next.delete(column);
      else if (next.size < CUSTOM_FIELDS_MAX) next.add(column);
      return next;
    });
  }

  const extraColumns = useMemo(
    () => (loaded && mapping ? unmappedColumns(loaded.parsed.headers, mapping) : []),
    [loaded, mapping],
  );
  const keys = useMemo(
    () => (loaded ? customFieldKeys(loaded.parsed.headers, extraColumns) : new Map<number, string>()),
    [loaded, extraColumns],
  );
  const selectedCustom = useMemo(
    () => extraColumns.filter((column) => customColumns.has(column)),
    [extraColumns, customColumns],
  );
  const prepared = useMemo(
    () => (loaded && mapping ? prepareImport(loaded.parsed, mapping, selectedCustom, keys) : null),
    [loaded, mapping, selectedCustom, keys],
  );

  const emailMapped = mapping?.email !== null && mapping?.email !== undefined;
  const destinationReady =
    destination === 'none' ||
    (destination === 'new' && listName.trim() !== '') ||
    (destination === 'existing' && Boolean(existingListId));
  const canImport = Boolean(prepared && prepared.rows.length > 0 && emailMapped && destinationReady);

  async function run() {
    if (!prepared) return;
    setFailure(null);
    const batches = chunk(prepared.rows, REACH_IMPORT_MAX_ROWS);
    const reports: ReachImportReport[] = [];
    let listId: string | undefined = destination === 'existing' ? existingListId : undefined;
    const newListName = destination === 'new' ? listName.trim() : undefined;
    const local = { invalid: prepared.stats.invalid, duplicate: prepared.stats.duplicate };

    setProgress({ done: 0, total: prepared.rows.length });
    let sent = 0;
    try {
      for (const rows of batches) {
        const res = await importRows.mutateAsync({
          rows,
          listId,
          // Only the first request creates the list; the rest add to it.
          listName: listId ? undefined : newListName,
          sourceRef: loaded?.fileName,
        });
        reports.push(res.data);
        listId = res.data.listId ?? listId;
        sent += rows.length;
        setProgress({ done: sent, total: prepared.rows.length });
      }
      setOutcome({ report: mergeReports(reports, local), error: null });
    } catch (err) {
      setOutcome({
        report: mergeReports(reports, { invalid: 0, duplicate: 0 }),
        error: t('reachEngage.import.csv.stopped', {
          sent: format.number(sent),
          total: format.number(prepared.rows.length),
          message: withoutTrailingPeriod(errorMessage(err, t('reachEngage.import.csv.failed'))),
        }),
      });
    } finally {
      setProgress(null);
    }
  }

  if (outcome) {
    return (
      <ImportReportView
        report={outcome.report}
        error={outcome.error}
        onClose={onClose}
        onViewList={onViewList}
      />
    );
  }

  if (!loaded || !mapping || !prepared) {
    return (
      <div className="space-y-4">
        <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
        <label
          htmlFor="reach-import-file"
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (file) void load(file);
          }}
          className={cn(
            'flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors',
            dragging ? 'border-primary bg-primary/5' : 'hover:bg-muted/40',
          )}
        >
          <Upload className="h-8 w-8 text-muted-foreground" strokeWidth={1.5} />
          <span className="text-sm font-medium">{t('reachEngage.import.csv.dropTitle')}</span>
          <span className="text-xs text-muted-foreground">{t('reachEngage.import.csv.dropHint')}</span>
          <input
            ref={fileInput}
            id="reach-import-file"
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/plain"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void load(file);
            }}
          />
        </label>
        <Notice>{t('reachEngage.import.b2bNote')}</Notice>
      </div>
    );
  }

  const running = progress !== null;
  const { stats } = prepared;
  const previewRows = prepared.rows.slice(0, PREVIEW_ROWS);

  return (
    <div className="space-y-5">
      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <FileSpreadsheet className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{loaded.fileName}</span>
          <span className="shrink-0 text-muted-foreground">
            {t('reachEngage.import.csv.fileSummary', {
              rows: format.number(loaded.parsed.rows.length),
              columns: format.number(loaded.parsed.headers.length),
            })}
          </span>
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={running}>
          {t('reachEngage.import.csv.chooseAnother')}
        </Button>
      </div>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">{t('reachEngage.import.csv.mapTitle')}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {PROSPECT_FIELDS.map((field) => (
            <div key={field} className="space-y-1.5">
              <Label id={`reach-map-${field}`}>
                {t(FIELD_LABEL_KEYS[field])}
                {field === 'email' && <span className="text-destructive"> *</span>}
              </Label>
              <Select
                value={mapping[field] === null ? NO_COLUMN : String(mapping[field])}
                onValueChange={(value) => chooseColumn(field, value)}
                disabled={running}
              >
                <SelectTrigger size="sm" aria-labelledby={`reach-map-${field}`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={NO_COLUMN}>{t('reachEngage.import.csv.noColumn')}</SelectItem>
                  {loaded.parsed.headers.map((header, index) => (
                    <SelectItem key={`${index}-${header}`} value={String(index)}>
                      {header || t('reachEngage.import.csv.unnamedColumn', { number: index + 1 })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
        {!emailMapped && (
          <p className="text-xs text-destructive">{t('reachEngage.import.csv.emailRequired')}</p>
        )}
      </section>

      {extraColumns.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('reachEngage.import.csv.customTitle')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('reachEngage.import.csv.customHint', { example: '{{key}}' })}
          </p>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {extraColumns.map((column) => (
              <li key={column}>
                <label className="flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm">
                  <Checkbox
                    checked={customColumns.has(column)}
                    disabled={running}
                    onCheckedChange={() => toggleCustom(column)}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {loaded.parsed.headers[column] || t('reachEngage.import.csv.unnamedColumn', { number: column + 1 })}
                  </span>
                  <code className="shrink-0 text-xs text-muted-foreground">{`{{${keys.get(column) ?? ''}}}`}</code>
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">{t('reachEngage.import.csv.checksTitle')}</h3>
        <p className="text-sm">
          {t('reachEngage.import.csv.ready', {
            count: format.number(prepared.rows.length),
            total: format.number(stats.total),
          })}
        </p>
        <ul className="space-y-1 text-sm text-muted-foreground">
          {stats.invalid > 0 && (
            <li>{t('reachEngage.import.csv.checkInvalid', { count: format.number(stats.invalid) })}</li>
          )}
          {stats.duplicate > 0 && (
            <li>{t('reachEngage.import.csv.checkDuplicate', { count: format.number(stats.duplicate) })}</li>
          )}
        </ul>
        {stats.consumer > 0 && (
          <Notice tone="warning">
            {t('reachEngage.import.csv.checkConsumer', { count: format.number(stats.consumer) })}
          </Notice>
        )}
        {stats.role > 0 && (
          <Notice tone="warning">
            {t('reachEngage.import.csv.checkRole', { count: format.number(stats.role) })}
          </Notice>
        )}
        <Notice>{t('reachEngage.import.b2bNote')}</Notice>

        {previewRows.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('reachEngage.import.csv.fields.email')}</TableHead>
                  <TableHead>{t('reachEngage.import.csv.fields.firstName')}</TableHead>
                  <TableHead>{t('reachEngage.import.csv.fields.lastName')}</TableHead>
                  <TableHead>{t('reachEngage.import.csv.fields.companyName')}</TableHead>
                  <TableHead>{t('reachEngage.import.csv.fields.title')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {previewRows.map((row) => (
                  <TableRow key={row.email}>
                    <TableCell className="font-medium">{row.email}</TableCell>
                    <TableCell>{row.firstName ?? '—'}</TableCell>
                    <TableCell>{row.lastName ?? '—'}</TableCell>
                    <TableCell>{row.companyName ?? '—'}</TableCell>
                    <TableCell>{row.title ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">{t('reachEngage.import.csv.destinationTitle')}</h3>
        <RadioGroup
          value={destination}
          onValueChange={(value) => setDestination(value as Destination)}
          className="space-y-2"
          disabled={running}
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="new" id="reach-import-dest-new" />
            <Label htmlFor="reach-import-dest-new">{t('reachEngage.import.csv.destNew')}</Label>
          </div>
          {destination === 'new' && (
            <Input
              value={listName}
              onChange={(event) => setListName(event.target.value)}
              aria-label={t('reachEngage.import.csv.listName')}
              placeholder={t('reachEngage.import.csv.listName')}
              disabled={running}
              className="ml-6 w-auto max-w-sm"
            />
          )}
          <div className="flex items-center gap-2">
            <RadioGroupItem
              value="existing"
              id="reach-import-dest-existing"
              disabled={(lists.data ?? []).length === 0}
            />
            <Label htmlFor="reach-import-dest-existing">{t('reachEngage.import.csv.destExisting')}</Label>
          </div>
          {destination === 'existing' && (
            <Select value={existingListId ?? ''} onValueChange={setExistingListId} disabled={running}>
              <SelectTrigger
                size="sm"
                aria-label={t('reachEngage.import.csv.destExisting')}
                className="ml-6 w-auto min-w-48 max-w-sm"
              >
                <SelectValue placeholder={t('reachEngage.import.csv.pickList')} />
              </SelectTrigger>
              <SelectContent>
                {(lists.data ?? []).map((list) => (
                  <SelectItem key={list.id} value={list.id}>
                    {list.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="flex items-center gap-2">
            <RadioGroupItem value="none" id="reach-import-dest-none" />
            <Label htmlFor="reach-import-dest-none">{t('reachEngage.import.csv.destNone')}</Label>
          </div>
        </RadioGroup>
      </section>

      {progress && (
        <div className="space-y-1.5" role="status">
          <Progress value={progress.total > 0 ? (progress.done / progress.total) * 100 : 0} />
          <p className="text-xs text-muted-foreground">
            {t('reachEngage.import.csv.progress', {
              done: format.number(progress.done),
              total: format.number(progress.total),
            })}
          </p>
        </div>
      )}

      {/* Stays in view while the long mapping form scrolls inside the dialog. */}
      <DialogFooter className="sticky -bottom-6 -mx-6 -mb-6 border-t bg-background px-6 pb-6 pt-4">
        <Button type="button" variant="outline" onClick={onClose} disabled={running}>
          {t('reachEngage.common.cancel')}
        </Button>
        <Button type="button" onClick={() => void run()} disabled={!canImport || running}>
          {running && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('reachEngage.import.csv.start', { count: format.number(prepared.rows.length) })}
        </Button>
      </DialogFooter>
    </div>
  );
}
