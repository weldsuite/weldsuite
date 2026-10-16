import { useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { AlertTriangle, Download, FileInput, Loader2, MoreHorizontal, RefreshCw, Upload } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
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
import { Textarea } from '@weldsuite/ui/components/textarea';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyStateIllustration, type ActiveFilter, type ColumnDef, type FilterConfig } from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  RowAmount,
  RowChip,
  RowDate,
  RowText,
  RowTitle,
  StatusChip,
  type ChipTone,
} from '@/components/accounting/weldbooks-row-cells';
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

const AUTO_SUPPLIER = '__auto__';
const MANIFESTATIONS: ManifestationType[] = ['ciencia', 'confirmacao', 'desconhecimento', 'nao_realizada'];
const RECEIVED_STATUSES: ReceivedStatus[] = ['new', 'imported', 'ignored'];
/** The XML of an NF-e is far below this; a larger file is not one. */
const MAX_XML_BYTES = 2 * 1024 * 1024;

const STATUS_TONE: Record<ReceivedStatus, ChipTone> = {
  new: 'blue',
  imported: 'green',
  ignored: 'gray',
};

function issuerTaxId(value: string | null): string {
  if (!value) return '';
  const n = normalizeCnpj(value);
  return n.length === 14 ? formatCnpj(n) : value;
}

/** The status filter works on the loaded list: `is` keeps the status, `is not` drops it. */
function applyStatusFilters(items: ReceivedFiscalDocument[], activeFilters: ActiveFilter[]): ReceivedFiscalDocument[] {
  let result = items;
  for (const filter of activeFilters) {
    if (filter.field !== 'status' || !filter.operator || !filter.value) continue;
    result =
      filter.operator === 'is'
        ? result.filter((doc) => doc.status === filter.value)
        : result.filter((doc) => doc.status !== filter.value);
  }
  return result;
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
  const navigate = useNavigate();
  const canCreate = useCan('bills:create');
  const canUpdate = useCan('bills:update');
  const query = useReceivedFiscalDocuments();
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

  const filters: FilterConfig[] = [
    {
      field: 'status',
      label: tr.statusFilter,
      options: RECEIVED_STATUSES.map((value) => ({ value, label: tr.statuses[value] })),
    },
  ];

  const columns: ColumnDef<ReceivedFiscalDocument>[] = [
    {
      id: 'issuer',
      header: tr.issuer,
      width: 'min-w-[200px] flex-1 gap-2',
      render: (doc) => <RowTitle>{doc.issuerName ?? '—'}</RowTitle>,
    },
    {
      id: 'taxId',
      header: tr.issuerTaxId,
      width: 'w-[160px]',
      render: (doc) => <RowText className="font-mono">{issuerTaxId(doc.issuerTaxId)}</RowText>,
    },
    {
      id: 'number',
      header: tr.number,
      width: 'w-[130px]',
      render: (doc) => (
        <span className="min-w-0" title={doc.accessKey}>
          <RowText>{doc.number ? `${doc.number}${doc.series ? ` / ${doc.series}` : ''}` : null}</RowText>
        </span>
      ),
    },
    {
      id: 'issueDate',
      header: tr.issueDate,
      width: 'w-[120px]',
      render: (doc) => <RowDate>{doc.issueDate ? formatDate(doc.issueDate) : null}</RowDate>,
    },
    {
      id: 'total',
      header: tr.total,
      width: 'w-[130px]',
      render: (doc) => <RowAmount>{doc.total ? formatMoney(doc.total, 'BRL') : null}</RowAmount>,
    },
    {
      id: 'status',
      header: tr.status,
      width: 'w-[220px] gap-1.5',
      render: (doc) => (
        <>
          <StatusChip tone={STATUS_TONE[doc.status]}>{tr.statuses[doc.status]}</StatusChip>
          {doc.manifestation ? (
            <RowChip>{(tr.manifestations as Record<string, string>)[doc.manifestation]}</RowChip>
          ) : null}
        </>
      ),
    },
  ];

  if (query.isError) {
    return (
      <div className="p-4 sm:p-6">
        <Alert variant="destructive" data-testid="received-load-error">
          <AlertTriangle />
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{query.error instanceof Error && query.error.message ? query.error.message : tr.loadFailed}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()}>
              {tr.retry}
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <>
      <WeldbooksEntityList<ReceivedFiscalDocument>
        items={rows}
        isLoading={query.isLoading}
        columns={columns}
        filters={filters}
        applyFilters={applyStatusFilters}
        getRowLabel={(doc) => doc.issuerName ?? doc.accessKey}
        renderRowMenu={(doc) => {
          const billId = doc.billId;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={tr.actions}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {billId ? (
                  <DropdownMenuItem onSelect={() => void navigate({ to: '/weldbooks/bills/$id', params: { id: billId } })}>
                    {tr.viewBill}
                  </DropdownMenuItem>
                ) : null}
                {billId ? <DropdownMenuSeparator /> : null}
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
          );
        }}
        actionButtons={
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".xml,text/xml,application/xml"
              className="sr-only"
              aria-label={tr.upload}
              data-testid="received-upload-input"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              disabled={!canCreate || upload.isPending}
              onClick={() => fileInput.current?.click()}
            >
              {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
              <span className="hidden md:inline">{tr.upload}</span>
            </Button>
            <Button type="button" size="sm" className="h-8" disabled={!canCreate || sync.isPending} onClick={runSync}>
              {sync.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
              <span className="hidden md:inline">{hasMore ? tr.syncMore : tr.sync}</span>
            </Button>
          </>
        }
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <FileInput className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: tr.emptyTitle,
          description: tr.emptyDescription,
        }}
        noResultsState={{ title: tr.noMatches, description: tr.noMatchesDescription }}
      />

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
    </>
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
