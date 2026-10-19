import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Copy, ExternalLink, FileCheck2, Loader2, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  useCancelFiscalDocument,
  useCorrectFiscalDocument,
  useInvoiceFiscalDocuments,
  useIssueFiscalDocument,
  useRefreshFiscalDocument,
} from '@/hooks/queries/use-weldbooks-br-queries';
import {
  fiscalErrorDetails,
  providerErrorLines,
  type FiscalDocument,
  type FiscalDocumentStatus,
} from '@/lib/api/domains/weldbooks-fiscal-documents';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { brPixFor } from '@/lib/weldbooks/br-invoice';
import { pixQrMatrix } from '@/lib/weldbooks/pix';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

/** A 44-digit access key in groups of four, as printed on the DANFE. */
function groupedKey(key: string): string {
  return key.replace(/(\d{4})(?=\d)/g, '$1 ');
}

const STATUS_STYLES: Record<FiscalDocumentStatus, string> = {
  processing: 'bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/40 dark:text-amber-300',
  authorized: 'bg-green-100 text-green-800 hover:bg-green-100 dark:bg-green-900/40 dark:text-green-300',
  rejected: 'bg-red-100 text-red-800 hover:bg-red-100 dark:bg-red-900/40 dark:text-red-300',
  cancelled: 'bg-muted text-muted-foreground hover:bg-muted',
  error: 'bg-red-100 text-red-800 hover:bg-red-100 dark:bg-red-900/40 dark:text-red-300',
};

export function FiscalStatusBadge({ status }: Readonly<{ status: FiscalDocumentStatus }>) {
  const { t } = useI18n();
  const labels = t.weldbooksBr.fiscal.statuses as Record<string, string>;
  return <Badge className={STATUS_STYLES[status]}>{labels[status] ?? status}</Badge>;
}

// ---------------------------------------------------------------------------
// Pix
// ---------------------------------------------------------------------------

interface PixCardProps {
  invoice: InvoiceWithTax;
  entity: { name: string; legalName?: string | null; baseCurrency?: string | null; jurisdictionSettings?: Record<string, unknown> | null } | null | undefined;
}

/**
 * Brazil: the Pix QR code (BR Code) for the amount still due, with its "copia
 * e cola" text. Only for unpaid BRL invoices of an entity with a Pix key.
 */
