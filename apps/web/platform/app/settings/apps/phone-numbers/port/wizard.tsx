import { useState, useMemo } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Link, useRouter } from '@tanstack/react-router';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Loader2, ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Upload, CheckCircle2, AlertTriangle, Hash, User, FileText, FileSignature, Receipt, type LucideIcon } from 'lucide-react';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { toast } from 'sonner';
import {
  usePreflightCheck,
  useCreatePortingOrder,
  useUpdatePortingOrder,
  useUploadPortDoc,
  useSubmitPortingOrder,
  useDownloadLoaTemplate,
  type PortingOrder,
  type ServiceAddress,
} from '@/hooks/use-porting';
import { getTranslations } from '@/lib/i18n';

type WizardStep = 'number' | 'details' | 'documents' | 'review' | 'done';

function getCountryOptions(st: ReturnType<typeof useTranslations>): Array<{ value: string; label: string }> {
  return [
    { value: 'US', label: st('sweep.settings.portingWizard.countries.us') },
    { value: 'CA', label: st('sweep.settings.portingWizard.countries.ca') },
    { value: 'GB', label: st('sweep.settings.portingWizard.countries.gb') },
    { value: 'NL', label: st('sweep.settings.portingWizard.countries.nl') },
    { value: 'BE', label: st('sweep.settings.portingWizard.countries.be') },
    { value: 'DE', label: st('sweep.settings.portingWizard.countries.de') },
    { value: 'FR', label: st('sweep.settings.portingWizard.countries.fr') },
  ];
}

