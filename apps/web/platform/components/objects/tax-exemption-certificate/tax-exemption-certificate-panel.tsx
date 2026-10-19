/**
 * Sales tax exemption certificate object panel (WeldBooks, US).
 *
 * Built on the same shell as the company / person / bank account panels:
 * `useObjectPanelShell` + `EntityDetailView` + `ObjectPanelTabs`, so it
 * inherits the shared header chrome, the panel↔fullscreen toggle and the
 * stacking/back behaviour. It replaces the standalone
 * `/weldbooks/sales-tax/certificates/:id` page, which now redirects to the list
 * with this panel open in fullscreen.
 *
 * Tabs: Details · Valid per state · History.
 */

import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  BadgeCheck,
  CalendarClock,
  CalendarDays,
  Edit,
  EllipsisVertical,
  FileCheck2,
  FileText,
  Hash,
  Layers,
  Link as LinkIcon,
  Receipt,
  ShieldOff,
  Tag,
  Trash2,
  User,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { useObjectPanelShell, type ObjectPanelComponentProps } from '@/components/object-panel';
import { EntityAuditPanel } from '@/components/entity-audit-panel';
import { StatusChip } from '@/components/accounting/weldbooks-row-cells';
import { ConfigurablePanelTabs } from '@/components/objects/_shared/configurable-panel-tabs';
import {
  PanelRow,
  PanelSection,
  RecordLoadFailed,
  useCopyPanelLink,
} from '@/components/objects/_shared/record-panel-parts';
import { SalesTaxPanelGate } from '@/components/objects/_shared/sales-tax-panel-gate';
import { tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { useAccountingInvoice } from '@/hooks/queries/use-accounting-queries';
import {
  useAccountingDocument,
  useDeleteExemptionCertificate,
  useExemptionCertificate,
  useUpdateExemptionCertificate,
} from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import type { ExemptionCertificate } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { cn } from '@/lib/utils';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { salesTaxStateName } from '@/lib/weldbooks/us-sales-tax-states';
import { CertificateExpiry } from '@/app/weldbooks/sales-tax/certificates/certificate-expiry';
import { CustomerName } from '@/app/weldbooks/sales-tax/setup/customer-picker';
import { useSalesTaxSetupAccess } from '@/app/weldbooks/sales-tax/setup/setup-gate';
import { useSetupTexts } from '@/app/weldbooks/sales-tax/setup/setup-texts';
import { CertificateEditDialog } from './certificate-edit-dialog';
import { CERTIFICATE_STATUS_TONE } from './tax-exemption-certificate-model';
import {
  getTaxExemptionCertificateTabs,
  type TaxExemptionCertificateTab,
} from './tax-exemption-certificate-tabs';

const CERTIFICATE_PANEL_WIDTH = 480;
const CERTIFICATE_TYPE = 'tax_exemption_certificate';
/** The entity type the audit log files an exemption certificate under. */
const CERTIFICATE_AUDIT_ENTITY = 'exemption_certificate';

function CertificateTitle({ certificate }: Readonly<{ certificate?: ExemptionCertificate }>) {
  const { t } = useSetupTexts();
  if (!certificate) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="relative top-px truncate text-[15px] font-medium text-foreground">
        <CustomerName partyId={certificate.partyId} />
      </span>
      <span className="flex-shrink-0">
        <StatusChip tone={CERTIFICATE_STATUS_TONE[certificate.status] ?? 'gray'}>
          {t.certificates.statuses[certificate.status] ?? certificate.status}
        </StatusChip>
      </span>
    </div>
  );
}

