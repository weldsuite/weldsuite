import { useRef, useState } from 'react';
import { Controller, useFormContext } from 'react-hook-form';
import { FileCheck2, Loader2, Upload } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useRevealTin } from '@/hooks/queries/use-weldbooks-1099-queries';
import type { TinMatchStatus, VendorTaxView } from '@/lib/api/domains/weldbooks-1099';
import { useI18n } from '@/lib/i18n/provider';
import { VENDOR_TIN_TYPES, formatTinInput, maskedTin, tinPlaceholder, type VendorTinType } from '@/lib/weldbooks/vendor-tin';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { RevealSecret } from './reveal-secret';
import { SecretInput } from './secret-input';
import { TaxIdRevealLog } from './tax-id-reveal-log';
import { useW9ScanUpload } from './use-w9-scan-upload';
import { W9RequestDialog } from './w9-request-dialog';
import {
  LLC_CLASSIFICATIONS,
  W9_CLASSIFICATIONS,
  boxMatchesForm,
  defaultBoxOptions,
  type VendorTaxFormValues,
} from './vendor-tax-model';

/** The part of the contact form's values these sections read and write. */
export interface VendorTaxFormShape {
  role: string;
  email?: string;
  vendorTax: VendorTaxFormValues;
}

const NONE = '__none__';

const MATCH_VARIANT: Record<TinMatchStatus, 'success' | 'destructive' | 'secondary'> = {
  match: 'success',
  mismatch: 'destructive',
  not_issued: 'destructive',
  invalid: 'destructive',
  pending: 'secondary',
};

interface VendorTaxSectionProps {
  /** The contact being edited; undefined on create. */
  contact?: VendorTaxView & { id: string };
}

/**
 * "Tax reporting" card of the vendor form: 1099 reporting and its defaults, the
 * TIN (write-only, masked, revealed on request), the W-9 and its scan, backup
 * withholding and consent to electronic delivery.
 */