export function PortNumberWizard() {
  const t = getTranslations('porting');
  const st = useTranslations();
  const COUNTRY_OPTIONS = useMemo(() => getCountryOptions(st), [st]);
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>('number');

  // Step-1 state
  const [phoneNumber, setPhoneNumber] = useState('');
  const [countryCode, setCountryCode] = useState('US');
  const [numberType, setNumberType] = useState<'local' | 'mobile'>('local');
  const [preflightReasons, setPreflightReasons] = useState<string[] | null>(null);

  // Step-2+ state — bound to a server-side draft
  const [draft, setDraft] = useState<PortingOrder | null>(null);
  const [authorizedName, setAuthorizedName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [address, setAddress] = useState<ServiceAddress>({
    line1: '',
    city: '',
    region: '',
    postalCode: '',
    country: countryCode,
  });
  const [currentCarrier, setCurrentCarrier] = useState('');
  const [currentAccountNumber, setCurrentAccountNumber] = useState('');
  const [currentPin, setCurrentPin] = useState('');

  const [loaUploaded, setLoaUploaded] = useState(false);
  const [billUploaded, setBillUploaded] = useState(false);

  // Mutations
  const preflight = usePreflightCheck();
  const createOrder = useCreatePortingOrder();
  const updateOrder = useUpdatePortingOrder(draft?.id);
  const uploadLoa = useUploadPortDoc(draft?.id, 'loa');
  const uploadBill = useUploadPortDoc(draft?.id, 'bill');
  const submit = useSubmitPortingOrder(draft?.id);
  const downloadLoaTemplate = useDownloadLoaTemplate(draft?.id);

  // ── Step 1: phone number + preflight ──────────────────────────────────
  const handlePreflight = async () => {
    setPreflightReasons(null);
    try {
      const result = await preflight.mutateAsync({ phoneNumber, countryCode });
      if (!result.portable) {
        setPreflightReasons(result.reasons.length ? result.reasons : [st('sweep.settings.portingWizard.notPortableReason')]);
        return;
      }
      // Create draft right away so subsequent edits PATCH a real order.
      const order = await createOrder.mutateAsync({
        phoneNumber,
        countryCode,
        numberType,
      });
      if (!order) throw new Error(st('sweep.settings.portingWizard.createDraftFailed'));
      setDraft(order);
      setAddress((a) => ({ ...a, country: countryCode }));
      setStep('details');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : st('sweep.settings.portingWizard.preflightFailed'));
    }
  };

  // ── Step 2: customer details ──────────────────────────────────────────
  const handleSaveDetails = async () => {
    if (!draft) return;
    if (!authorizedName || !businessName || !currentCarrier || !currentAccountNumber) {
      toast.error(st('sweep.settings.portingWizard.fillRequiredFields'));
      return;
    }
    try {
      await updateOrder.mutateAsync({
        authorizedName,
        businessName,
        serviceAddress: address,
        currentCarrier,
        currentAccountNumber,
        currentPin: currentPin || null,
      });
      setStep('documents');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : st('sweep.settings.portingWizard.saveDetailsFailed'));
    }
  };

  // ── Step 3: docs ──────────────────────────────────────────────────────
  const handleDownloadLoaTemplate = async () => {
    if (!draft) {
      toast.error(st('sweep.settings.portingWizard.completePreviousSteps'));
      return;
    }
    try {
      const blob = await downloadLoaTemplate.mutateAsync();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `LOA-${draft.id}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : st('sweep.settings.portingWizard.fetchTemplateFailed'));
    }
  };

  const handleUpload = async (file: File, kind: 'loa' | 'bill') => {
    try {
      if (kind === 'loa') {
        await uploadLoa.mutateAsync(file);
        setLoaUploaded(true);
      } else {
        await uploadBill.mutateAsync(file);
        setBillUploaded(true);
      }
      toast.success(kind === 'loa' ? st('sweep.settings.portingWizard.loaUploaded') : st('sweep.settings.portingWizard.billUploaded'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : st('sweep.settings.portingWizard.uploadFailed'));
    }
  };

  // ── Step 4: submit ────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!draft) return;
    try {
      const result = await submit.mutateAsync();
      if (result.requiresCheckout && result.checkoutUrl) {
        window.location.href = result.checkoutUrl;
        return;
      }
      setStep('done');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : st('sweep.settings.portingWizard.submissionFailed'));
    }
  };

  // ── UI ────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <Link
        to="/settings/apps/phone-numbers"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-8"
      >
        <ChevronLeft className="h-4 w-4 mr-1" />
        {t.backToNumbers}
      </Link>

      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t.title}</h1>
        <p className="text-sm text-muted-foreground">{t.subtitle}</p>
      </div>

      <StepIndicator current={step} />

      {step === 'number' && (
        <Card className="border-0 shadow-none bg-transparent py-0 gap-0">
          <CardHeader className="px-0">
            <CardTitle>{t.step1Title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 px-0 pt-4">
            <div className="grid gap-2">
              <Label htmlFor="phoneNumber">{t.phoneNumberLabel}</Label>
              <Input
                id="phoneNumber"
                placeholder="+14155551234"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t.phoneNumberHint}</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>{t.countryLabel}</Label>
                <Select value={countryCode} onValueChange={setCountryCode}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COUNTRY_OPTIONS.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>{t.numberTypeLabel}</Label>
                <Select value={numberType} onValueChange={(v) => setNumberType(v as 'local' | 'mobile')}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">{t.typeLocal}</SelectItem>
                    <SelectItem value="mobile">{t.typeMobile}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {preflightReasons && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{t.notPortable}</AlertTitle>
                <AlertDescription>
                  <ul className="list-inside list-disc space-y-1">
                    {preflightReasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                onClick={handlePreflight}
                disabled={preflight.isPending || createOrder.isPending || !phoneNumber}
                className="inline-flex items-center justify-center gap-1.5 h-[36px] pl-3.5 pr-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none transition-colors"
              >
                {(preflight.isPending || createOrder.isPending) && <Loader2 className="h-4 w-4 animate-spin" />}
                {t.checkAndContinue}
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'details' && (
        <Card className="border-0 shadow-none bg-transparent py-0 gap-0">
          <CardHeader className="px-0">
            <CardTitle>{t.step2Title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 px-0 pt-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>{t.authorizedName} *</Label>
                <Input value={authorizedName} onChange={(e) => setAuthorizedName(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label>{t.businessName} *</Label>
                <Input value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
              </div>
            </div>

            <div className="grid gap-2">
              <Label>{t.addressLine1} *</Label>
              <Input value={address.line1} onChange={(e) => setAddress({ ...address, line1: e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label>{t.addressLine2}</Label>
              <Input value={address.line2 ?? ''} onChange={(e) => setAddress({ ...address, line2: e.target.value })} />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="grid gap-2">
                <Label>{t.city} *</Label>
                <Input value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>{t.region} *</Label>
                <Input value={address.region} onChange={(e) => setAddress({ ...address, region: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>{t.postalCode} *</Label>
                <Input value={address.postalCode} onChange={(e) => setAddress({ ...address, postalCode: e.target.value })} />
              </div>
            </div>

            <div className="border-t mt-8 pt-8">
              <h3 className="text-sm font-medium mb-4">{t.currentCarrierSection}</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label>{t.currentCarrier} *</Label>
                  <Input
                    value={currentCarrier}
                    placeholder="KPN, Vodafone, Verizon..."
                    onChange={(e) => setCurrentCarrier(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label>{t.currentAccountNumber} *</Label>
                  <Input value={currentAccountNumber} onChange={(e) => setCurrentAccountNumber(e.target.value)} />
                </div>
              </div>
              <div className="mt-4 grid gap-2">
                <Label>{t.currentPin}</Label>
                <Input
                  value={currentPin}
                  placeholder={t.pinHint}
                  onChange={(e) => setCurrentPin(e.target.value)}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep('number')}
                className="inline-flex items-center justify-center h-[36px] px-3.5 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors"
              >
                {t.back}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={handleSaveDetails}
                disabled={updateOrder.isPending}
                className="inline-flex items-center justify-center gap-1.5 h-[36px] pl-3.5 pr-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none transition-colors"
              >
                {updateOrder.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t.continue}
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'documents' && (
        <Card className="border-0 shadow-none bg-transparent py-0 gap-0">
          <CardHeader className="px-0">
            <CardTitle>{t.step3Title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6 px-0 pt-4">
            <div className="space-y-2">
              <p className="text-sm">{t.docsExplain}</p>
              <Button variant="outline" onClick={handleDownloadLoaTemplate}>
                {t.downloadLoaTemplate}
              </Button>
            </div>

            <div className="space-y-2">
              <DocUploadRow
                label={t.uploadSignedLoa}
                icon={FileSignature}
                uploaded={loaUploaded}
                onUpload={(f) => handleUpload(f, 'loa')}
                busy={uploadLoa.isPending}
              />
              <DocUploadRow
                label={t.uploadBillCopy}
                icon={Receipt}
                uploaded={billUploaded}
                onUpload={(f) => handleUpload(f, 'bill')}
                busy={uploadBill.isPending}
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep('details')}
                className="inline-flex items-center justify-center h-[36px] px-3.5 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors"
              >
                {t.back}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep('review')}
                disabled={!loaUploaded || !billUploaded}
                className="inline-flex items-center justify-center gap-1.5 h-[36px] pl-3.5 pr-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none transition-colors"
              >
                {t.continue}
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'review' && draft && (
        <Card>
          <CardHeader>
            <CardTitle>{t.step4Title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ReviewRow label={t.phoneNumberLabel} value={phoneNumber} />
            <ReviewRow label={t.countryLabel} value={countryCode} />
            <ReviewRow label={t.numberTypeLabel} value={numberType} />
            <ReviewRow label={t.authorizedName} value={authorizedName} />
            <ReviewRow label={t.businessName} value={businessName} />
            <ReviewRow
              label={t.addressLine1}
              value={[address.line1, address.line2, address.city, address.region, address.postalCode, address.country]
                .filter(Boolean)
                .join(', ')}
            />
            <ReviewRow label={t.currentCarrier} value={currentCarrier} />
            <ReviewRow label={t.currentAccountNumber} value={currentAccountNumber} />

            <Alert>
              <AlertTitle>{t.beforeYouSubmit}</AlertTitle>
              <AlertDescription>{t.submitWarning}</AlertDescription>
            </Alert>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep('documents')}>
                <ArrowLeft className="mr-2 h-4 w-4" /> {t.back}
              </Button>
              <Button onClick={handleSubmit} disabled={submit.isPending}>
                {submit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t.submitPort}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'done' && draft && (
        <Card>
          <CardContent className="py-8 text-center space-y-4">
            <CheckCircle2 className="mx-auto h-12 w-12 text-green-500" />
            <h2 className="text-xl font-semibold">{t.doneTitle}</h2>
            <p className="text-sm text-muted-foreground">{t.doneBody}</p>
            <div className="flex justify-center gap-3 pt-4">
              <Button variant="outline" asChild>
                <Link to="/settings/apps/phone-numbers">{t.backToNumbers}</Link>
              </Button>
              <Button
                onClick={() => router.navigate({ to: '/settings/apps/phone-numbers/port/$id', params: { id: draft.id } })}
              >
                {t.viewStatus}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: WizardStep }) {
  const st = useTranslations();
  const tabs: PageTab[] = [
    { id: 'number', label: st('sweep.settings.portingWizard.stepNumber'), icon: Hash },
    { id: 'details', label: st('sweep.settings.portingWizard.stepDetails'), icon: User },
    { id: 'documents', label: st('sweep.settings.portingWizard.stepDocuments'), icon: FileText },
    { id: 'review', label: st('sweep.settings.portingWizard.stepReview'), icon: CheckCircle2 },
  ];
  return <PageTabs tabs={tabs} activeTab={current} />;
}

function DocUploadRow({
  label,
  icon: Icon,
  uploaded,
  onUpload,
  busy,
}: {
  label: string;
  icon: LucideIcon;
  uploaded: boolean;
  onUpload: (file: File) => void;
  busy: boolean;
}) {
  const st = useTranslations();
  return (
    <div className="flex items-center justify-between rounded-lg border pl-[18px] pr-3 py-3">
      <div className="flex items-center gap-2">
        {uploaded ? (
          <CheckCircle2 className="h-4 w-4 text-green-500" />
        ) : (
          <Icon className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="text-sm">{label}</span>
      </div>
      <label>
        <input
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
          }}
        />
        <Button asChild variant="outline" size="sm" disabled={busy}>
          <span>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : uploaded ? st('sweep.settings.portingWizard.replace') : st('sweep.settings.portingWizard.uploadPdf')}</span>
        </Button>
      </label>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-3 gap-4 border-b py-2 last:border-b-0">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="col-span-2 text-sm">{value || '—'}</div>
    </div>
  );
}
