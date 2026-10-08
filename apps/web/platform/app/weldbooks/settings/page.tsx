import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Layers, Pencil } from 'lucide-react';
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
import { classificationsOf, isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import { LedgerCatchUpCard } from './components/ledger-catch-up-card';

interface AccountingEmailSettings {
  inboxAddress?: string;
  autoScanEnabled?: boolean;
}

function SummaryRow({ label, value, empty }: Readonly<{ label: string; value: React.ReactNode; empty: string }>) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4 py-2 border-b last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium sm:text-right">{value || <span className="text-muted-foreground">{empty}</span>}</span>
    </div>
  );
}

export default function AccountingSettingsPage() {
  const { data, isLoading } = useAccountingSettings();
  const qc = useQueryClient();
  const { t, language } = useI18n();
  const ts = t.accounting.settings;
  const { entity, features, terminology, labels } = useJurisdictionLabels();
  const { data: jurisdictions } = useAccountingJurisdictions();
  const tu = t.weldbooksUs.setup;
  const isUs = isUsJurisdictionCode(entity?.jurisdictionCode);
  const usEntityTypes = jurisdictions?.find((j) => isUsJurisdictionCode(j.code))?.entityTypes;
  const usClassification = classificationsOf(usEntityTypes, entity?.entityType).find(
    (c) => c.value === entity?.taxClassification,
  );
  const [inboxEmail, setInboxEmail] = useState('');
  const [xafYear, setXafYear] = useState(String(new Date().getFullYear() - 1));
  const [xafDownloading, setXafDownloading] = useState(false);

  const seedWorkflows = useMutation({
    mutationFn: () => accountingApi.seedWorkflows(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['accounting'] }); },
  });

  const registerInbox = useMutation({
    mutationFn: (email: string) => accountingApi.registerInbox(email),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounting', 'settings'] });
      setInboxEmail('');
    },
  });

  if (isLoading) return <PageLoader fullScreen={false} />;

  const settings = data?.data;
  const emailSettings = (settings?.emailSettings ?? {}) as AccountingEmailSettings;

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

  const ids = entity?.taxIdentifiers;
  const taxId = terminology.taxId === 'ein' ? ids?.einOrSsn : ids?.vatNumber;
  const addressLines = formatPostalAddressLines(normalizeAccountingAddress(entity?.address), {
    countryName: (code) => countryName(code, language || 'en'),
  });

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{ts.title}</h1>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
          <div className="space-y-1.5">
            <CardTitle>{ts.companyDetails}</CardTitle>
            <CardDescription>{ts.companyDetailsDesc}</CardDescription>
          </div>
          {entity ? (
            <Button variant="outline" size="sm" asChild>
              <Link to="/weldbooks/entities/$id/edit" params={{ id: entity.id }}>
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
            {isUs ? (
              <>
                <SummaryRow
                  label={tu.entity.entityType}
                  value={entity?.entityType ? ((tu.entityTypes as Record<string, string>)[entity.entityType] ?? entity.entityType) : null}
                  empty={ts.notSet}
                />
                <SummaryRow
                  label={tu.entity.taxClassification}
                  value={
                    usClassification
                      ? tu.entity.classificationOption
                          .replace('{classification}', (tu.classifications as Record<string, string>)[usClassification.value] ?? usClassification.value)
                          .replace('{form}', usClassification.formLabel)
                      : null
                  }
                  empty={ts.notSet}
                />
                <SummaryRow
                  label={tu.entity.accountingMethod}
                  value={entity?.accountingMethod ? tu.entity[entity.accountingMethod === 'cash' ? 'cash' : 'accrual'] : null}
                  empty={ts.notSet}
                />
              </>
            ) : null}
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

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
          <div className="space-y-1.5">
            <CardTitle>{tu.dimensions.settingsCardTitle}</CardTitle>
            <CardDescription>{tu.dimensions.settingsCardDescription}</CardDescription>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to="/weldbooks/settings/dimensions">
              <Layers className="h-4 w-4 mr-1" aria-hidden />
              {tu.dimensions.settingsCardAction}
            </Link>
          </Button>
        </CardHeader>
      </Card>

      <LedgerCatchUpCard />

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

      {features.xafExport && (
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
      )}
    </div>
  );
}
