/**
 * Sales tax agency object panel (WeldBooks, US).
 *
 * Built on the same shell as the company / person / bank account panels:
 * `useObjectPanelShell` + `EntityDetailView` + `ObjectPanelTabs`, so it
 * inherits the shared header chrome, the panel↔fullscreen toggle and the
 * stacking/back behaviour. It replaces the standalone
 * `/weldbooks/sales-tax/agencies/:id` page, which now redirects to the list
 * with this panel open in fullscreen.
 *
 * Tabs: Details · Jurisdictions and rates · Zones · Taxability rules · History.
 */

import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Building2,
  CalendarClock,
  CalendarDays,
  CircleDot,
  Edit,
  EllipsisVertical,
  ExternalLink,
  Globe,
  Hash,
  Landmark,
  Link as LinkIcon,
  MapPin,
  Repeat,
  Scale,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
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
import { RowChip, StatusChip } from '@/components/accounting/weldbooks-row-cells';
import { ConfigurablePanelTabs } from '@/components/objects/_shared/configurable-panel-tabs';
import {
  PanelAvatar,
  PanelRow,
  PanelNotice,
  PanelSection,
  useCopyPanelLink,
} from '@/components/objects/_shared/record-panel-parts';
import { SalesTaxPanelGate } from '@/components/objects/_shared/sales-tax-panel-gate';
import { tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import {
  useDeleteSalesTaxAgency,
  useSalesTaxAgency,
  useSalesTaxSettings,
} from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import type { SalesTaxAgency } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { salesTaxStateName } from '@/lib/weldbooks/us-sales-tax-states';
import { AgencyEditDialog } from '@/app/weldbooks/sales-tax/agencies/agency-edit-dialog';
import { AgencyStatusMenu } from '@/app/weldbooks/sales-tax/agencies/agency-status-menu';
import { StateInfoPanel } from '@/app/weldbooks/sales-tax/agencies/state-info-panel';
import { dueDayText } from '@/app/weldbooks/sales-tax/setup/format';
import { useSalesTaxSetupAccess } from '@/app/weldbooks/sales-tax/setup/setup-gate';
import { useSetupTexts } from '@/app/weldbooks/sales-tax/setup/setup-texts';
import { AgencyJurisdictionsTab } from './agency-jurisdictions-tab';
import { AgencyRulesTab } from './agency-rules-tab';
import { AgencyZonesTab } from './agency-zones-tab';
import { AGENCY_STATUS_TONE } from './sales-tax-agency-model';
import { getSalesTaxAgencyTabs, type SalesTaxAgencyTab } from './sales-tax-agency-tabs';

const AGENCY_PANEL_WIDTH = 480;
const AGENCY_TYPE = 'sales_tax_agency';

function AgencyAvatar() {
  return (
    <PanelAvatar
      icon={Building2}
      className="bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-400"
    />
  );
}

function AgencyTitle({ agency }: Readonly<{ agency?: SalesTaxAgency }>) {
  const { t } = useSetupTexts();
  if (!agency) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate text-[15px] font-medium text-foreground">
        {salesTaxStateName(agency.stateCode)} ({agency.stateCode})
      </span>
      <span className="flex-shrink-0">
        <StatusChip tone={AGENCY_STATUS_TONE[agency.status] ?? 'gray'}>
          {t.statuses[agency.status] ?? agency.status}
        </StatusChip>
      </span>
      {agency.level === 'local' ? <RowChip tone="gray">{t.agencies.localBadge}</RowChip> : null}
    </div>
  );
}

