import { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { useAccountingSettings } from '@/hooks/queries/use-accounting-queries';
import { PageLoader } from '@/components/page-loader';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';

interface AccountingCompanyDetails {
  name?: string;
  btwNumber?: string;
  kvkNumber?: string;
  iban?: string;
}

interface AccountingEmailSettings {
  inboxAddress?: string;
  autoScanEnabled?: boolean;
}

export default function AccountingSettingsPage() {
  const { data, isLoading } = useAccountingSettings();
  const qc = useQueryClient();
  const { t } = useI18n();
  const ts = t.accounting.settings;
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
  const companyDetails = (settings?.companyDetails ?? {}) as AccountingCompanyDetails;
  const emailSettings = (settings?.emailSettings ?? {}) as AccountingEmailSettings;

  const handleXafDownload = async () => {
    setXafDownloading(true);
    try {
      const xml = await accountingApi.getXafAuditfile(parseInt(xafYear, 10));
      const blob = new Blob([xml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `auditfile-${xafYear}.xaf`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setXafDownloading(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{ts.title}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{ts.companyDetails}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{ts.companyName}</Label>
              <Input defaultValue={companyDetails.name ?? ''} placeholder={ts.companyNamePlaceholder} />
            </div>
            <div className="space-y-2">
              <Label>{ts.vatNumber}</Label>
              <Input defaultValue={companyDetails.btwNumber ?? ''} placeholder={ts.vatNumberPlaceholder} />
            </div>
            <div className="space-y-2">
              <Label>{ts.chamberOfCommerce}</Label>
              <Input defaultValue={companyDetails.kvkNumber ?? ''} placeholder={ts.cocPlaceholder} />
            </div>
            <div className="space-y-2">
              <Label>{ts.iban}</Label>
              <Input defaultValue={companyDetails.iban ?? ''} placeholder={ts.ibanPlaceholder} />
            </div>
          </div>
          <Button>{ts.saveCompanyDetails}</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{ts.numbering}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{ts.invoicePrefix}</Label>
              <Input defaultValue={settings?.invoiceNumberPrefix ?? 'INV-'} placeholder="INV-" />
            </div>
            <div className="space-y-2">
              <Label>{ts.nextInvoiceNumber}</Label>
              <Input
                type="number"
                defaultValue={settings?.invoiceNumberNext ?? 1}
                placeholder="1"
              />
            </div>
          </div>
          <Button>{ts.saveNumbering}</Button>
        </CardContent>
      </Card>

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
                <span className="ml-2 text-green-600 text-xs">{ts.autoScanEnabled}</span>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {ts.noInboxRegistered}
            </p>
          )}
          <div className="flex gap-2">
            <Input
              type="email"
              placeholder={ts.inboxEmailPlaceholder}
              value={inboxEmail}
              onChange={(e) => setInboxEmail(e.target.value)}
              className="max-w-sm"
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
            <p className="text-sm text-green-600">{ts.inboxRegistered}</p>
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
            <p className="text-sm text-green-600">
              {ts.workflowsSeeded.replace('{count}', String(seedWorkflows.data?.data?.templatesCreated ?? 0))}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{ts.xafTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{ts.xafDesc}</p>
          <div className="flex items-center gap-2">
            <Input
              type="number"
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
    </div>
  );
}
