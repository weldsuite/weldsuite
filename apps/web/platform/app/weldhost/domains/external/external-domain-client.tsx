
import { useEffect, useState } from 'react';
import { useRouter } from '@/lib/router';
import { HostEntityFormLayout, type HostFormSection, type HostSummaryField } from '../../components/host-entity-form-layout';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import {
  ExternalLink,
  Globe,
  Server,
  Info,
  CheckCircle,
  AlertCircle,
  Shield,
  Copy,
  Check,
  Loader2,
  Database,
} from 'lucide-react';
import { toast } from 'sonner';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import {
  useAddExternalDomain,
  useVerifyDomainOwnership,
  useScanDnsRecords,
  useImportDnsRecords,
  type ScannedDnsRecord,
} from '@/hooks/queries/use-host-queries';

type Step = 'enter' | 'verify' | 'import' | 'nameservers';

interface VerificationRecord {
  name: string;
  type: 'TXT';
  value: string;
}

interface CopyRowProps {
  label: string;
  value: string;
}

function CopyRow({ label, value }: CopyRowProps) {
  const { t } = useI18n();
  const tx = t.host.externalDomain;
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(tx.copiedToast.replace('{label}', label));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(tx.copyFailed);
    }
  };
  return (
    <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/30 gap-3">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <span className="text-xs font-medium text-muted-foreground w-16 shrink-0">{label}</span>
        <code className="font-mono text-sm font-medium truncate">{value}</code>
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={handleCopy}>
        {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );
}