export function PixCard({ invoice, entity }: Readonly<PixCardProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksBr.pix;
  const { formatMoney } = useWeldbooksFormat();
  const pix = useMemo(() => brPixFor(invoice, entity), [invoice, entity]);
  const payload = pix?.payload ?? null;
  const due = pix?.amount ?? 0;
  const matrix = useMemo(() => (payload ? pixQrMatrix(payload) : null), [payload]);

  if (!payload || !matrix) return null;
  const size = matrix.length;
  const path = matrix
    .flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : '')))
    .join('');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(payload);
      toast.success(tp.copied);
    } catch {
      toast.error(tp.copyFailed);
    }
  };

  return (
    <Card data-testid="pix-card">
      <CardHeader>
        <CardTitle>{tp.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 @lg:flex-row @lg:items-center">
        <svg
          role="img"
          aria-label={tp.qrLabel}
          viewBox={`0 0 ${size} ${size}`}
          className="h-40 w-40 shrink-0 rounded-md border bg-white"
          shapeRendering="crispEdges"
        >
          <rect width={size} height={size} fill="#fff" />
          <path d={path} fill="#000" />
        </svg>
        <div className="min-w-0 space-y-2 text-sm">
          <p>
            {tp.amount.replace('{amount}', formatMoney(due, invoice.currency))} · {tp.key}: <span className="font-medium">{pix?.key}</span>
          </p>
          <p className="break-all rounded-md bg-muted p-2 font-mono text-xs" data-testid="pix-payload">{payload}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
            <Copy className="mr-1 h-4 w-4" aria-hidden />
            {tp.copy}
          </Button>
          <p className="text-xs text-muted-foreground">{tp.help}</p>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Fiscal document
// ---------------------------------------------------------------------------

interface ReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  label: string;
  confirmLabel: string;
  min: number;
  max: number;
  pending: boolean;
  onConfirm: (text: string) => void;
}

function ReasonDialog({ open, onOpenChange, title, description, label, confirmLabel, min, max, pending, onConfirm }: Readonly<ReasonDialogProps>) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const length = text.trim().length;
  const valid = length >= min && length <= max;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setText('');
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="fiscal-reason">{label}</Label>
          <Textarea id="fiscal-reason" rows={4} maxLength={max} value={text} onChange={(e) => setText(e.target.value)} />
          <p className="text-xs text-muted-foreground">
            {t.weldbooksBr.fiscal.reasonLength.replace('{min}', String(min)).replace('{max}', String(max)).replace('{count}', String(length))}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t.weldbooksBr.fiscal.back}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!valid || pending}
            onClick={() => {
              onConfirm(text.trim());
            }}
          >
            {pending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface IssueProblem {
  message: string;
  /** What the invoice, the entity or the customer still lacks. */
  missing: string[];
  /** The provider's own error lines. */
  provider: string[];
}

interface FiscalDocumentCardProps {
  invoice: InvoiceWithTax;
  canUpdate: boolean;
}

/**
 * Brazil: the NF-e (goods) or NFS-e (services) of a finalized invoice, issued
 * through Focus NFe: issue, status, refresh, cancel, carta de correção
 * (NF-e), and the links to the XML, the PDF and the public page.
 */
export function FiscalDocumentCard({ invoice, canUpdate }: Readonly<FiscalDocumentCardProps>) {
  const { t } = useI18n();
  const tf = t.weldbooksBr.fiscal;
  const { formatDateTime } = useWeldbooksFormat();
  const documents = useInvoiceFiscalDocuments(invoice.id);
  const issue = useIssueFiscalDocument();
  const refresh = useRefreshFiscalDocument();
  const cancel = useCancelFiscalDocument();
  const correct = useCorrectFiscalDocument();
  const [problem, setProblem] = useState<IssueProblem | null>(null);
  const [cancelling, setCancelling] = useState<FiscalDocument | null>(null);
  const [correcting, setCorrecting] = useState<FiscalDocument | null>(null);

  const list = documents.data ?? [];
  // Newest first from the server; the live document is the latest one that was not turned down.
  const current = list.find((doc) => doc.status !== 'rejected' && doc.status !== 'error') ?? list[0];
  const isCreditNote = invoice.type === 'credit_note';
  const issuable = invoice.status !== 'draft' && invoice.status !== 'cancelled' && !isCreditNote;
  const canIssue =
    canUpdate && issuable && (!current || current.status === 'rejected' || current.status === 'error' || current.status === 'cancelled');
  const noDocumentNote = issuable ? tf.noneYet : tf.finalizeFirst;

  const describe = (err: unknown): IssueProblem => {
    const details = fiscalErrorDetails(err);
    return {
      message: err instanceof Error ? err.message : tf.issueFailed,
      missing: details.missing ?? [],
      provider: providerErrorLines(details),
    };
  };

  const handleIssue = () => {
    setProblem(null);
    issue.mutate(invoice.id, {
      onSuccess: () => toast.success(tf.issued),
      onError: (err) => {
        const details = fiscalErrorDetails(err);
        if (details.documentId) {
          toast.info(tf.alreadyIssued);
          return;
        }
        setProblem(describe(err));
      },
    });
  };

  const handleRefresh = (doc: FiscalDocument) => {
    refresh.mutate(doc.id, {
      onSuccess: () => toast.success(tf.refreshed),
      onError: (err) => toast.error(tf.refreshFailed, { description: describe(err).message }),
    });
  };

  if (documents.isLoading) {
    return (
      <Card data-testid="fiscal-document-card">
        <CardHeader>
          <CardTitle>{tf.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label={tf.loading} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="fiscal-document-card">
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <FileCheck2 className="h-4 w-4" aria-hidden />
          {tf.title}
        </CardTitle>
        {canIssue && (
          <Button type="button" size="sm" onClick={handleIssue} disabled={issue.isPending}>
            {issue.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
            {issue.isPending ? tf.issuing : tf.issue}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {documents.isError && (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center justify-between gap-3">
              <span>{tf.loadFailed}</span>
              <Button type="button" size="sm" variant="outline" onClick={() => void documents.refetch()}>
                {tf.retry}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {problem && (
          <Alert variant="destructive" data-testid="fiscal-issue-problem">
            <AlertDescription className="space-y-2">
              <p className="font-medium">{problem.message}</p>
              {problem.missing.length > 0 && (
                <div>
                  <p className="text-sm">{tf.missingTitle}</p>
                  <ul className="list-disc pl-5 text-sm" data-testid="fiscal-missing">
                    {problem.missing.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
              {problem.provider.length > 0 && (
                <div>
                  <p className="text-sm">{tf.providerTitle}</p>
                  <ul className="list-disc pl-5 text-sm">
                    {problem.provider.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
            </AlertDescription>
          </Alert>
        )}

        {!current && !documents.isError && (
          <p className="text-sm text-muted-foreground">
            {isCreditNote ? tf.creditNoteNote : noDocumentNote}
          </p>
        )}

        {current && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <FiscalStatusBadge status={current.status} />
              <span className="font-medium">
                {(tf.kinds as Record<string, string>)[current.kind] ?? current.kind}
                {current.number ? ` ${tf.numberShort} ${current.number}` : ''}
                {current.series ? ` / ${tf.series} ${current.series}` : ''}
              </span>
              <Badge variant="outline">{current.environment === 'producao' ? tf.production : tf.homologation}</Badge>
            </div>
            {current.statusMessage && <p className="text-muted-foreground">{current.statusMessage}</p>}
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 @lg:grid-cols-2">
              {current.accessKey && (
                <div className="@lg:col-span-2">
                  <dt className="text-xs uppercase text-muted-foreground">{tf.accessKey}</dt>
                  <dd className="break-all font-mono text-xs" data-testid="fiscal-access-key">{groupedKey(current.accessKey)}</dd>
                </div>
              )}
              {current.verificationCode && (
                <div>
                  <dt className="text-xs uppercase text-muted-foreground">{tf.verificationCode}</dt>
                  <dd>{current.verificationCode}</dd>
                </div>
              )}
              {current.protocol && (
                <div>
                  <dt className="text-xs uppercase text-muted-foreground">{tf.protocol}</dt>
                  <dd>{current.protocol}</dd>
                </div>
              )}
              {current.authorizedAt && (
                <div>
                  <dt className="text-xs uppercase text-muted-foreground">{tf.authorizedAt}</dt>
                  <dd className="tabular-nums">{formatDateTime(current.authorizedAt)}</dd>
                </div>
              )}
              {current.cancelledAt && (
                <div>
                  <dt className="text-xs uppercase text-muted-foreground">{tf.cancelledAt}</dt>
                  <dd className="tabular-nums">{formatDateTime(current.cancelledAt)}</dd>
                </div>
              )}
              {current.cancelReason && (
                <div className="@lg:col-span-2">
                  <dt className="text-xs uppercase text-muted-foreground">{tf.cancelReason}</dt>
                  <dd>{current.cancelReason}</dd>
                </div>
              )}
            </dl>

            <div className="flex flex-wrap gap-2">
              {current.pdfUrl && (
                <Button asChild variant="outline" size="sm">
                  <a href={current.pdfUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-1 h-4 w-4" aria-hidden />
                    {current.kind === 'nfe' ? tf.danfe : tf.pdf}
                  </a>
                </Button>
              )}
              {current.xmlUrl && (
                <Button asChild variant="outline" size="sm">
                  <a href={current.xmlUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-1 h-4 w-4" aria-hidden />
                    {tf.xml}
                  </a>
                </Button>
              )}
              {current.publicUrl && (
                <Button asChild variant="outline" size="sm">
                  <a href={current.publicUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-1 h-4 w-4" aria-hidden />
                    {tf.publicPage}
                  </a>
                </Button>
              )}
              {canUpdate && (current.status === 'processing' || current.status === 'authorized') && (
                <Button type="button" variant="outline" size="sm" onClick={() => handleRefresh(current)} disabled={refresh.isPending}>
                  {refresh.isPending ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <RefreshCw className="mr-1 h-4 w-4" aria-hidden />
                  )}
                  {tf.refresh}
                </Button>
              )}
              {canUpdate && current.status === 'authorized' && current.kind === 'nfe' && (
                <Button type="button" variant="outline" size="sm" onClick={() => setCorrecting(current)}>
                  {tf.correction}
                </Button>
              )}
              {canUpdate && current.status === 'authorized' && (
                <Button type="button" variant="outline" size="sm" className="text-destructive" onClick={() => setCancelling(current)}>
                  {tf.cancel}
                </Button>
              )}
            </div>
          </div>
        )}

        {list.length > 1 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">{tf.history.replace('{count}', String(list.length - 1))}</summary>
            <ul className="mt-2 space-y-1">
              {list
                .filter((doc) => doc.id !== current?.id)
                .map((doc) => (
                  <li key={doc.id} className="flex flex-wrap items-center gap-2">
                    <FiscalStatusBadge status={doc.status} />
                    <span>{(tf.kinds as Record<string, string>)[doc.kind] ?? doc.kind}{doc.number ? ` ${tf.numberShort} ${doc.number}` : ''}</span>
                    {doc.statusMessage && <span className="text-muted-foreground">{doc.statusMessage}</span>}
                  </li>
                ))}
            </ul>
          </details>
        )}
      </CardContent>

      <ReasonDialog
        open={cancelling !== null}
        onOpenChange={(open) => {
          if (!open) setCancelling(null);
        }}
        title={tf.cancelTitle}
        description={tf.cancelDescription}
        label={tf.cancelReasonLabel}
        confirmLabel={tf.cancelConfirm}
        min={15}
        max={255}
        pending={cancel.isPending}
        onConfirm={(reason) => {
          if (!cancelling) return;
          cancel.mutate(
            { id: cancelling.id, reason },
            {
              onSuccess: () => {
                toast.success(tf.cancelled);
                setCancelling(null);
              },
              onError: (err) => toast.error(tf.cancelFailed, { description: describe(err).message }),
            },
          );
        }}
      />
      <ReasonDialog
        open={correcting !== null}
        onOpenChange={(open) => {
          if (!open) setCorrecting(null);
        }}
        title={tf.correctionTitle}
        description={tf.correctionDescription}
        label={tf.correctionLabel}
        confirmLabel={tf.correctionConfirm}
        min={15}
        max={1000}
        pending={correct.isPending}
        onConfirm={(text) => {
          if (!correcting) return;
          correct.mutate(
            { id: correcting.id, text },
            {
              onSuccess: () => {
                toast.success(tf.corrected);
                setCorrecting(null);
              },
              onError: (err) => toast.error(tf.correctionFailed, { description: describe(err).message }),
            },
          );
        }}
      />
    </Card>
  );
}
