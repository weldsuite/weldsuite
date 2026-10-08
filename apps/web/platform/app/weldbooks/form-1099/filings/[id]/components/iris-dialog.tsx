import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Download, FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { useIrisFiles } from '@/hooks/queries/use-weldbooks-1099-queries';
import type { IrisFilesResult } from '@/lib/api/domains/weldbooks-1099';
import { useI18n } from '@/lib/i18n/provider';
import { downloadBlob } from '@/lib/weldbooks/download';

interface IrisDialogProps {
  filingId: string;
  formLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The IRIS template is a CSV; only its header row matters, and no real header row is anywhere near this long. */
const MAX_TEMPLATE_BYTES = 200_000;

/** The first line of a CSV text, without the BOM Excel puts in front of it. */
export function firstCsvLine(text: string): string {
  return (text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '').trim();
}

/**
 * Creates the IRIS upload files of a generated filing: one CSV per 100
 * recipients, in the IRS's own column order. The files carry full TINs, so
 * they live in this dialog's state only and are dropped when it closes; the
 * server records a reveal for each recipient.
 */
export function IrisDialog({ filingId, formLabel, open, onOpenChange }: Readonly<IrisDialogProps>) {
  const { t } = useI18n();
  const ti = t.weldbooksUs.form1099.iris;
  const iris = useIrisFiles();
  const [result, setResult] = useState<IrisFilesResult | null>(null);
  const [templateLine, setTemplateLine] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState<string | null>(null);
  const templateInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setResult(null);
      setTemplateLine(null);
      setTemplateName(null);
    }
  }, [open]);

  const pickTemplate = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_TEMPLATE_BYTES) {
      toast.error(ti.templateTooLarge);
      return;
    }
    const line = firstCsvLine(await file.text());
    if (!line) {
      toast.error(ti.templateEmpty);
      return;
    }
    setTemplateLine(line);
    setTemplateName(file.name);
    setResult(null);
    if (templateInput.current) templateInput.current.value = '';
  };

  const generate = async () => {
    try {
      setResult(await iris.run(filingId, templateLine ?? undefined));
    } catch (err) {
      toast.error(ti.failed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const save = (filename: string, content: string) => downloadBlob(new Blob([content], { type: 'text/csv;charset=utf-8' }), filename);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{ti.title.replace('{form}', formLabel)}</DialogTitle>
          <DialogDescription>{ti.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">{ti.templateTitle}</p>
            <p className="text-xs text-muted-foreground">{ti.templateHelp}</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={templateInput}
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                aria-label={ti.chooseTemplate}
                onChange={(event) => void pickTemplate(event.target.files?.[0])}
              />
              <Button type="button" size="sm" variant="outline" onClick={() => templateInput.current?.click()}>
                <Upload className="mr-1 h-4 w-4" aria-hidden />
                {ti.chooseTemplate}
              </Button>
              {templateName ? (
                <span className="flex items-center gap-1 text-sm text-muted-foreground" data-testid="iris-template-name">
                  <FileSpreadsheet className="h-4 w-4" aria-hidden />
                  {templateName}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setTemplateLine(null);
                      setTemplateName(null);
                    }}
                  >
                    {ti.removeTemplate}
                  </Button>
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">{ti.builtIn}</span>
              )}
            </div>
          </div>

          {result ? (
            <div className="space-y-3 rounded-md border p-3" data-testid="iris-result">
              <p className="text-sm font-medium">
                {(result.correctionsOnly ? ti.readyCorrections : ti.ready).replace(
                  '{n}',
                  String(result.files.reduce((sum, f) => sum + f.recordCount, 0)),
                )}
              </p>
              <ul className="space-y-2">
                {result.files.map((file) => (
                  <li key={file.filename} className="space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span>
                        {file.filename} <span className="text-muted-foreground">({ti.records.replace('{n}', String(file.recordCount))})</span>
                      </span>
                      <Button type="button" size="sm" variant="outline" onClick={() => save(file.filename, file.content)}>
                        <Download className="mr-1 h-4 w-4" aria-hidden />
                        {ti.download}
                      </Button>
                    </div>
                    {file.warnings && file.warnings.length > 0 ? (
                      <ul className="space-y-0.5 text-xs text-amber-600 dark:text-amber-400">
                        {file.warnings.map((warning) => (
                          <li key={warning} className="flex items-start gap-1">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                            {warning}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">{ti.next}</p>
              <p className="text-xs text-muted-foreground">{ti.containsTins}</p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {ti.close}
          </Button>
          <Button type="button" onClick={() => void generate()} disabled={iris.isPending}>
            {iris.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
            {result ? ti.regenerate : ti.generate}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
