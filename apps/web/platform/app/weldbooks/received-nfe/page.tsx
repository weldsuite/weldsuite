import { useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { AlertTriangle, Download, Loader2, MoreHorizontal, RefreshCw, Upload } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
import { useAccountingCustomers } from '@/hooks/queries/use-accounting-queries';
import {
  useCreateBillFromReceived,
  useIgnoreReceivedFiscalDocument,
  useManifestReceivedFiscalDocument,
  useReceivedFiscalDocuments,
  useSyncReceivedFiscalDocuments,
  useUploadReceivedFiscalDocument,
} from '@/hooks/queries/use-weldbooks-br-queries';
import type {
  ManifestationType,
  ReceivedFiscalDocument,
  ReceivedStatus,
} from '@/lib/api/domains/weldbooks-fiscal-documents';
import { useI18n } from '@/lib/i18n/provider';
import { formatCnpj, normalizeCnpj } from '@/lib/weldbooks/identifiers';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

const ALL = '__all__';
const AUTO_SUPPLIER = '__auto__';
const MANIFESTATIONS: ManifestationType[] = ['ciencia', 'confirmacao', 'desconhecimento', 'nao_realizada'];
/** The XML of an NF-e is far below this; a larger file is not one. */
const MAX_XML_BYTES = 2 * 1024 * 1024;

function issuerTaxId(value: string | null): string {
  if (!value) return '';
  const n = normalizeCnpj(value);
  return n.length === 14 ? formatCnpj(n) : value;
}

function statusVariant(status: ReceivedStatus): 'default' | 'secondary' | 'outline' {
  if (status === 'imported') return 'default';
  return status === 'ignored' ? 'outline' : 'secondary';
}

/**
 * Brazil: the NF-e issued to the entity by its suppliers. They are fetched
 * from Focus NFe by the entity's CNPJ or uploaded as XML; each can be answered
 * with a manifestação do destinatário, turned into a draft bill or ignored.
 */
export default function ReceivedNfePage() {
  const { t } = useI18n();
  const tr = t.weldbooksBr.received;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const canCreate = useCan('bills:create');
  const canUpdate = useCan('bills:update');
  const [status, setStatus] = useState<ReceivedStatus | undefined>(undefined);
  const query = useReceivedFiscalDocuments(status);
  const sync = useSyncReceivedFiscalDocuments();
  const upload = useUploadReceivedFiscalDocument();
  const manifest = useManifestReceivedFiscalDocument();
  const ignore = useIgnoreReceivedFiscalDocument();
  const fileInput = useRef<HTMLInputElement>(null);
  const [billFor, setBillFor] = useState<ReceivedFiscalDocument | null>(null);
  const [ignoreFor, setIgnoreFor] = useState<ReceivedFiscalDocument | null>(null);
  const [notDone, setNotDone] = useState<ReceivedFiscalDocument | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const rows = query.data?.data ?? [];

  const runSync = () => {
    sync.mutate(undefined, {
      onSuccess: (res) => {
        setHasMore(res.hasMore);
        toast.success(tr.synced.replace('{created}', String(res.created)).replace('{updated}', String(res.updated)));
      },
      onError: (err) => toast.error(tr.syncFailed, { description: err instanceof Error ? err.message : undefined }),
    });
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_XML_BYTES) {
      toast.error(tr.fileTooLarge);
      return;
    }
    try {
      const xml = await file.text();
      upload.mutate(xml, {
        onSuccess: () => toast.success(tr.uploaded),
        onError: (err) => toast.error(tr.uploadFailed, { description: err instanceof Error ? err.message : undefined }),
      });
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const sendManifest = (doc: ReceivedFiscalDocument, type: ManifestationType, reason?: string, done?: () => void) => {
    manifest.mutate(
      { id: doc.id, type, reason },
      {
        onSuccess: () => {
          toast.success(tr.manifested);
          done?.();
        },
        onError: (err) => toast.error(tr.manifestFailed, { description: err instanceof Error ? err.message : undefined }),
      },
    );
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{tr.title}</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{tr.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInput}
            type="file"
            accept=".xml,text/xml,application/xml"
            className="sr-only"
            aria-label={tr.upload}
            data-testid="received-upload-input"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          <Button type="button" variant="outline" disabled={!canCreate || upload.isPending} onClick={() => fileInput.current?.click()}>
            {upload.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : <Upload className="mr-1 h-4 w-4" aria-hidden />}
            {tr.upload}
          </Button>
          <Button type="button" disabled={!canCreate || sync.isPending} onClick={runSync}>
            {sync.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="mr-1 h-4 w-4" aria-hidden />}
            {hasMore ? tr.syncMore : tr.sync}
          </Button>
        </div>
      </div>

      <div className="max-w-52 space-y-2">
        <Label htmlFor="received-status">{tr.statusFilter}</Label>
        <Select value={status ?? ALL} onValueChange={(v) => setStatus(v === ALL ? undefined : (v as ReceivedStatus))}>
          <SelectTrigger id="received-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{tr.all}</SelectItem>
            <SelectItem value="new">{tr.statuses.new}</SelectItem>
            <SelectItem value="imported">{tr.statuses.imported}</SelectItem>
            <SelectItem value="ignored">{tr.statuses.ignored}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {query.isLoading && <PageLoader fullScreen={false} />}

      {query.isError && (
        <Alert variant="destructive" data-testid="received-load-error">
          <AlertTriangle />
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{query.error instanceof Error && query.error.message ? query.error.message : tr.loadFailed}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()}>
              {tr.retry}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {query.data && rows.length === 0 && (
        <Card>
          <CardContent className="space-y-1 py-10 text-center">
            <p className="font-medium">{tr.emptyTitle}</p>
            <p className="text-sm text-muted-foreground">{tr.emptyDescription}</p>
          </CardContent>
        </Card>
      )}

      {rows.length > 0 && (
        <Card>
          <CardContent className="overflow-x-auto pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr.issuer}</TableHead>
                  <TableHead>{tr.number}</TableHead>
                  <TableHead>{tr.issueDate}</TableHead>
                  <TableHead className="text-right">{tr.total}</TableHead>
                  <TableHead>{tr.status}</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((doc) => (
                  <TableRow key={doc.id}>
                    <TableCell>
                      <div className="font-medium">{doc.issuerName ?? '—'}</div>
                      <div className="text-xs text-muted-foreground">{issuerTaxId(doc.issuerTaxId)}</div>
                    </TableCell>
                    <TableCell>
                      {doc.number ?? '—'}
                      {doc.series ? <span className="text-xs text-muted-foreground"> / {doc.series}</span> : null}
                      <div className="break-all font-mono text-[10px] text-muted-foreground">{doc.accessKey}</div>
                    </TableCell>
                    <TableCell>{doc.issueDate ? formatDate(doc.issueDate) : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{doc.total ? formatMoney(doc.total, 'BRL') : '—'}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={statusVariant(doc.status)}>{tr.statuses[doc.status]}</Badge>
                        {doc.manifestation && (
                          <Badge variant="outline">{(tr.manifestations as Record<string, string>)[doc.manifestation]}</Badge>
                        )}
                      </div>
                      {doc.billId && (
                        <Link
                          to="/weldbooks/bills/$id"
                          params={{ id: doc.billId }}
                          className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                        >
                          {tr.viewBill}
                        </Link>
                      )}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button type="button" variant="ghost" size="icon" aria-label={tr.actions}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {doc.status === 'new' && (
                            <DropdownMenuItem disabled={!canCreate} onSelect={() => setBillFor(doc)}>
                              {tr.createBill}
                            </DropdownMenuItem>
                          )}
                          {doc.status === 'new' && (
                            <DropdownMenuItem disabled={!canCreate} onSelect={() => setIgnoreFor(doc)}>
                              {tr.ignore}
                            </DropdownMenuItem>
                          )}
                          {doc.status === 'new' && <DropdownMenuSeparator />}
                          {MANIFESTATIONS.map((type) => (
                            <DropdownMenuItem
                              key={type}
                              disabled={!canUpdate || manifest.isPending || doc.manifestation === type}
                              onSelect={() => (type === 'nao_realizada' ? setNotDone(doc) : sendManifest(doc, type))}
                            >
                              {(tr.manifestationActions as Record<string, string>)[type]}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <CreateBillDialog doc={billFor} onClose={() => setBillFor(null)} />

      <ConfirmDialog
        open={ignoreFor !== null}
        onOpenChange={(open) => {
          if (!open) setIgnoreFor(null);
        }}
        title={tr.ignoreTitle}
        description={tr.ignoreDescription}
        confirmLabel={tr.ignore}
        cancelLabel={tr.cancel}
        loading={ignore.isPending}
        onConfirm={() => {
          if (!ignoreFor) return;
          ignore.mutate(ignoreFor.id, {
            onSuccess: () => {
              toast.success(tr.ignored);
              setIgnoreFor(null);
            },
            onError: (err) => toast.error(tr.ignoreFailed, { description: err instanceof Error ? err.message : undefined }),
          });
        }}
      />

      <NotDoneDialog
        doc={notDone}
        pending={manifest.isPending}
        onClose={() => setNotDone(null)}
        onConfirm={(doc, reason) => sendManifest(doc, 'nao_realizada', reason, () => setNotDone(null))}
      />
    </div>
  );
}

function CreateBillDialog({ doc, onClose }: Readonly<{ doc: ReceivedFiscalDocument | null; onClose: () => void }>) {
  const { t } = useI18n();
  const tr = t.weldbooksBr.received;
  const createBill = useCreateBillFromReceived();
  const { data: suppliers } = useAccountingCustomers({ role: 'supplier' });
  const [contactId, setContactId] = useState(AUTO_SUPPLIER);
  const [dueDate, setDueDate] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const close = () => {
    setContactId(AUTO_SUPPLIER);
    setDueDate('');
    setWarnings([]);
    setCreatedId(null);
    onClose();
  };

  return (
    <Dialog open={doc !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tr.createBillTitle}</DialogTitle>
          <DialogDescription>{tr.createBillDescription}</DialogDescription>
        </DialogHeader>
        {createdId ? (
          <div className="space-y-3 text-sm" data-testid="created-bill">
            <p>{tr.billCreated}</p>
            {warnings.length > 0 && (
              <Alert>
                <AlertTriangle />
                <AlertDescription>
                  <ul className="list-disc space-y-1 pl-5">
                    {warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
            <Link
              to="/weldbooks/bills/$id"
              params={{ id: createdId }}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {tr.openBill}
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="received-supplier">{tr.supplier}</Label>
              <Select value={contactId} onValueChange={setContactId}>
                <SelectTrigger id="received-supplier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO_SUPPLIER}>{tr.supplierAuto}</SelectItem>
                  {(suppliers?.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name || c.email || c.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{tr.supplierHelp}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="received-due">{tr.dueDate}</Label>
              <Input id="received-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              <p className="text-xs text-muted-foreground">{tr.dueDateHelp}</p>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={createBill.isPending}>
            {createdId ? tr.close : tr.cancel}
          </Button>
          {!createdId && (
            <Button
              type="button"
              disabled={createBill.isPending || !doc}
              onClick={() => {
                if (!doc) return;
                createBill.mutate(
                  {
                    id: doc.id,
                    ...(contactId !== AUTO_SUPPLIER ? { contactId } : {}),
                    ...(dueDate ? { dueDate } : {}),
                  },
                  {
                    onSuccess: (res) => {
                      setWarnings(res.warnings);
                      setCreatedId(res.bill.id);
                    },
                    onError: (err) => toast.error(tr.createBillFailed, { description: err instanceof Error ? err.message : undefined }),
                  },
                );
              }}
            >
              {createBill.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : <Download className="mr-1 h-4 w-4" aria-hidden />}
              {tr.createBill}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NotDoneDialog({
  doc,
  pending,
  onClose,
  onConfirm,
}: Readonly<{
  doc: ReceivedFiscalDocument | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: (doc: ReceivedFiscalDocument, reason: string) => void;
}>) {
  const { t } = useI18n();
  const tr = t.weldbooksBr.received;
  const [reason, setReason] = useState('');
  const length = reason.trim().length;
  const valid = length >= 15 && length <= 255;
  return (
    <Dialog
      open={doc !== null}
      onOpenChange={(open) => {
        if (!open) {
          setReason('');
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tr.notDoneTitle}</DialogTitle>
          <DialogDescription>{tr.notDoneDescription}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="received-reason">{tr.reason}</Label>
          <Textarea id="received-reason" rows={4} maxLength={255} value={reason} onChange={(e) => setReason(e.target.value)} />
          <p className="text-xs text-muted-foreground">{tr.reasonLength.replace('{count}', String(length))}</p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            {tr.cancel}
          </Button>
          <Button type="button" disabled={!valid || pending} onClick={() => doc && onConfirm(doc, reason.trim())}>
            {tr.notDoneConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