function AgencyActions({
  agency,
  canUpdate,
  canDelete,
  onEdit,
  onDelete,
}: Readonly<{
  agency?: SalesTaxAgency;
  canUpdate: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
}>) {
  const st = useTranslations();
  const { t } = useSetupTexts();
  const copyLink = useCopyPanelLink('/weldbooks/sales-tax/agencies', AGENCY_TYPE, agency?.id ?? '');
  if (!agency) return null;

  return (
    <div className="flex items-center gap-0.5">
      {canUpdate ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7"
          title={t.agency.editRegistration}
          aria-label={t.agency.editRegistration}
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
          <DropdownMenuItem onClick={() => void copyLink()}>
            <LinkIcon />
            {st('sweep.entities.copyLink')}
          </DropdownMenuItem>
          {canDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 />
                {t.agency.delete}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Details tab ───────────────────────────────────────────────────────────

function ledgerAccount(account: SalesTaxAgency['liabilityAccount']): string | null {
  return account ? `${account.code} ${account.name}` : null;
}

function AgencyDetailsTab({ agency, canUpdate }: Readonly<{ agency: SalesTaxAgency; canUpdate: boolean }>) {
  const { t, format } = useSetupTexts();
  const ta = t.agency;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const settings = useSalesTaxSettings();
  const engine = settings.data?.engine ?? 'manual';
  const stateName = salesTaxStateName(agency.stateCode);
  const countsTax = agency.status === 'registered';

  return (
    <div className="p-4 space-y-5">
      {countsTax ? null : (
        <PanelNotice>{format(ta.notRegisteredNote, { status: t.statuses[agency.status] })}</PanelNotice>
      )}
      {engine === 'manual' ? null : (
        <PanelNotice>
          <span className="block font-medium text-foreground">
            {format(ta.notManual.title, { engine: t.engine.options[engine].name })}
          </span>
          <span className="block">{ta.notManual.description}</span>
          <Link to="/weldbooks/sales-tax/settings" className="text-primary underline-offset-4 hover:underline">
            {ta.notManual.link}
          </Link>
        </PanelNotice>
      )}

      <PanelSection title={ta.sections.registration}>
        <div className="space-y-1">
          <PanelRow icon={Building2} label={t.agencies.columns.agency} value={agency.name} />
          <PanelRow
            icon={CircleDot}
            label={ta.fields.status}
            value={t.statuses[agency.status]}
            renderValue={(value) => (
              <StatusChip tone={AGENCY_STATUS_TONE[agency.status] ?? 'gray'}>{value}</StatusChip>
            )}
            accessory={canUpdate ? <AgencyStatusMenu agency={agency} /> : undefined}
          />
          <PanelRow icon={Hash} label={ta.fields.registrationNumber} value={agency.registrationNumber} />
          <PanelRow
            icon={CalendarDays}
            label={ta.fields.registeredFrom}
            value={formatDate(agency.registeredFrom, '')}
          />
          <PanelRow
            icon={CalendarDays}
            label={ta.fields.registeredUntil}
            value={formatDate(agency.registeredUntil, '')}
          />
          {agency.level === 'local' ? (
            <PanelRow
              icon={MapPin}
              label={ta.fields.jurisdictionCode}
              value={agency.localJurisdictionCode}
            />
          ) : null}
        </div>
      </PanelSection>

      <PanelSection title={ta.sections.filing}>
        <div className="space-y-1">
          <PanelRow icon={Repeat} label={ta.fields.frequency} value={t.frequencies[agency.filingFrequency]} />
          <PanelRow
            icon={CalendarDays}
            label={ta.fields.firstPeriodStart}
            value={formatDate(agency.firstPeriodStart, '')}
          />
          <PanelRow
            icon={CalendarClock}
            label={ta.fields.dueDay}
            value={dueDayText(agency.dueDay, t.dueDay, format)}
          />
          <PanelRow icon={Scale} label={ta.fields.basis} value={t.bases[agency.reportingBasis]} />
          <PanelRow
            icon={ShieldCheck}
            label={ta.fields.sst}
            value={agency.sstMember ? ta.sstMember : ta.notSstMember}
          />
          <PanelRow
            icon={Globe}
            label={ta.fields.portal}
            value={agency.portalUrl}
            renderValue={(url) => (
              <a
                href={url ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
              >
                {ta.openPortal}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            )}
          />
        </div>
      </PanelSection>

      <PanelSection title={ta.sections.ledger}>
        <div className="space-y-1">
          <PanelRow
            icon={Landmark}
            label={ta.fields.liability}
            value={ledgerAccount(agency.liabilityAccount)}
          />
          <PanelRow
            icon={Landmark}
            label={`${ta.fields.liability}: ${ta.fields.balance}`}
            value={agency.liabilityAccount ? formatMoney(agency.liabilityAccount.balance ?? '0') : null}
          />
          <PanelRow
            icon={Landmark}
            label={ta.fields.useTax}
            value={ledgerAccount(agency.useTaxAccount)}
          />
          <PanelRow
            icon={Landmark}
            label={`${ta.fields.useTax}: ${ta.fields.balance}`}
            value={agency.useTaxAccount ? formatMoney(agency.useTaxAccount.balance ?? '0') : null}
          />
        </div>
      </PanelSection>

      {agency.notes ? (
        <PanelSection title={ta.fields.notes}>
          <p className="whitespace-pre-wrap text-sm">{agency.notes}</p>
        </PanelSection>
      ) : null}

      <details className="group rounded-lg border">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
          {format(ta.sections.about, { state: stateName })}
        </summary>
        <div className="border-t p-4">
          <StateInfoPanel stateCode={agency.stateCode} className="border-0 shadow-none" />
        </div>
      </details>
    </div>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

function AgencyPanelContent(props: Readonly<ObjectPanelComponentProps>) {
  const { id, onClose, initialTab } = props;
  const { t } = useSetupTexts();
  const ta = t.agency;
  const st = useTranslations();
  const access = useSalesTaxSetupAccess();
  const agencyQuery = useSalesTaxAgency(id);
  const agency = agencyQuery.data;
  const remove = useDeleteSalesTaxAgency();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const shell = useObjectPanelShell({
    ...props,
    width: AGENCY_PANEL_WIDTH,
    loading: agencyQuery.isLoading && !agency,
  });
  const mode = shell.mode;

  const tabs = useMemo(
    () =>
      getSalesTaxAgencyTabs({
        details: st('sweep.entities.detailsTab'),
        jurisdictions: ta.tabs.jurisdictions,
        zones: ta.tabs.zones,
        rules: ta.tabs.rules,
        history: st('sweep.entities.auditLogTab'),
      }),
    [st, ta.tabs],
  );

  const initial = useMemo<SalesTaxAgencyTab['id']>(() => {
    const match = tabs.find((tab) => tab.id === initialTab);
    return match?.id ?? 'overview';
  }, [initialTab, tabs]);
  const [activeTab, setActiveTab] = useState<SalesTaxAgencyTab['id']>(initial);

  const tabAccess = { canCreate: access.canCreate, canUpdate: access.canUpdate, canDelete: access.canDelete };
  const notFound = (agencyQuery.error as { status?: number } | null)?.status === 404;

  const confirmDelete = async () => {
    if (!agency) return;
    try {
      const result = await remove.mutateAsync(agency.id);
      if (result.deleted) {
        toast.success(ta.deleted);
        setDeleteOpen(false);
        onClose();
      } else {
        // Tax was collected under it, so it was closed to keep the history.
        toast.info(ta.closedInstead);
        setDeleteOpen(false);
      }
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t.common.saveError);
      setDeleteOpen(false);
    }
  };

  let body = null;
  if (agencyQuery.isError || (!agencyQuery.isLoading && !agency)) {
    body = (
      <div className="space-y-3 p-4">
        <p className={notFound ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'} role={notFound ? undefined : 'alert'}>
          {notFound ? ta.notFound : ta.loadError}
        </p>
        {notFound ? null : (
          <Button type="button" variant="outline" size="sm" onClick={() => void agencyQuery.refetch()}>
            {t.common.retry}
          </Button>
        )}
      </div>
    );
  } else if (agency && activeTab === 'overview') {
    body = <AgencyDetailsTab agency={agency} canUpdate={access.canUpdate} />;
  } else if (agency && activeTab === 'jurisdictions') {
    body = <AgencyJurisdictionsTab agency={agency} access={tabAccess} />;
  } else if (agency && activeTab === 'zones') {
    body = <AgencyZonesTab agency={agency} access={tabAccess} />;
  } else if (agency && activeTab === 'rules') {
    body = <AgencyRulesTab agency={agency} access={tabAccess} />;
  } else if (agency && activeTab === 'history') {
    body = <EntityAuditPanel entityType={AGENCY_TYPE} entityId={agency.id} />;
  }

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        contentClassName={tabBodyClassName(mode)}
        avatar={<AgencyAvatar />}
        title={<AgencyTitle agency={agency} />}
        actions={
          <AgencyActions
            agency={agency}
            canUpdate={access.canUpdate}
            canDelete={access.canDelete}
            onEdit={() => setEditOpen(true)}
            onDelete={() => setDeleteOpen(true)}
          />
        }
        tabs={
          <ConfigurablePanelTabs
            objectType={AGENCY_TYPE}
            tabs={tabs}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            mode={mode}
          />
        }
      >
        {body}
      </EntityDetailView>

      {agency ? <AgencyEditDialog agency={agency} open={editOpen} onOpenChange={setEditOpen} /> : null}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={ta.deleteDialog.title}
        description={ta.deleteDialog.description}
        confirmLabel={ta.deleteDialog.confirm}
        cancelLabel={t.common.cancel}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </>
  );
}

export function SalesTaxAgencyPanel(props: Readonly<ObjectPanelComponentProps>) {
  const { t } = useSetupTexts();
  return (
    <SalesTaxPanelGate
      panelProps={props}
      width={AGENCY_PANEL_WIDTH}
      title={t.agencies.title}
      avatar={<AgencyAvatar />}
    >
      <AgencyPanelContent {...props} />
    </SalesTaxPanelGate>
  );
}