export function ExternalDomainClient() {
  const { t } = useI18n();
  const tx = t.host.externalDomain;

  useBreadcrumbs([
    { label: tx.breadcrumbHost, href: '/weldhost' },
    { label: tx.breadcrumbDomains, href: '/weldhost/domains' },
    { label: tx.breadcrumbAdd },
  ]);

  const router = useRouter();
  const [step, setStep] = useState<Step>('enter');
  const [domainName, setDomainName] = useState('');
  const [registrar, setRegistrar] = useState('');
  const [domainId, setDomainId] = useState<string | null>(null);
  const [verificationRecord, setVerificationRecord] = useState<VerificationRecord | null>(null);
  const [nameservers, setNameservers] = useState<string[]>([]);

  const [scannedRecords, setScannedRecords] = useState<ScannedDnsRecord[] | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  const addExternalDomain = useAddExternalDomain();
  const verifyOwnership = useVerifyDomainOwnership();
  const scanDnsRecords = useScanDnsRecords();
  const importDnsRecords = useImportDnsRecords();

  const countText = (count: number, singular: string, plural: string) =>
    count === 1 ? singular : plural.replace('{count}', String(count));

  // Stable key per record so we can track selection.
  const recordKey = (r: ScannedDnsRecord) =>
    `${r.type}|${r.name}|${r.value}|${r.priority ?? ''}`;

  // When we enter the import step, kick off the scan once.
  useEffect(() => {
    if (step !== 'import' || !domainId || scanDnsRecords.isPending || scannedRecords !== null) {
      return;
    }
    scanDnsRecords.mutateAsync(domainId).then(
      (res) => {
        const records = res.data.records ?? [];
        setScannedRecords(records);
        setSelectedKeys(new Set(records.map(recordKey)));
      },
      (err: unknown) => {
        toast.error(err instanceof Error ? err.message : tx.errorScanFailed);
        setScannedRecords([]);
      },
    );
  }, [step, domainId, scannedRecords, scanDnsRecords, tx.errorScanFailed]);

  const handleReserve = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!domainName.trim()) {
      toast.error(tx.errorEnterDomain);
      return;
    }
    try {
      const res = await addExternalDomain.mutateAsync({
        domain: domainName.trim().toLowerCase(),
        registrar: registrar || undefined,
      });
      setDomainId(res.data.id);
      setVerificationRecord(res.data.verificationRecord);
      setStep('verify');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tx.errorReserveFailed);
    }
  };

  const handleVerify = async () => {
    if (!domainId) return;
    try {
      const res = await verifyOwnership.mutateAsync(domainId);
      setNameservers(res.data.nameservers ?? []);
      setStep('import');
      toast.success(tx.verifiedToast);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tx.errorVerifyFailed);
    }
  };

  const toggleRecord = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    if (!scannedRecords) return;
    setSelectedKeys((prev) => {
      if (prev.size === scannedRecords.length) return new Set();
      return new Set(scannedRecords.map(recordKey));
    });
  };

  const handleImport = async () => {
    if (!domainId || !scannedRecords) return;
    const toImport = scannedRecords.filter((r) => selectedKeys.has(recordKey(r)));
    if (toImport.length === 0) {
      setStep('nameservers');
      return;
    }
    try {
      const res = await importDnsRecords.mutateAsync({ domainId, records: toImport });
      const { imported, skipped, failed } = res.data;
      if (failed.length > 0) {
        toast.warning(
          tx.importPartialToast
            .replace('{imported}', String(imported))
            .replace('{skipped}', String(skipped))
            .replace('{failed}', String(failed.length)),
        );
      } else {
        const importedText = countText(imported, tx.importSuccessSingular, tx.importSuccessPlural);
        const skippedText = skipped
          ? countText(skipped, tx.importSkippedSingular, tx.importSkippedPlural)
          : '';
        toast.success(`${importedText}${skippedText}`);
      }
      setStep('nameservers');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tx.errorImportFailed);
    }
  };

  const handleSkipImport = () => {
    setStep('nameservers');
  };

  const handleFinish = () => {
    if (domainId) {
      router.push(`/weldhost/domains/${domainId}`);
    } else {
      router.push('/weldhost/domains');
    }
  };

  // ---- Step 1: Enter domain ---------------------------------------------
  if (step === 'enter') {
    const sections: HostFormSection[] = [
      {
        title: tx.sectionDomainInfo,
        icon: Globe,
        content: (
          <div className="space-y-4">
            <div>
              <Label htmlFor="domain" className="flex items-center gap-1.5">
                {tx.domainNameLabel}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{tx.domainNameTooltip}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </Label>
              <div className="relative mt-2">
                <Globe className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                <Input
                  id="domain"
                  name="domain"
                  placeholder={tx.domainPlaceholder}
                  className="pl-10"
                  value={domainName}
                  onChange={(e) => setDomainName(e.target.value)}
                  required
                />
              </div>
            </div>

            <div>
              <Label htmlFor="registrar" className="flex items-center gap-1.5">
                {tx.registrarLabel}
              </Label>
              <div className="mt-2">
                <Input
                  id="registrar"
                  name="registrar"
                  placeholder={tx.registrarPlaceholder}
                  value={registrar}
                  onChange={(e) => setRegistrar(e.target.value)}
                />
              </div>
            </div>

            <Alert>
              <Shield className="h-4 w-4" />
              <AlertTitle>{tx.ownershipAlertTitle}</AlertTitle>
              <AlertDescription>{tx.ownershipAlertDescription}</AlertDescription>
            </Alert>
          </div>
        ),
      },
    ];

    const summaryFields: HostSummaryField[] = [
      { label: tx.stepLabel, value: tx.step1 },
      {
        label: tx.domainLabel,
        value: domainName || <span className="text-muted-foreground">{tx.notEntered}</span>,
      },
      {
        label: tx.registrarSummaryLabel,
        value: registrar || <span className="text-muted-foreground">{tx.notSpecified}</span>,
      },
    ];

    return (
      <HostEntityFormLayout
        title={tx.title}
        subtitle={tx.subtitle}
        sections={sections}
        summaryTitle={tx.summarySetupTitle}
        summaryIcon={ExternalLink}
        summaryFields={summaryFields}
        onSubmit={handleReserve}
        isPending={addExternalDomain.isPending}
        submitText={tx.continue}
        submitVariant="default"
        showBackButton={false}
      />
    );
  }

  // ---- Step 2: Verify ownership -----------------------------------------
  if (step === 'verify' && verificationRecord) {
    const sections: HostFormSection[] = [
      {
        title: tx.sectionTxtRecord,
        icon: Shield,
        content: (
          <div className="space-y-4">
            <Alert>
              <Info className="h-4 w-4" />
              <AlertTitle>{tx.proveOwnershipTitle.replace('{domain}', domainName)}</AlertTitle>
              <AlertDescription>{tx.proveOwnershipDescription}</AlertDescription>
            </Alert>

            <div className="space-y-2">
              <CopyRow label={tx.nameLabel} value={verificationRecord.name} />
              <CopyRow label={tx.typeLabel} value={verificationRecord.type} />
              <CopyRow label={tx.valueLabel} value={verificationRecord.value} />
            </div>

            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{tx.propagationAlertTitle}</AlertTitle>
              <AlertDescription>{tx.propagationAlertDescription}</AlertDescription>
            </Alert>
          </div>
        ),
      },
    ];

    const summaryFields: HostSummaryField[] = [
      { label: tx.stepLabel, value: tx.step2 },
      { label: tx.domainLabel, value: domainName },
    ];

    return (
      <HostEntityFormLayout
        title={tx.verifyTitle}
        subtitle={tx.verifySubtitle}
        sections={sections}
        summaryTitle={tx.summaryVerificationTitle}
        summaryIcon={Shield}
        summaryFields={summaryFields}
        onSubmit={(e) => {
          e.preventDefault();
          handleVerify();
        }}
        isPending={verifyOwnership.isPending}
        submitText={
          verifyOwnership.isPending ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              {tx.verifying}
            </>
          ) : (
            tx.verifyButton
          )
        }
        submitVariant="default"
        showBackButton={false}
      />
    );
  }

  // ---- Step 3: Import existing DNS records ------------------------------
  if (step === 'import') {
    const allSelected =
      scannedRecords !== null &&
      scannedRecords.length > 0 &&
      selectedKeys.size === scannedRecords.length;
    const noneSelected = selectedKeys.size === 0;
    const scanning = scannedRecords === null || scanDnsRecords.isPending;

    const sections: HostFormSection[] = [
      {
        title: tx.sectionExistingRecords,
        icon: Database,
        content: (
          <div className="space-y-4">
            <Alert>
              <Info className="h-4 w-4" />
              <AlertTitle>{tx.migrateAlertTitle}</AlertTitle>
              <AlertDescription>
                {tx.migrateAlertDescription.replace('{domain}', domainName)}
              </AlertDescription>
            </Alert>

            {scanning && (
              <div className="flex items-center gap-2 p-4 border rounded-lg text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">{tx.scanning}</span>
              </div>
            )}

            {!scanning && scannedRecords && scannedRecords.length === 0 && (
              <div className="p-4 border rounded-lg text-center text-muted-foreground text-sm">
                {tx.noRecordsFound}
              </div>
            )}

            {!scanning && scannedRecords && scannedRecords.length > 0 && (
              <div className="border rounded-lg overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-2 border-b bg-muted/30 text-xs font-medium text-muted-foreground">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={toggleAll}
                    aria-label={tx.selectAll}
                  />
                  <div className="w-16">{tx.columnType}</div>
                  <div className="flex-1">{tx.columnName}</div>
                  <div className="flex-[2]">{tx.columnValue}</div>
                  <div className="w-16 text-right">{tx.columnTtl}</div>
                </div>
                <div className="divide-y">
                  {scannedRecords.map((r) => {
                    const key = recordKey(r);
                    const selected = selectedKeys.has(key);
                    return (
                      <label
                        key={key}
                        className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/20 cursor-pointer"
                      >
                        <Checkbox
                          checked={selected}
                          onCheckedChange={() => toggleRecord(key)}
                        />
                        <div className="w-16">
                          <Badge variant="outline" className="font-mono text-xs">
                            {r.type}
                          </Badge>
                        </div>
                        <div className="flex-1 font-mono text-xs truncate">{r.name}</div>
                        <div className="flex-[2] font-mono text-xs truncate text-muted-foreground">
                          {r.priority !== undefined ? `${r.priority} ` : ''}
                          {r.value}
                        </div>
                        <div className="w-16 text-right text-xs text-muted-foreground">
                          {r.ttl}s
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{tx.headsUpTitle}</AlertTitle>
              <AlertDescription>{tx.headsUpDescription}</AlertDescription>
            </Alert>
          </div>
        ),
      },
    ];

    const summaryFields: HostSummaryField[] = [
      { label: tx.stepLabel, value: tx.step3 },
      { label: tx.domainLabel, value: domainName },
      {
        label: tx.foundLabel,
        value: scanning
          ? tx.scanning
          : countText(scannedRecords?.length ?? 0, tx.recordCountSingular, tx.recordCountPlural),
      },
      {
        label: tx.selectedLabel,
        value: scanning ? '—' : `${selectedKeys.size}`,
      },
    ];

    const importingLabel = importDnsRecords.isPending ? (
      <>
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        {tx.importing}
      </>
    ) : noneSelected ? (
      tx.skipAndContinue
    ) : (
      countText(selectedKeys.size, tx.importButtonSingular, tx.importButtonPlural)
    );

    const summaryContent = (
      <div className="pt-4 border-t">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={handleSkipImport}
          disabled={importDnsRecords.isPending}
        >
          {tx.skipForNow}
        </Button>
      </div>
    );

    return (
      <HostEntityFormLayout
        title={tx.importTitle}
        subtitle={tx.importSubtitle}
        sections={sections}
        summaryTitle={tx.summaryImportTitle}
        summaryIcon={Database}
        summaryFields={summaryFields}
        summaryContent={summaryContent}
        onSubmit={(e) => {
          e.preventDefault();
          handleImport();
        }}
        isPending={importDnsRecords.isPending || scanning}
        submitText={importingLabel}
        submitVariant="default"
        showBackButton={false}
      />
    );
  }

  // ---- Step 4: Nameservers ----------------------------------------------
  const sections: HostFormSection[] = [
    {
      title: tx.sectionNameservers,
      icon: Server,
      content: (
        <div className="space-y-4">
          <Alert>
            <CheckCircle className="h-4 w-4 text-green-600" />
            <AlertTitle>{tx.zoneCreatedTitle}</AlertTitle>
            <AlertDescription>
              {tx.zoneCreatedDescription.replace('{domain}', domainName)}
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            {nameservers.map((ns, i) => (
              <CopyRow key={ns} label={`NS${i + 1}`} value={ns} />
            ))}
          </div>

          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>{tx.nextStepsTitle}</AlertTitle>
            <AlertDescription>
              <ul className="list-disc list-inside mt-2 space-y-1 text-sm">
                <li>{tx.nextStepLogin.replace('{registrar}', registrar || tx.registrarFallback)}</li>
                <li>{tx.nextStepReplace}</li>
                <li>{tx.nextStepPropagation}</li>
                <li>{tx.nextStepRecords}</li>
              </ul>
            </AlertDescription>
          </Alert>
        </div>
      ),
    },
  ];

  const summaryFields: HostSummaryField[] = [
    { label: tx.stepLabel, value: tx.step4 },
    { label: tx.domainLabel, value: domainName },
    {
      label: tx.verifiedLabel,
      value: (
        <div className="flex items-center gap-1 text-green-600">
          <CheckCircle className="h-3 w-3" />
          <span>{tx.yes}</span>
        </div>
      ),
    },
  ];

  return (
    <HostEntityFormLayout
      title={tx.nameserversTitle}
      subtitle={tx.nameserversSubtitle}
      sections={sections}
      summaryTitle={tx.summaryConnectedTitle}
      summaryIcon={ExternalLink}
      summaryFields={summaryFields}
      onSubmit={(e) => {
        e.preventDefault();
        handleFinish();
      }}
      submitText={tx.goToDomain}
      submitVariant="default"
      showBackButton={false}
    />
  );
}
