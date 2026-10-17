/**
 * The WeldBooks settings of one entity: the WeldBooks tab of Settings →
 * Entities → (entity). The cards and the pages they open work on the entity
 * selected in WeldBooks, so opening the tab selects this entity there.
 */

import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { LayoutTemplate, Ungroup } from 'lucide-react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { PageLoader } from '@/components/page-loader';
import { useAccountingSettings } from '@/hooks/queries/use-accounting-queries';
import { useAccountingEntities } from '@/hooks/use-current-entity-currency';
import { accountingApi, type AccountingEntity } from '@/lib/api/domains/weldbooks';
import type { JurisdictionFeatures } from '@/lib/weldbooks/jurisdiction';
import { useI18n } from '@/lib/i18n/provider';
import { LedgerCatchUpCard } from './components/ledger-catch-up-card';
import { FiscalSettingsCard } from './components/fiscal-settings-card';
import { useSelectWeldbooksEntity } from './entity-scope';
import { EcdExportDialog } from '../vat/components/ecd-export-dialog';

interface AccountingEmailSettings {
  inboxAddress?: string;
  autoScanEnabled?: boolean;
}

/** A card that opens another WeldBooks settings page through `link`. */
function LinkCard({
  title,
  description,
  link,
}: Readonly<{ title: string; description: string; link: React.ReactNode }>) {
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <Button variant="outline" size="sm" asChild>
          {link}
        </Button>
      </CardHeader>
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

/** The SPED ECD export of a Brazilian entity. */
function EcdExportCard() {
  const { t } = useI18n();
  const tbr = t.weldbooksBr;
  const [open, setOpen] = useState(false);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{tbr.ecd.settingsTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{tbr.ecd.settingsDescription}</p>
          <Button variant="outline" onClick={() => setOpen(true)}>
            {tbr.ecd.open}
          </Button>
        </CardContent>
      </Card>
      <EcdExportDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export function WeldbooksEntitySettings({
  entity,
  features,
}: Readonly<{ entity: Pick<AccountingEntity, 'id' | 'name'>; features: JurisdictionFeatures }>) {
  const { t } = useI18n();
  const te = t.accounting.entityEdit;
  const tu = t.weldbooksUs.setup;
  const tit = t.accounting.invoiceTemplates.settingsCard;
  const selected = useSelectWeldbooksEntity(entity.id);
  const { data: entities } = useAccountingEntities();
  const { data, isLoading } = useAccountingSettings();

  if (!selected || isLoading) return <PageLoader fullScreen={false} />;

  const emailSettings = (data?.data?.emailSettings ?? {}) as AccountingEmailSettings;

  return (
    <div className="space-y-6">
      {(entities?.length ?? 0) > 1 && (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {te.weldbooksSwitched.replace('{name}', entity.name)}
        </p>
      )}

      <LinkCard
        title={tu.dimensions.settingsCardTitle}
        description={tu.dimensions.settingsCardDescription}
        link={
          <Link to="/weldbooks/settings/dimensions">
            <Ungroup className="h-4 w-4 mr-1" aria-hidden />
            {tu.dimensions.settingsCardAction}
          </Link>
        }
      />

      <LinkCard
        title={tit.title}
        description={tit.description}
        link={
          <Link to="/settings/entities/$id/invoice-templates" params={{ id: entity.id }}>
            <LayoutTemplate className="h-4 w-4 mr-1" aria-hidden />
            {tit.action}
          </Link>
        }
      />

      <LedgerCatchUpCard />

      <EmailInboxCard emailSettings={emailSettings} />

      <SeedDataCard />

      {features.fiscalDocuments && <FiscalSettingsCard />}

      {features.spedEcd && <EcdExportCard />}

      {features.xafExport && <XafExportCard />}
    </div>
  );
}
