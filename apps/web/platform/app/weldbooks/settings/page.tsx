import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { LayoutTemplate, Pencil, Ungroup } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { useAccountingJurisdictions, useAccountingSettings } from '@/hooks/queries/use-accounting-queries';
import { PageLoader } from '@/components/page-loader';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import { formatPostalAddressLines } from '@/components/address/postal-address';
import { countryName } from '@/components/address/countries';
import { classificationsOf, isUsJurisdictionCode, type UsTaxClassificationOption } from '@/lib/weldbooks/us-entity';
import { LedgerCatchUpCard } from './components/ledger-catch-up-card';
import { FiscalSettingsCard } from './components/fiscal-settings-card';
import { EcdExportDialog } from '../vat/components/ecd-export-dialog';

interface AccountingEmailSettings {
  inboxAddress?: string;
  autoScanEnabled?: boolean;
}

type JurisdictionLabels = ReturnType<typeof useJurisdictionLabels>;
type SettingsEntity = NonNullable<JurisdictionLabels['entity']>;

function SummaryRow({ label, value, empty }: Readonly<{ label: string; value: React.ReactNode; empty: string }>) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4 py-2 border-b last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium sm:text-right">{value || <span className="text-muted-foreground">{empty}</span>}</span>
    </div>
  );
}

/** A code through its label map, the code itself when the map lacks it; null when there is no code. */
function labelOf(map: unknown, code: string | null | undefined): string | null {
  return code ? ((map as Record<string, string>)[code] ?? code) : null;
}

/** The US entity type, tax classification and accounting method rows of the company details. */
function UsEntitySummaryRows({
  entity,
  usClassification,
}: Readonly<{ entity: SettingsEntity; usClassification: UsTaxClassificationOption | undefined }>) {
  const { t } = useI18n();
  const ts = t.accounting.settings;
  const tu = t.weldbooksUs.setup;
  const classification = usClassification
    ? tu.entity.classificationOption
        .replace('{classification}', (tu.classifications as Record<string, string>)[usClassification.value] ?? usClassification.value)
        .replace('{form}', usClassification.formLabel)
    : null;
  const accountingMethod = entity?.accountingMethod === 'cash' ? 'cash' : 'accrual';
  return (
    <>
      <SummaryRow
        label={tu.entity.entityType}
        value={labelOf(tu.entityTypes, entity?.entityType)}
        empty={ts.notSet}
      />
      <SummaryRow
        label={tu.entity.taxClassification}
        value={classification}
        empty={ts.notSet}
      />
      <SummaryRow
        label={tu.entity.accountingMethod}
        value={entity?.accountingMethod ? tu.entity[accountingMethod] : null}
        empty={ts.notSet}
      />
    </>
  );
}

/** The selected entity's legal name, identifiers, regime and address, with a link to edit them. */
function CompanyDetailsCard({
  jurisdiction,
  isUs,
  usClassification,
}: Readonly<{ jurisdiction: JurisdictionLabels; isUs: boolean; usClassification: UsTaxClassificationOption | undefined }>) {
  const { t, language } = useI18n();
  const ts = t.accounting.settings;
  const tbr = t.weldbooksBr;
  const { entity, features, terminology, labels } = jurisdiction;

  const ids = entity?.taxIdentifiers;
  const taxId = terminology.taxId === 'ein' ? ids?.einOrSsn : ids?.vatNumber;
  const addressLines = formatPostalAddressLines(normalizeAccountingAddress(entity?.address), {
    countryName: (code) => countryName(code, language || 'en'),
  });

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{ts.companyDetails}</CardTitle>
          <CardDescription>{ts.companyDetailsDesc}</CardDescription>
        </div>
        {entity ? (
          <Button variant="outline" size="sm" asChild>
            <Link
              to="/settings/entities/$id/edit"
              params={{ id: entity.id }}
              // The settings back button returns here.
              onClick={() => sessionStorage.setItem('settings-return-url', globalThis.location.pathname)}
            >
              <Pencil className="h-4 w-4 mr-1" aria-hidden />
              {ts.editEntityDetails}
            </Link>
          </Button>
        ) : null}
      </CardHeader>
      {entity ? (
        <CardContent>
          <SummaryRow label={ts.legalNameLabel} value={entity.legalName || entity.name} empty={ts.notSet} />
          <SummaryRow label={labels.taxId} value={taxId} empty={ts.notSet} />
          <SummaryRow label={labels.registrationId} value={ids?.registrationNumber} empty={ts.notSet} />
          {features.brTaxReturn ? (
            <SummaryRow
              label={tbr.entity.regime}
              value={labelOf(tbr.entity.regimes, entity?.taxClassification)}
              empty={ts.notSet}
            />
          ) : null}
          {isUs ? <UsEntitySummaryRows entity={entity} usClassification={usClassification} /> : null}
          <SummaryRow
            label={ts.addressLabel}
            value={
              addressLines.length > 0 ? (
                <span className="block">
                  {addressLines.map((line) => <span key={line} className="block">{line}</span>)}
                </span>
              ) : null
            }
            empty={ts.notSet}
          />
        </CardContent>
      ) : null}
    </Card>
  );
}