function CertificateActions({
  certificate,
  canUpdate,
  canDelete,
  restoring,
  onEdit,
  onRevoke,
  onRestore,
  onDelete,
}: Readonly<{
  certificate?: ExemptionCertificate;
  canUpdate: boolean;
  canDelete: boolean;
  restoring: boolean;
  onEdit: () => void;
  onRevoke: () => void;
  onRestore: () => void;
  onDelete: () => void;
}>) {
  const st = useTranslations();
  const { t } = useSetupTexts();
  const td = t.certificates.detail;
  const copyLink = useCopyPanelLink(
    '/weldbooks/sales-tax/certificates',
    CERTIFICATE_TYPE,
    certificate?.id ?? '',
  );
  if (!certificate) return null;

  return (
    <div className="flex items-center gap-0.5">
      {canUpdate ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7"
          title={t.common.edit}
          aria-label={t.common.edit}
          onClick={onEdit}
        >
          <Edit className="h-4 w-4 text-muted-foreground" />
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
            aria-label={t.jurisdictions.columns.actions}
          >
            <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canUpdate && certificate.storedStatus === 'revoked' ? (
            <DropdownMenuItem onClick={onRestore} disabled={restoring}>
              <BadgeCheck />
              {td.restore}
            </DropdownMenuItem>
          ) : null}
          {canUpdate && certificate.storedStatus !== 'revoked' ? (
            <DropdownMenuItem onClick={onRevoke}>
              <ShieldOff />
              {td.revoke}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => void copyLink()}>
            <LinkIcon />
            {st('sweep.entities.copyLink')}
          </DropdownMenuItem>
          {canDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 />
                {t.common.delete}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Details tab ───────────────────────────────────────────────────────────

function InvoiceLink({ invoiceId }: Readonly<{ invoiceId: string }>) {
  const invoice = useAccountingInvoice(invoiceId);
  const number = invoice.data?.data?.invoiceNumber;
  return (
    <Link to="/weldbooks/invoices/$id" params={{ id: invoiceId }} className="text-primary underline-offset-4 hover:underline">
      {number ?? invoiceId}
    </Link>
  );
}

function CertificateDetailsTab({ certificate }: Readonly<{ certificate: ExemptionCertificate }>) {
  const { t } = useSetupTexts();
  const td = t.certificates.detail;
  const { formatDate } = useWeldbooksFormat();
  const scan = useAccountingDocument(certificate.documentId);

  return (
    <div className="p-4 space-y-4">
      <div className="space-y-1">
        <PanelRow
          icon={User}
          label={td.fields.customer}
          value={certificate.partyId}
          renderValue={(partyId) => (
            <Link
              to="/weldbooks/customers/$id"
              params={{ id: partyId ?? '' }}
              className="text-primary underline-offset-4 hover:underline"
            >
              <CustomerName partyId={certificate.partyId} />
            </Link>
          )}
        />
        <PanelRow icon={Tag} label={td.fields.reason} value={t.certificates.reasons[certificate.reason]} />
        <PanelRow icon={FileText} label={td.fields.form} value={t.certificates.forms[certificate.form]} />
        <PanelRow icon={Hash} label={td.fields.number} value={certificate.certificateNumber} />
        <PanelRow
          icon={Layers}
          label={td.fields.coverage}
          value={certificate.blanket ? t.certificates.coverage.blanket : t.certificates.coverage.single}
        />
        {!certificate.blanket && certificate.invoiceId ? (
          <PanelRow
            icon={Receipt}
            label={td.fields.invoice}
            value={certificate.invoiceId}
            renderValue={(invoiceId) => <InvoiceLink invoiceId={invoiceId ?? ''} />}
          />
        ) : null}
      </div>

      <PanelSection title={td.fields.expires}>
        <div className="space-y-1">
          <PanelRow
            icon={CalendarClock}
            label={td.fields.expires}
            value={certificate.effectiveExpiresOn ?? t.certificates.expiry.none}
            renderValue={() => <CertificateExpiry certificate={certificate} />}
            tabular
          />
          <PanelRow icon={CalendarDays} label={td.fields.issuedOn} value={formatDate(certificate.issuedOn, '')} tabular />
          <PanelRow
            icon={CalendarDays}
            label={td.fields.receivedOn}
            value={formatDate(certificate.receivedOn, '')}
            tabular
          />
          <PanelRow
            icon={CalendarDays}
            label={td.fields.lastUsed}
            value={certificate.lastUsedOn ? formatDate(certificate.lastUsedOn) : t.certificates.expiry.neverUsed}
            tabular
          />
          <PanelRow
            icon={FileCheck2}
            label={td.fields.scan}
            value={certificate.documentId ? (scan.data?.fileName ?? t.certificates.form.scan.onFile) : null}
            renderValue={(fileName) => (
              <span className="inline-flex min-w-0 items-center gap-1">
                <FileCheck2 className="h-4 w-4 flex-shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                <span className="truncate">{fileName}</span>
              </span>
            )}
          />
        </div>
      </PanelSection>

      {certificate.notes ? (
        <PanelSection title={td.fields.notes}>
          <p className="whitespace-pre-wrap text-sm">{certificate.notes}</p>
        </PanelSection>
      ) : null}
    </div>
  );
}

// ─── States tab ────────────────────────────────────────────────────────────

function CertificateStatesTab({ certificate }: Readonly<{ certificate: ExemptionCertificate }>) {
  const { t } = useSetupTexts();
  const td = t.certificates.detail;
  const { formatDate, today } = useWeldbooksFormat();
  const day = today();

  return (
    <TabListScope>
      <div className="flex items-center gap-4 border-b border-gray-200/70 px-4 py-2 text-xs text-muted-foreground dark:border-border">
        <span className="min-w-0 flex-1">{td.statesColumns.state}</span>
        <span className="w-[120px] flex-shrink-0 text-right">{td.statesColumns.validUntil}</span>
        <span className="w-[72px] flex-shrink-0 text-right">{td.statesColumns.status}</span>
        <span className="w-[40px] flex-shrink-0" />
      </div>
      {certificate.states.map((code) => {
        const until = certificate.expiryByState[code] ?? null;
        const lapsed = certificate.expiredStates.includes(code) || (until !== null && until < day);
        const name = `${salesTaxStateName(code)} (${code})`;
        return (
          <TabListRow key={code} label={name}>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
            <span className="w-[120px] flex-shrink-0 text-right text-sm tabular-nums">
              {until ? formatDate(until) : t.certificates.expiry.noneInState}
            </span>
            <span
              className={cn(
                'w-[72px] flex-shrink-0 text-right text-sm',
                lapsed ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {lapsed ? td.stateExpired : td.stateValid}
            </span>
          </TabListRow>
        );
      })}
    </TabListScope>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

function CertificateTabBody({
  certificate,
  activeTab,
}: Readonly<{ certificate: ExemptionCertificate; activeTab: TaxExemptionCertificateTab['id'] }>) {
  if (activeTab === 'states') return <CertificateStatesTab certificate={certificate} />;
  if (activeTab === 'history') return <EntityAuditPanel entityType={CERTIFICATE_AUDIT_ENTITY} entityId={certificate.id} />;
  return <CertificateDetailsTab certificate={certificate} />;
}

function CertificatePanelContent(props: Readonly<ObjectPanelComponentProps>) {
  const { id, onClose, initialTab } = props;
  const { t } = useSetupTexts();
  const td = t.certificates.detail;
  const st = useTranslations();
  const access = useSalesTaxSetupAccess();
  const query = useExemptionCertificate(id);
  const update = useUpdateExemptionCertificate();
  const remove = useDeleteExemptionCertificate();
  const certificate: ExemptionCertificate | undefined = query.data;
  const [editOpen, setEditOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const shell = useObjectPanelShell({
    ...props,
    width: CERTIFICATE_PANEL_WIDTH,
    loading: query.isLoading && !certificate,
  });
  const mode = shell.mode;

  const tabs = useMemo(
    () =>
      getTaxExemptionCertificateTabs({
        details: st('sweep.entities.detailsTab'),
        states: td.statesTitle,
        history: st('sweep.entities.auditLogTab'),
        statesCount: certificate?.states.length || undefined,
      }),
    [st, td.statesTitle, certificate?.states.length],
  );

  const initial = useMemo<TaxExemptionCertificateTab['id']>(() => {
    const match = tabs.find((tab) => tab.id === initialTab);
    return match?.id ?? 'overview';
  }, [initialTab, tabs]);
  const [activeTab, setActiveTab] = useState<TaxExemptionCertificateTab['id']>(initial);

  const setStatus = async (status: 'valid' | 'revoked') => {
    if (!certificate) return;
    try {
      await update.mutateAsync({ id: certificate.id, input: { status } });
      toast.success(status === 'revoked' ? td.revoked : td.restored);
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t.common.saveError);
    }
  };

  const confirmDelete = async () => {
    if (!certificate) return;
    try {
      await remove.mutateAsync(certificate.id);
      toast.success(td.deleted);
      setDeleteOpen(false);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t.common.saveError);
      setDeleteOpen(false);
    }
  };

  const notFound = (query.error as { status?: number } | null)?.status === 404;

  let body = null;
  if (query.isError || (!query.isLoading && !certificate)) {
    body = (
      <RecordLoadFailed
        notFound={notFound}
        message={notFound ? td.notFound : td.loadError}
        retryLabel={t.common.retry}
        onRetry={() => void query.refetch()}
      />
    );
  } else if (certificate) {
    body = <CertificateTabBody certificate={certificate} activeTab={activeTab} />;
  }

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        contentClassName={tabBodyClassName(mode)}
        title={<CertificateTitle certificate={certificate} />}
        actions={
          <CertificateActions
            certificate={certificate}
            canUpdate={access.canUpdate}
            canDelete={access.canDelete}
            restoring={update.isPending}
            onEdit={() => setEditOpen(true)}
            onRevoke={() => setRevokeOpen(true)}
            onRestore={() => void setStatus('valid')}
            onDelete={() => setDeleteOpen(true)}
          />
        }
        tabs={
          <ConfigurablePanelTabs
            objectType={CERTIFICATE_TYPE}
            tabs={tabs}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            mode={mode}
          />
        }
      >
        {body}
      </EntityDetailView>

      {certificate ? (
        <CertificateEditDialog certificate={certificate} open={editOpen} onOpenChange={setEditOpen} />
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
    </>
  );
}

export function TaxExemptionCertificatePanel(props: Readonly<ObjectPanelComponentProps>) {
  const { t } = useSetupTexts();
  return (
    <SalesTaxPanelGate
      panelProps={props}
      width={CERTIFICATE_PANEL_WIDTH}
      title={t.certificates.title}
    >
      <CertificatePanelContent {...props} />
    </SalesTaxPanelGate>
  );
}
