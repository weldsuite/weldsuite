import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, FileCheck2, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useAccountingInvoice } from '@/hooks/queries/use-accounting-queries';
import {
  useAccountingDocument,
  useDeleteExemptionCertificate,
  useExemptionCertificate,
  useUpdateExemptionCertificate,
} from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import type { ExemptionCertificate } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { salesTaxStateName } from '@/lib/weldbooks/us-sales-tax-states';
import { CustomerName } from '../../setup/customer-picker';
import { SalesTaxSetupGate, useSalesTaxSetupAccess } from '../../setup/setup-gate';
import { useSetupTexts } from '../../setup/setup-texts';
import { CertificateStatusBadge } from '../../setup/status-badges';
import { CertificateExpiry } from '../certificate-expiry';
import { CertificateForm } from '../certificate-form';
import { certificateToForm, toUpdateCertificateInput } from '../certificate-model';

function DetailRow({ label, value }: Readonly<{ label: string; value: ReactNode }>) {
  return (
    <div className="flex justify-between gap-4 border-b py-2 last:border-b-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm font-medium">{value ?? '—'}</dd>
    </div>
  );
}

function InvoiceLink({ invoiceId }: Readonly<{ invoiceId: string }>) {
  const invoice = useAccountingInvoice(invoiceId);
  const number = invoice.data?.data?.invoiceNumber;
  return (
    <Link to="/weldbooks/invoices/$id" params={{ id: invoiceId }} className="text-primary underline-offset-4 hover:underline">
      {number ?? invoiceId}
    </Link>
  );
}