/** The registered scan inbox and the form to register one. */
function EmailInboxCard({ emailSettings }: Readonly<{ emailSettings: AccountingEmailSettings }>) {
  const qc = useQueryClient();
  const { t } = useI18n();
  const ts = t.accounting.settings;
  const [inboxEmail, setInboxEmail] = useState('');

  const registerInbox = useMutation({
    mutationFn: (email: string) => accountingApi.registerInbox(email),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounting', 'settings'] });
      setInboxEmail('');
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{ts.emailInbox}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {emailSettings.inboxAddress ? (
          <div className="text-sm">
            <span className="text-muted-foreground">{ts.activeInbox} </span>
            <span className="font-medium">{emailSettings.inboxAddress}</span>
            {emailSettings.autoScanEnabled && (
              <span className="ml-2 text-green-600 dark:text-green-400 text-xs">{ts.autoScanEnabled}</span>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {ts.noInboxRegistered}
          </p>
        )}
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            type="email"
            aria-label={ts.emailInbox}
            placeholder={ts.inboxEmailPlaceholder}
            value={inboxEmail}
            onChange={(e) => setInboxEmail(e.target.value)}
            className="sm:max-w-sm"
          />
          <Button
            variant="outline"
            onClick={() => registerInbox.mutate(inboxEmail)}
            disabled={!inboxEmail || registerInbox.isPending}
          >
            {registerInbox.isPending ? ts.registering : ts.registerInbox}
          </Button>
        </div>
        {registerInbox.isSuccess && (
          <p className="text-sm text-green-600 dark:text-green-400">{ts.inboxRegistered}</p>
        )}
      </CardContent>
    </Card>
  );
}

/** Seeds the workflow templates of the module. */
function SeedDataCard() {
  const qc = useQueryClient();
  const { t } = useI18n();
  const ts = t.accounting.settings;

  const seedWorkflows = useMutation({
    mutationFn: () => accountingApi.seedWorkflows(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['accounting'] }); },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{ts.seedData}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {ts.seedDataDesc}
        </p>
        <div className="flex gap-2">
          <Button
            onClick={() => seedWorkflows.mutate()}
            disabled={seedWorkflows.isPending}
            variant="outline"
          >
            {seedWorkflows.isPending ? ts.seeding : ts.seedWorkflowTemplates}
          </Button>
        </div>
        {seedWorkflows.isSuccess && (
          <p className="text-sm text-green-600 dark:text-green-400">
            {ts.workflowsSeeded.replace('{count}', String(seedWorkflows.data?.data?.templatesCreated ?? 0))}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** The Dutch XAF audit file of a year, as a download. */
function XafExportCard() {
  const { t } = useI18n();
  const ts = t.accounting.settings;
  const [xafYear, setXafYear] = useState(String(new Date().getFullYear() - 1));
  const [xafDownloading, setXafDownloading] = useState(false);

  const handleXafDownload = async () => {
    setXafDownloading(true);
    try {
      const xml = await accountingApi.getXafAuditfile(Number.parseInt(xafYear, 10));
      const blob = new Blob([xml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `auditfile-${xafYear}.xaf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(ts.xafFailed, { description: err instanceof Error ? err.message : undefined });
    } finally {
      setXafDownloading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{ts.xafTitle}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{ts.xafDesc}</p>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            aria-label={ts.xafTitle}
            value={xafYear}
            onChange={(e) => setXafYear(e.target.value)}
            className="max-w-[120px]"
          />
          <Button onClick={handleXafDownload} disabled={xafDownloading} variant="outline">
            {xafDownloading ? ts.xafDownloading : ts.xafDownload}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function AccountingSettingsPage() {
  const { data, isLoading } = useAccountingSettings();
  const { t } = useI18n();
  const ts = t.accounting.settings;
  const jurisdiction = useJurisdictionLabels();
  const { entity, features } = jurisdiction;
  const { data: jurisdictions } = useAccountingJurisdictions();
  const tu = t.weldbooksUs.setup;
  const tit = t.accounting.invoiceTemplates.settingsCard;
  const isUs = isUsJurisdictionCode(entity?.jurisdictionCode);
  const usEntityTypes = jurisdictions?.find((j) => isUsJurisdictionCode(j.code))?.entityTypes;
  const usClassification = classificationsOf(usEntityTypes, entity?.entityType).find(
    (c) => c.value === entity?.taxClassification,
  );
  const [ecdOpen, setEcdOpen] = useState(false);
  const tbr = t.weldbooksBr;

  if (isLoading) return <PageLoader fullScreen={false} />;

  const settings = data?.data;
  const emailSettings = (settings?.emailSettings ?? {}) as AccountingEmailSettings;

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{ts.title}</h1>

      <CompanyDetailsCard jurisdiction={jurisdiction} isUs={isUs} usClassification={usClassification} />

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
          <div className="space-y-1.5">
            <CardTitle>{tu.dimensions.settingsCardTitle}</CardTitle>
            <CardDescription>{tu.dimensions.settingsCardDescription}</CardDescription>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to="/weldbooks/settings/dimensions">
              <Ungroup className="h-4 w-4 mr-1" aria-hidden />
              {tu.dimensions.settingsCardAction}
            </Link>
          </Button>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
          <div className="space-y-1.5">
            <CardTitle>{tit.title}</CardTitle>
            <CardDescription>{tit.description}</CardDescription>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to="/weldbooks/settings/invoice-templates">
              <LayoutTemplate className="h-4 w-4 mr-1" aria-hidden />
              {tit.action}
            </Link>
          </Button>
        </CardHeader>
      </Card>

      <LedgerCatchUpCard />

      <EmailInboxCard emailSettings={emailSettings} />

      <SeedDataCard />

      {features.fiscalDocuments && <FiscalSettingsCard />}

      {features.spedEcd && (
        <Card>
          <CardHeader>
            <CardTitle>{tbr.ecd.settingsTitle}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{tbr.ecd.settingsDescription}</p>
            <Button variant="outline" onClick={() => setEcdOpen(true)}>
              {tbr.ecd.open}
            </Button>
          </CardContent>
        </Card>
      )}
      <EcdExportDialog open={ecdOpen} onOpenChange={setEcdOpen} />

      {features.xafExport && <XafExportCard />}
    </div>
  );
}