export function VendorTaxSection({ contact }: Readonly<VendorTaxSectionProps>) {
  const { t } = useI18n();
  const tv = t.weldbooksUs.form1099.vendorTax;
  const { can } = usePermissions();
  const { formatDate } = useWeldbooksFormat();
  const form = useFormContext<VendorTaxFormShape>();
  const values = form.watch('vendorTax');
  const errors = form.formState.errors.vendorTax;
  const set = <K extends keyof VendorTaxFormValues>(key: K, value: VendorTaxFormValues[K]) =>
    // Validate while typing only once a submit has failed: a half-typed TIN is not an error yet.
    form.setValue(`vendorTax.${key}`, value as never, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });

  const contactId = contact?.id ?? '';
  const revealTin = useRevealTin(contactId);
  const scan = useW9ScanUpload();
  const scanInput = useRef<HTMLInputElement>(null);
  const [replacingTin, setReplacingTin] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [scanName, setScanName] = useState<string | null>(null);

  const hasStoredTin = Boolean(contact?.hasTin);
  const showTinInput = !hasStoredTin || replacingTin;
  const canReveal = can('tax_ids:reveal');
  const canRequest = Boolean(contact) && (can('suppliers:update') || can('taxes:create'));
  const boxes = defaultBoxOptions(values.default1099Form);
  const w9 = contact?.w9 ?? null;
  const matchStatus = contact?.tinMatchStatus ?? null;

  const changeForm = (next: string) => {
    const form1099 = next === NONE ? '' : (next as 'nec' | 'misc');
    set('default1099Form', form1099);
    // A box of the other form no longer applies.
    if (!boxMatchesForm(values.default1099Box, form1099)) set('default1099Box', '');
  };

  const pickScan = async (file: File | undefined) => {
    if (!file) return;
    const uploaded = await scan.uploadScan(file);
    if (uploaded) {
      set('w9DocumentId', uploaded.documentId);
      setScanName(uploaded.fileName);
    }
    if (scanInput.current) scanInput.current.value = '';
  };

  const scanProblem = scan.problem ? tv.scan.problems[scan.problem] : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tv.title}</CardTitle>
        <CardDescription>{tv.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 1099 reporting */}
        <div className="space-y-4">
          <Controller
            control={form.control}
            name="vendorTax.is1099Vendor"
            render={({ field }) => (
              <label className="flex items-start gap-2 text-sm" htmlFor="vendorTax-is1099Vendor">
                <Checkbox
                  id="vendorTax-is1099Vendor"
                  checked={field.value}
                  onCheckedChange={(checked) => field.onChange(checked === true)}
                />
                <span>
                  <span className="font-medium">{tv.is1099Vendor}</span>
                  <span className="block text-xs text-muted-foreground">{tv.is1099VendorHelp}</span>
                </span>
              </label>
            )}
          />
          {values.is1099Vendor ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="vendorTax-default1099Form">{tv.defaultForm}</Label>
                <Select value={values.default1099Form || NONE} onValueChange={changeForm}>
                  <SelectTrigger id="vendorTax-default1099Form">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{tv.notSet}</SelectItem>
                    <SelectItem value="nec">{t.weldbooksUs.form1099.forms.nec}</SelectItem>
                    <SelectItem value="misc">{t.weldbooksUs.form1099.forms.misc}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="vendorTax-default1099Box">{tv.defaultBox}</Label>
                <Select
                  value={values.default1099Box || NONE}
                  onValueChange={(next) => set('default1099Box', next === NONE ? '' : next)}
                >
                  <SelectTrigger id="vendorTax-default1099Box">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{tv.notSet}</SelectItem>
                    {boxes.map((box) => (
                      <SelectItem key={box.code} value={box.code}>
                        {box.form
                          ? `${box.form === 'nec' ? 'NEC' : 'MISC'} ${box.number}: ${box.label}`
                          : tv.omitBox}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{tv.defaultBoxHelp}</p>
              </div>
            </div>
          ) : null}
        </div>

        {/* TIN */}
        <div className="space-y-3">
          <h3 className="text-sm font-medium">{tv.tin.heading}</h3>
          {hasStoredTin && !showTinInput && !values.removeTin ? (
            <div className="space-y-2" data-testid="tin-stored">
              <RevealSecret
                masked={maskedTin(contact?.tinType ?? null, contact?.tinLast4 ?? null)}
                canReveal={canReveal}
                reveal={async () => (await revealTin.run()).tin}
                labels={{
                  reveal: tv.tin.reveal,
                  hide: tv.tin.hide,
                  hidesIn: tv.tin.hidesIn,
                  failed: tv.tin.revealFailed,
                  valueLabel: tv.tin.valueLabel,
                }}
                testId="tin-value"
              />
              <div className="flex flex-wrap items-center gap-2">
                {contact?.tinType ? <Badge variant="outline">{tv.tin.types[contact.tinType]}</Badge> : null}
                {matchStatus ? (
                  <Badge variant={MATCH_VARIANT[matchStatus]}>
                    {t.weldbooksUs.form1099.tinMatch.status[matchStatus]}
                    {contact?.tinMatchedAt ? ` · ${formatDate(contact.tinMatchedAt)}` : ''}
                  </Badge>
                ) : null}
                <Button type="button" variant="outline" size="sm" onClick={() => setReplacingTin(true)}>
                  {tv.tin.replace}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => set('removeTin', true)}>
                  {tv.tin.remove}
                </Button>
                {canReveal ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setLogOpen(true)}>
                    {tv.tin.revealHistory}
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">{tv.tin.storedHelp}</p>
            </div>
          ) : null}

          {values.removeTin ? (
            <div className="flex flex-wrap items-center gap-2 text-sm" role="status">
              <span>{tv.tin.willRemove}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => set('removeTin', false)}>
                {tv.tin.undoRemove}
              </Button>
            </div>
          ) : null}

          {showTinInput && !values.removeTin ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="vendorTax-tinType">{tv.tin.type}</Label>
                <Select
                  value={values.tinType || NONE}
                  onValueChange={(next) => {
                    const type = next === NONE ? '' : (next as VendorTinType);
                    set('tinType', type);
                    if (type && values.tin) set('tin', formatTinInput(type, values.tin));
                  }}
                >
                  <SelectTrigger id="vendorTax-tinType" aria-invalid={Boolean(errors?.tinType)}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{tv.notSet}</SelectItem>
                    {VENDOR_TIN_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {tv.tin.types[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors?.tinType ? <p className="text-sm text-destructive">{errors.tinType.message}</p> : null}
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="vendorTax-tin">{hasStoredTin ? tv.tin.newValue : tv.tin.value}</Label>
                <SecretInput
                  id="vendorTax-tin"
                  value={values.tin}
                  placeholder={tinPlaceholder(values.tinType)}
                  showLabel={tv.tin.showTyped}
                  hideLabel={tv.tin.hideTyped}
                  aria-describedby="vendorTax-tin-help"
                  aria-invalid={Boolean(errors?.tin)}
                  onChange={(next) => set('tin', values.tinType ? formatTinInput(values.tinType, next) : next)}
                />
                <p id="vendorTax-tin-help" className="text-xs text-muted-foreground">
                  {tv.tin.inputHelp}
                </p>
                {errors?.tin ? <p className="text-sm text-destructive">{errors.tin.message}</p> : null}
              </div>
              {hasStoredTin ? (
                <div className="sm:col-span-3">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      set('tin', '');
                      setReplacingTin(false);
                    }}
                  >
                    {tv.tin.keepCurrent}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {values.is1099Vendor && !hasStoredTin && !values.tin ? (
            <p className="text-xs text-amber-600 dark:text-amber-400" role="note">
              {tv.tin.missingWarning}
            </p>
          ) : null}
        </div>

        {/* W-9 */}
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{tv.w9.heading}</h3>
            {canRequest ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setRequestOpen(true)}>
                {tv.w9.requestOnline}
              </Button>
            ) : contact ? null : (
              <span className="text-xs text-muted-foreground">{tv.w9.saveFirst}</span>
            )}
          </div>

          {w9?.source === 'online' ? (
            <p className="text-xs text-muted-foreground" role="note">
              {tv.w9.completedOnline
                .replace('{name}', w9.signedName ?? '')
                .replace('{date}', w9.receivedAt ? formatDate(w9.receivedAt) : '')}
            </p>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="vendorTax-w9LegalName">{tv.w9.legalName}</Label>
              <Input id="vendorTax-w9LegalName" maxLength={100} autoComplete="off" {...form.register('vendorTax.w9LegalName')} />
              <p className="text-xs text-muted-foreground">{tv.w9.legalNameHelp}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="vendorTax-w9BusinessName">{tv.w9.businessName}</Label>
              <Input id="vendorTax-w9BusinessName" maxLength={100} autoComplete="off" {...form.register('vendorTax.w9BusinessName')} />
              <p className="text-xs text-muted-foreground">{tv.w9.businessNameHelp}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="vendorTax-w9Classification">{tv.w9.classification}</Label>
              <Select
                value={values.w9Classification || NONE}
                onValueChange={(next) => set('w9Classification', next === NONE ? '' : (next as VendorTaxFormValues['w9Classification']))}
              >
                <SelectTrigger id="vendorTax-w9Classification">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{tv.notSet}</SelectItem>
                  {W9_CLASSIFICATIONS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t.weldbooksUs.form1099.classifications[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {values.w9Classification === 'llc' ? (
              <div className="space-y-2">
                <Label htmlFor="vendorTax-w9LlcClassification">{tv.w9.llcClassification} *</Label>
                <Select
                  value={values.w9LlcClassification || NONE}
                  onValueChange={(next) => set('w9LlcClassification', next === NONE ? '' : (next as 'C' | 'S' | 'P'))}
                >
                  <SelectTrigger id="vendorTax-w9LlcClassification" aria-invalid={Boolean(errors?.w9LlcClassification)}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{tv.notSet}</SelectItem>
                    {LLC_CLASSIFICATIONS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t.weldbooksUs.form1099.llcClassifications[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors?.w9LlcClassification ? (
                  <p className="text-sm text-destructive">{errors.w9LlcClassification.message}</p>
                ) : null}
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="vendorTax-w9ExemptPayeeCode">{tv.w9.exemptPayeeCode}</Label>
              <Input id="vendorTax-w9ExemptPayeeCode" maxLength={2} className="uppercase" autoComplete="off" {...form.register('vendorTax.w9ExemptPayeeCode')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="vendorTax-w9FatcaCode">{tv.w9.fatcaCode}</Label>
              <Input id="vendorTax-w9FatcaCode" maxLength={2} className="uppercase" autoComplete="off" {...form.register('vendorTax.w9FatcaCode')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="vendorTax-w9ReceivedAt">{tv.w9.receivedAt}</Label>
              <Input id="vendorTax-w9ReceivedAt" type="date" {...form.register('vendorTax.w9ReceivedAt')} />
            </div>
          </div>

          <Controller
            control={form.control}
            name="vendorTax.w9IsAttorney"
            render={({ field }) => (
              <label className="flex items-start gap-2 text-sm" htmlFor="vendorTax-w9IsAttorney">
                <Checkbox id="vendorTax-w9IsAttorney" checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />
                <span>
                  <span className="font-medium">{tv.w9.isAttorney}</span>
                  <span className="block text-xs text-muted-foreground">{tv.w9.isAttorneyHelp}</span>
                </span>
              </label>
            )}
          />

          <div className="space-y-2">
            <Label htmlFor="vendorTax-w9Scan">{tv.scan.label}</Label>
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={scanInput}
                id="vendorTax-w9Scan"
                type="file"
                className="sr-only"
                accept="application/pdf,image/jpeg,image/png,image/webp"
                onChange={(event) => void pickScan(event.target.files?.[0])}
              />
              <Button type="button" variant="outline" size="sm" disabled={scan.isUploading} onClick={() => scanInput.current?.click()}>
                {scan.isUploading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : <Upload className="mr-1 h-4 w-4" aria-hidden />}
                {values.w9DocumentId ? tv.scan.replace : tv.scan.upload}
              </Button>
              {values.w9DocumentId ? (
                <span className="flex items-center gap-1 text-sm text-muted-foreground" data-testid="w9-scan-status">
                  <FileCheck2 className="h-4 w-4 text-emerald-600" aria-hidden />
                  {scanName ?? tv.scan.onFile}
                  <Button type="button" variant="ghost" size="sm" onClick={() => { set('w9DocumentId', ''); setScanName(null); }}>
                    {tv.scan.remove}
                  </Button>
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">{tv.scan.help}</p>
            {scanProblem ? (
              <p className="text-sm text-destructive" role="alert">
                {scanProblem}
              </p>
            ) : null}
          </div>
        </div>

        {/* Withholding and delivery */}
        <div className="space-y-4">
          <Controller
            control={form.control}
            name="vendorTax.backupWithholding"
            render={({ field }) => (
              <label className="flex items-start gap-2 text-sm" htmlFor="vendorTax-backupWithholding">
                <Checkbox id="vendorTax-backupWithholding" checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />
                <span>
                  <span className="font-medium">{tv.backupWithholding}</span>
                  <span className="block text-xs text-muted-foreground">{tv.backupWithholdingHelp}</span>
                </span>
              </label>
            )}
          />
          <Controller
            control={form.control}
            name="vendorTax.eDeliveryConsent"
            render={({ field }) => (
              <label className="flex items-start gap-2 text-sm" htmlFor="vendorTax-eDeliveryConsent">
                <Checkbox id="vendorTax-eDeliveryConsent" checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />
                <span>
                  <span className="font-medium">{tv.eDelivery}</span>
                  <span className="block text-xs text-muted-foreground">
                    {tv.eDeliveryHelp}
                    {contact?.form1099EDeliveryConsentAt
                      ? ` ${tv.eDeliveryOn.replace('{date}', formatDate(contact.form1099EDeliveryConsentAt))}`
                      : ''}
                  </span>
                </span>
              </label>
            )}
          />
        </div>
      </CardContent>

      {contact ? (
        <>
          <W9RequestDialog
            open={requestOpen}
            onOpenChange={setRequestOpen}
            partyId={contact.id}
            defaultEmail={form.getValues('email') ?? null}
          />
          <TaxIdRevealLog open={logOpen} onOpenChange={setLogOpen} partyId={contact.id} />
        </>
      ) : null}
    </Card>
  );
}
