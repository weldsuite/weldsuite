import { useCallback, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { accountingKeys } from '@/hooks/queries/use-accounting-queries';
import { useFileUpload } from '@/hooks/use-file-upload';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { FileText, Eye, Scan, FileCheck, Upload, Loader2, Sparkles, UserPlus, X, Receipt, Ban } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  EmptyStateIllustration,
  type ColumnDef,
  type FilterConfig,
  type ActiveFilter,
  type GroupConfig,
} from '@/components/entity-list';

interface DocumentRow {
  id: string;
  fileName: string;
  type?: string | null;
  source?: string | null;
  status: string;
  matchedContactId?: string | null;
  mimeType?: string | null;
  ocrResult?: Record<string, any> | null;
}

const ACCEPTED_TYPES = 'image/jpeg,image/jpg,image/png,image/webp';

function fmt(value: number | null | undefined): string {
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: 'EUR',
  }).format(value ?? 0);
}

export default function DocumentInboxPage() {
  const { t } = useI18n();
  const st = useTranslations();
  const td = t.accounting.documents;

  const filterConfigs: FilterConfig[] = [
    {
      field: 'status',
      label: td.statusFilter,
      options: [
        { value: 'pending', label: td.pending },
        { value: 'processing', label: td.processing },
        { value: 'processed', label: td.processed },
        { value: 'linked', label: td.linked },
        { value: 'rejected', label: td.rejected },
        { value: 'failed', label: td.failed },
      ],
    },
  ];

  function statusBadge(status: string) {
    switch (status) {
      case 'pending':
        return <Badge variant="outline">{td.pending}</Badge>;
      case 'processing':
        return <Badge variant="secondary"><Loader2 className="h-3 w-3 mr-1 animate-spin" />{td.processing}</Badge>;
      case 'processed':
        return <Badge className="bg-green-100 text-green-800 hover:bg-green-100">{td.processed}</Badge>;
      case 'review':
        return <Badge variant="secondary">{td.review}</Badge>;
      case 'linked':
        return <Badge>{td.linked}</Badge>;
      case 'rejected':
        return <Badge variant="destructive">{td.rejected}</Badge>;
      case 'failed':
        return <Badge variant="destructive">{td.failed}</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  }

  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const statusFilter =
    filters.find((f) => f.field === 'status' && f.operator === 'is')?.value ?? 'all';

  const qc = useQueryClient();

  const documentsQuery = useQuery({
    queryKey: accountingKeys.documents.list(statusFilter === 'all' ? undefined : { status: statusFilter }),
    queryFn: () => accountingApi.listDocuments(statusFilter === 'all' ? undefined : { status: statusFilter }),
    refetchInterval: (query) => {
      const data = query.state.data as { data?: DocumentRow[] } | undefined;
      const anyProcessing = data?.data?.some((d) => d.status === 'processing');
      return anyProcessing ? 2000 : false;
    },
  });
  const statsQuery = useQuery({
    queryKey: accountingKeys.documents.stats(),
    queryFn: () => accountingApi.getDocumentStats(),
  });

  const [selectedDoc, setSelectedDoc] = useState<DocumentRow | null>(null);
  const [supplierDialog, setSupplierDialog] = useState<DocumentRow | null>(null);

  const processDoc = useMutation({
    mutationFn: (id: string) => accountingApi.processDocument(id),
    onSuccess: (res: any) => {
      qc.invalidateQueries({ queryKey: accountingKeys.documents.all });
      qc.invalidateQueries({ queryKey: accountingKeys.documents.stats() });
      const processed = res?.data;
      if (processed?.id) {
        accountingApi.getDocument(processed.id).then((full) => {
          if (full?.data) setSelectedDoc(full.data as any);
        });
      }
    },
  });

  const rejectDoc = useMutation({
    mutationFn: (id: string) => accountingApi.rejectDocument(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.documents.all });
      qc.invalidateQueries({ queryKey: accountingKeys.documents.stats() });
      setSelectedDoc(null);
    },
  });

  const rematchDoc = useMutation({
    mutationFn: (id: string) => accountingApi.rematchDocument(id),
    onSuccess: async (_res, id) => {
      qc.invalidateQueries({ queryKey: accountingKeys.documents.all });
      const full = await accountingApi.getDocument(id);
      if (full?.data) setSelectedDoc(full.data as any);
    },
  });

  // ------------ Upload wiring ------------
  const [uploadQueue, setUploadQueue] = useState<Array<{ id: string; name: string; phase: 'uploading' | 'processing' | 'done' | 'failed'; error?: string }>>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fileUpload = useFileUpload({
    folder: 'weldbooks/documents',
    entityType: 'accounting_document',
    isPublic: false,
  });

  const handleFiles = useCallback(async (files: File[]) => {
    const accepted = files.filter((f) => f.type.startsWith('image/'));
    const rejected = files.length - accepted.length;
    if (rejected > 0) {
      console.warn(`[WeldBooks] Skipped ${rejected} non-image file(s). Only JPG, PNG, WEBP are supported for OCR.`);
    }

    for (const file of accepted) {
      const queueId = `${Date.now()}-${file.name}`;
      setUploadQueue((q) => [...q, { id: queueId, name: file.name, phase: 'uploading' }]);

      try {
        const uploaded = await fileUpload.uploadFile(file);
        if (!uploaded) {
          setUploadQueue((q) => q.map((it) => it.id === queueId ? { ...it, phase: 'failed', error: st('sweep.weldbooks.documents.uploadFailed') } : it));
          continue;
        }

        const created = await accountingApi.createDocument({
          fileName: uploaded.fileName,
          fileKey: uploaded.fileKey,
          mimeType: uploaded.mimeType,
          fileSize: uploaded.fileSize,
          source: 'upload',
        });

        const docId = (created as any)?.data?.id;
        if (!docId) {
          setUploadQueue((q) => q.map((it) => it.id === queueId ? { ...it, phase: 'failed', error: st('sweep.weldbooks.documents.recordNotCreated') } : it));
          continue;
        }

        setUploadQueue((q) => q.map((it) => it.id === queueId ? { ...it, phase: 'processing' } : it));
        qc.invalidateQueries({ queryKey: accountingKeys.documents.all });

        await processDoc.mutateAsync(docId);

        setUploadQueue((q) => q.map((it) => it.id === queueId ? { ...it, phase: 'done' } : it));
      } catch (err: any) {
        setUploadQueue((q) => q.map((it) => it.id === queueId ? { ...it, phase: 'failed', error: err?.message ?? st('sweep.weldbooks.common.unknownError') } : it));
      }
    }
  }, [fileUpload, processDoc, qc, st]);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) void handleFiles(dropped);
  }, [handleFiles]);

  const onSelectFiles = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    if (picked.length > 0) void handleFiles(picked);
    e.target.value = '';
  }, [handleFiles]);

  // ------------ Data binding ------------
  const documents = ((documentsQuery.data as any)?.data ?? []) as unknown as DocumentRow[];
  const stats = ((statsQuery.data as any)?.data ?? []) as Array<{ status: string; count: number }>;

  // Group by processing status, most-actionable first. Only shown while no
  // status filter is active — otherwise the lone group header is redundant.
  // The trailing "other" group is an explicit catch-all: EntityList drops
  // items matching no group, so any status outside the known set stays visible here.
  const knownDocStatuses = ['pending', 'processing', 'review', 'processed', 'linked', 'rejected', 'failed'];
  const groups: GroupConfig<DocumentRow>[] | undefined =
    statusFilter === 'all'
      ? [
          { id: 'pending', label: td.groupPending, sortOrder: 1, filter: (d) => d.status === 'pending' },
          { id: 'processing', label: td.groupProcessing, sortOrder: 2, filter: (d) => d.status === 'processing' },
          { id: 'review', label: td.groupReview, sortOrder: 3, filter: (d) => d.status === 'review' },
          { id: 'processed', label: td.groupProcessed, sortOrder: 4, filter: (d) => d.status === 'processed' },
          { id: 'linked', label: td.groupLinked, sortOrder: 5, filter: (d) => d.status === 'linked' },
          { id: 'rejected', label: td.groupRejected, sortOrder: 6, filter: (d) => d.status === 'rejected' || d.status === 'failed' },
          { id: 'other', label: td.groupOther, sortOrder: 7, filter: (d) => !knownDocStatuses.includes(d.status) },
        ]
      : undefined;

  const columns: ColumnDef<DocumentRow>[] = [
    {
      id: 'fileName',
      header: td.colFileName,
      width: 'flex-1',
      render: (doc) => (
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span>{doc.fileName}</span>
        </div>
      ),
    },
    {
      id: 'type',
      header: td.colType,
      width: 'w-[120px]',
      render: (doc) => (
        <span className="capitalize text-sm">{doc.type?.replace('_', ' ')}</span>
      ),
    },
    {
      id: 'source',
      header: td.colSource,
      width: 'w-[100px]',
      render: (doc) => <span className="capitalize text-sm">{doc.source}</span>,
    },
    {
      id: 'vendor',
      header: td.colSupplierDetected,
      width: 'flex-1',
      render: (doc) => (
        <span className="text-sm">{(doc.ocrResult as any)?.vendor?.name ?? '-'}</span>
      ),
    },
    {
      id: 'amount',
      header: td.colAmountDetected,
      width: 'w-[120px]',
      render: (doc) => {
        const total = (doc.ocrResult as any)?.total;
        return <span className="text-sm">{total != null ? fmt(total) : '-'}</span>;
      },
    },
    {
      id: 'status',
      header: td.colStatus,
      width: 'w-[120px]',
      render: (doc) => statusBadge(doc.status),
    },
    {
      id: 'actions',
      header: '',
      width: 'w-[80px]',
      render: (doc) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {doc.status === 'pending' && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => processDoc.mutate(doc.id)}
              disabled={processDoc.isPending}
              title={td.processWithOcr}
            >
              <Scan className="h-4 w-4" />
            </Button>
          )}
          {(doc.status === 'processed' || doc.status === 'linked') && doc.ocrResult && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelectedDoc(doc)}
              title={td.viewOcrResult}
            >
              <Eye className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{td.title}</h1>

      {/* Upload zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`rounded-lg border-2 border-dashed p-6 flex flex-col items-center justify-center gap-2 text-center transition-colors ${
          dragOver ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'
        }`}
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Sparkles className="h-4 w-4" />
          <span>{td.dropHint}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-4 w-4 mr-1" />
            {td.uploadInvoice}
          </Button>
          <span className="text-xs text-muted-foreground">{td.acceptedFormatsLabel}</span>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_TYPES}
          multiple
          onChange={onSelectFiles}
          className="hidden"
        />

        {uploadQueue.length > 0 && (
          <div className="w-full mt-3 space-y-1">
            {uploadQueue.slice(-5).map((item) => (
              <div key={item.id} className="flex items-center justify-between text-xs bg-muted/40 rounded px-2 py-1">
                <span className="truncate max-w-[60%]">{item.name}</span>
                <span className="flex items-center gap-1">
                  {item.phase === 'uploading' && <><Loader2 className="h-3 w-3 animate-spin" />{td.phaseUploading}</>}
                  {item.phase === 'processing' && <><Loader2 className="h-3 w-3 animate-spin" />{td.phaseProcessing}</>}
                  {item.phase === 'done' && <span className="text-green-700">{td.phaseDone}</span>}
                  {item.phase === 'failed' && <span className="text-destructive">{td.phaseFailed}{item.error ? `: ${item.error}` : ''}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {stats.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {stats.map((s) => (
            <Card
              key={s.status}
              className="cursor-pointer hover:border-primary/50"
              onClick={() =>
                setFilters([
                  { id: `f-${s.status}`, field: 'status', operator: 'is', value: s.status },
                ])
              }
            >
              <CardContent className="pt-4 pb-3">
                <p className="text-xs text-muted-foreground capitalize">{s.status}</p>
                <p className="text-xl font-semibold">{s.count}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <WeldbooksEntityList<DocumentRow>
        items={documents}
        isLoading={documentsQuery.isLoading}
        columns={columns}
        groups={groups}
        filters={filterConfigs}
        activeFilters={filters}
        onFiltersChange={setFilters}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <FileText className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: td.noDocumentsInbox,
          description: td.dropHint,
        }}
      />

      {/* OCR Result Preview Dialog */}
      <Dialog open={!!selectedDoc} onOpenChange={(open) => !open && setSelectedDoc(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileCheck className="h-5 w-5" />
              {td.ocrResult} — {selectedDoc?.fileName}
            </DialogTitle>
          </DialogHeader>
          {selectedDoc?.ocrResult && (
            <OcrResultView result={selectedDoc.ocrResult} matchedContactId={selectedDoc.matchedContactId ?? null} td={td} />
          )}
          {selectedDoc && (
            <DialogFooter className="gap-2 sm:justify-between">
              <Button
                variant="ghost"
                onClick={() => rejectDoc.mutate(selectedDoc.id)}
                disabled={rejectDoc.isPending || selectedDoc.status === 'rejected'}
              >
                <Ban className="h-4 w-4 mr-1" />
                {td.reject}
              </Button>
              <div className="flex gap-2">
                {!selectedDoc.matchedContactId && (selectedDoc.ocrResult as any)?.vendor?.name && (
                  <Button variant="outline" onClick={() => setSupplierDialog(selectedDoc)}>
                    <UserPlus className="h-4 w-4 mr-1" />
                    {td.createSupplier}
                  </Button>
                )}
                <CreateBillButton doc={selectedDoc} label={td.createBill} />
              </div>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      {/* Create supplier from OCR dialog */}
      <CreateSupplierFromOcrDialog
        doc={supplierDialog}
        onClose={() => setSupplierDialog(null)}
        onCreated={async () => {
          if (supplierDialog) {
            await rematchDoc.mutateAsync(supplierDialog.id);
          }
          setSupplierDialog(null);
          qc.invalidateQueries({ queryKey: accountingKeys.customers.all });
        }}
        td={td}
      />
    </div>
  );
}

function CreateBillButton({ doc, label }: { doc: DocumentRow; label: string }) {
  const navigate = useNavigate();
  return (
    <Button
      onClick={() => {
        navigate({ to: '/weldbooks/bills/add', search: { fromDocument: doc.id } as any });
      }}
    >
      <Receipt className="h-4 w-4 mr-1" />
      {label}
    </Button>
  );
}

function CreateSupplierFromOcrDialog({
  doc,
  onClose,
  onCreated,
  td,
}: {
  doc: DocumentRow | null;
  onClose: () => void;
  onCreated: () => void;
  td: any;
}) {
  const vendor = (doc?.ocrResult as any)?.vendor ?? {};
  const [name, setName] = useState(vendor.name ?? '');
  const [vatNumber, setVatNumber] = useState(vendor.taxNumber ?? '');
  const [registrationNumber, setRegistrationNumber] = useState(vendor.kvkNumber ?? '');
  const [iban, setIban] = useState(vendor.iban ?? '');
  const [address, setAddress] = useState(vendor.address ?? '');

  const lastDocId = useRef<string | null>(null);
  if (doc && doc.id !== lastDocId.current) {
    lastDocId.current = doc.id;
    setName(vendor.name ?? '');
    setVatNumber(vendor.taxNumber ?? '');
    setRegistrationNumber(vendor.kvkNumber ?? '');
    setIban(vendor.iban ?? '');
    setAddress(vendor.address ?? '');
  }

  const create = useMutation({
    mutationFn: (payload: Record<string, unknown>) => accountingApi.createCustomer(payload),
    onSuccess: () => onCreated(),
  });

  if (!doc) return null;

  return (
    <Dialog open={!!doc} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{td.createSupplierFromOcr}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="sup-name">{td.supplierName}</Label>
            <Input id="sup-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="sup-vat">{td.supplierBtw}</Label>
              <Input id="sup-vat" value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sup-kvk">{td.supplierKvk}</Label>
              <Input id="sup-kvk" value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sup-iban">{td.supplierIban}</Label>
            <Input id="sup-iban" value={iban} onChange={(e) => setIban(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sup-address">{td.supplierAddress}</Label>
            <Input id="sup-address" value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            <X className="h-4 w-4 mr-1" />
            {td.cancel}
          </Button>
          <Button
            disabled={!name || create.isPending}
            onClick={() =>
              create.mutate({
                name,
                role: 'supplier',
                taxNumber: vatNumber || null,
                registrationNumber: registrationNumber || null,
                iban: iban || null,
                billingAddress: address ? { line1: address } : null,
              })
            }
          >
            {create.isPending ? td.creating : td.createSupplier}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OcrResultView({ result, matchedContactId, td }: { result: any; matchedContactId: string | null; td: any }) {
  return (
    <div className="space-y-4">
      {/* Supplier */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm">{td.ocrSupplier}</CardTitle>
          {matchedContactId ? (
            <Badge className="bg-green-100 text-green-800 hover:bg-green-100">{td.ocrMatched}</Badge>
          ) : (
            <Badge variant="outline">{td.ocrNoMatch}</Badge>
          )}
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          {result.vendor?.name && <p><strong>{td.ocrFieldName}</strong> {result.vendor.name}</p>}
          {result.vendor?.address && <p><strong>{td.ocrFieldAddress}</strong> {result.vendor.address}</p>}
          {result.vendor?.taxNumber && <p><strong>{td.ocrFieldBtw}</strong> {result.vendor.taxNumber}</p>}
          {result.vendor?.kvkNumber && <p><strong>{td.ocrFieldKvk}</strong> {result.vendor.kvkNumber}</p>}
          {result.vendor?.iban && <p><strong>{td.ocrFieldIban}</strong> {result.vendor.iban}</p>}
        </CardContent>
      </Card>

      {/* Invoice details */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{td.ocrInvoiceDetails}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm grid grid-cols-2 gap-2">
          <p><strong>{td.ocrFieldNumber}</strong> {result.invoiceNumber ?? '-'}</p>
          <p><strong>{td.ocrFieldDate}</strong> {result.invoiceDate ?? '-'}</p>
          <p><strong>{td.ocrFieldDueDate}</strong> {result.dueDate ?? '-'}</p>
          <p><strong>{td.ocrFieldCurrency}</strong> {result.currency ?? 'EUR'}</p>
          {result.paymentReference && <p><strong>{td.ocrFieldReference}</strong> {result.paymentReference}</p>}
          {result.iban && <p><strong>{td.ocrFieldPaymentIban}</strong> {result.iban}</p>}
        </CardContent>
      </Card>

      {/* Line items */}
      {result.lineItems?.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{td.ocrLineItems}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{td.ocrColDescription}</TableHead>
                  <TableHead className="text-right">{td.ocrColQty}</TableHead>
                  <TableHead className="text-right">{td.ocrColPrice}</TableHead>
                  <TableHead className="text-right">{td.ocrColVat}</TableHead>
                  <TableHead className="text-right">{td.ocrColTotal}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.lineItems.map((item: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="text-sm">{item.description}</TableCell>
                    <TableCell className="text-right text-sm">{item.quantity ?? '-'}</TableCell>
                    <TableCell className="text-right text-sm">{item.unitPrice != null ? fmt(item.unitPrice) : '-'}</TableCell>
                    <TableCell className="text-right text-sm">{item.taxRate != null ? `${item.taxRate}%` : '-'}</TableCell>
                    <TableCell className="text-right text-sm">{item.total != null ? fmt(item.total) : '-'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Totals */}
      <Card>
        <CardContent className="pt-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span>{td.ocrSubtotal}</span>
            <span>{result.subtotal != null ? fmt(result.subtotal) : '-'}</span>
          </div>
          {result.taxBreakdown?.map((tb: any, i: number) => (
            <div key={i} className="flex justify-between text-muted-foreground">
              <span>{td.ocrVatLine.replace('{rate}', String(tb.rate)).replace('{amount}', fmt(tb.taxableAmount))}</span>
              <span>{fmt(tb.taxAmount)}</span>
            </div>
          ))}
          <div className="flex justify-between">
            <span>{td.ocrTotalTax}</span>
            <span>{result.totalTax != null ? fmt(result.totalTax) : '-'}</span>
          </div>
          <div className="flex justify-between font-semibold text-base border-t pt-2">
            <span>{td.ocrTotal}</span>
            <span>{result.total != null ? fmt(result.total) : '-'}</span>
          </div>
        </CardContent>
      </Card>

      {/* Confidence */}
      {result.confidence && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{td.ocrConfidence}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p>{td.ocrOverall} {Math.round((result.confidence.overall ?? 0) * 100)}%</p>
            {result.confidence.fields && Object.entries(result.confidence.fields).map(([field, score]) => (
              <p key={field} className="text-muted-foreground">
                {field}: {Math.round((score as number) * 100)}%
              </p>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