function CertificateDetail({ id }: Readonly<{ id: string }>) {
  const { t } = useSetupTexts();
  const td = t.certificates.detail;
  const navigate = useNavigate();
  const access = useSalesTaxSetupAccess();
  const { formatDate, today } = useWeldbooksFormat();
  const query = useExemptionCertificate(id);
  const update = useUpdateExemptionCertificate();
  const remove = useDeleteExemptionCertificate();
  const certificate: ExemptionCertificate | undefined = query.data;
  const scan = useAccountingDocument(certificate?.documentId);
  const [editing, setEditing] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const back = (
    <Button asChild variant="ghost" size="sm" className="-ml-3">
      <Link to="/weldbooks/sales-tax/certificates">
        <ArrowLeft className="mr-1 h-4 w-4" aria-hidden />
        {td.back}
      </Link>
    </Button>
  );

  if (query.isLoading) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6" aria-busy="true">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (query.isError || !certificate) {
    const notFound = (query.error as { status?: number } | null)?.status === 404;
    return (
      <div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
        {back}
        <Alert variant={notFound ? 'default' : 'destructive'}>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{notFound ? td.notFound : td.loadError}</span>
            {!notFound ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
                {t.common.retry}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const setStatus = async (status: 'valid' | 'revoked') => {
    try {
      await update.mutateAsync({ id: certificate.id, input: { status } });
      toast.success(status === 'revoked' ? td.revoked : td.restored);
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t.common.saveError);
    }
  };

  const confirmDelete = async () => {
    try {
      await remove.mutateAsync(certificate.id);
      toast.success(td.deleted);
      void navigate({ to: '/weldbooks/sales-tax/certificates' });
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t.common.saveError);
      setDeleteOpen(false);
    }
  };

  if (editing) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{t.certificates.form.editTitle}</h1>
          <p className="text-sm text-muted-foreground">
            <CustomerName partyId={certificate.partyId} />
          </p>
        </div>
        <CertificateForm
          mode="edit"
          initial={certificateToForm(certificate)}
          lockCustomer
          submitting={update.isPending}
          submitError={
            update.isError ? (update.error instanceof Error && update.error.message ? update.error.message : t.certificates.form.saveError) : null
          }
          onCancel={() => {
            update.reset();
            setEditing(false);
          }}
          onSubmit={async (values) => {
            try {
              await update.mutateAsync({ id: certificate.id, input: toUpdateCertificateInput(values) });
              toast.success(td.saved);
              setEditing(false);
            } catch {
              // The error shows under the form (update.error).
            }
          }}
        />
      </div>
    );
  }

  const day = today();

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6">
      <div className="space-y-2">
        {back}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">
                <CustomerName partyId={certificate.partyId} />
              </h1>
              <CertificateStatusBadge status={certificate.status} />
            </div>
            <p className="text-sm text-muted-foreground">
              {t.certificates.reasons[certificate.reason]}
              {certificate.certificateNumber ? ` · ${certificate.certificateNumber}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {access.canUpdate ? (
              <>
                <Button type="button" variant="outline" onClick={() => setEditing(true)}>
                  <Pencil className="mr-2 h-4 w-4" aria-hidden />
                  {t.common.edit}
                </Button>
                {certificate.storedStatus === 'revoked' ? (
                  <Button type="button" variant="outline" onClick={() => void setStatus('valid')} disabled={update.isPending}>
                    {td.restore}
                  </Button>
                ) : (
                  <Button type="button" variant="outline" onClick={() => setRevokeOpen(true)}>
                    {td.revoke}
                  </Button>
                )}
              </>
            ) : null}
            {access.canDelete ? (
              <Button type="button" variant="outline" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="mr-2 h-4 w-4" aria-hidden />
                {t.common.delete}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{td.summary}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <DetailRow
                label={td.fields.customer}
                value={
                  <Link
                    to="/weldbooks/customers/$id"
                    params={{ id: certificate.partyId }}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    <CustomerName partyId={certificate.partyId} />
                  </Link>
                }
              />
              <DetailRow label={td.fields.reason} value={t.certificates.reasons[certificate.reason]} />
              <DetailRow label={td.fields.form} value={t.certificates.forms[certificate.form]} />
              <DetailRow label={td.fields.number} value={certificate.certificateNumber} />
              <DetailRow
                label={td.fields.coverage}
                value={certificate.blanket ? t.certificates.coverage.blanket : t.certificates.coverage.single}
              />
              {!certificate.blanket && certificate.invoiceId ? (
                <DetailRow label={td.fields.invoice} value={<InvoiceLink invoiceId={certificate.invoiceId} />} />
              ) : null}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{td.fields.expires}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <DetailRow label={td.fields.expires} value={<CertificateExpiry certificate={certificate} />} />
              <DetailRow label={td.fields.issuedOn} value={formatDate(certificate.issuedOn, '—')} />
              <DetailRow label={td.fields.receivedOn} value={formatDate(certificate.receivedOn, '—')} />
              <DetailRow
                label={td.fields.lastUsed}
                value={certificate.lastUsedOn ? formatDate(certificate.lastUsedOn) : t.certificates.expiry.neverUsed}
              />
              <DetailRow
                label={td.fields.scan}
                value={
                  certificate.documentId ? (
                    <span className="inline-flex items-center gap-1">
                      <FileCheck2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
                      {scan.data?.fileName ?? t.certificates.form.scan.onFile}
                    </span>
                  ) : null
                }
              />
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{td.statesTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{td.statesColumns.state}</TableHead>
                  <TableHead>{td.statesColumns.validUntil}</TableHead>
                  <TableHead>{td.statesColumns.status}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {certificate.states.map((code) => {
                  const until = certificate.expiryByState[code] ?? null;
                  const lapsed = certificate.expiredStates.includes(code) || (until !== null && until < day);
                  return (
                    <TableRow key={code}>
                      <TableCell className="font-medium">
                        {salesTaxStateName(code)} ({code})
                      </TableCell>
                      <TableCell>{until ? formatDate(until) : t.certificates.expiry.noneInState}</TableCell>
                      <TableCell className={lapsed ? 'text-destructive' : 'text-muted-foreground'}>
                        {lapsed ? td.stateExpired : td.stateValid}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {certificate.notes ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{td.fields.notes}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm">{certificate.notes}</p>
          </CardContent>
        </Card>
      ) : null}

      <ConfirmDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        title={td.revokeDialog.title}
        description={td.revokeDialog.description}
        confirmLabel={td.revokeDialog.confirm}
        cancelLabel={t.common.cancel}
        variant="destructive"
        onConfirm={async () => {
          await setStatus('revoked');
          setRevokeOpen(false);
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={td.deleteDialog.title}
        description={td.deleteDialog.description}
        confirmLabel={td.deleteDialog.confirm}
        cancelLabel={t.common.cancel}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

export default function ExemptionCertificateDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  return (
    <SalesTaxSetupGate>
      <CertificateDetail id={id} />
    </SalesTaxSetupGate>
  );
}
