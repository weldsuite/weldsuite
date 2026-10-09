import { useMemo, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { FileCheck2, Loader2, Upload } from 'lucide-react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { MultiSelect, type MultiSelectOption } from '@weldsuite/ui/components/multi-select';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  useAccountingDocument,
  useCustomerInvoices,
} from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import { CERTIFICATE_FORMS, CERTIFICATE_REASONS } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { allUsStates } from '@/lib/weldbooks/us-sales-tax-states';
import { CustomerPicker } from '../setup/customer-picker';
import { Field, describedBy } from '../setup/field';
import { useSetupTexts } from '../setup/setup-texts';
import {
  FORM_STATUSES,
  applicableRuleHints,
  makeCertificateSchema,
  type CertificateFormValues,
} from './certificate-model';
import { useCertificateScanUpload } from './use-certificate-scan-upload';

export interface CertificateFormProps {
  mode: 'create' | 'edit';
  initial: CertificateFormValues;
  /** The customer can't change (editing, or adding from the customer's own page). */
  lockCustomer?: boolean;
  submitting: boolean;
  submitError?: string | null;
  onCancel: () => void;
  onSubmit: (values: CertificateFormValues) => void;
}

/** The exemption certificate form: add one for a customer, or edit what was recorded. */
export function CertificateForm({
  mode,
  initial,
  lockCustomer,
  submitting,
  submitError,
  onCancel,
  onSubmit,
}: Readonly<CertificateFormProps>) {
  const { t, format } = useSetupTexts();
  const tf = t.certificates.form;
  const { formatDate, formatMoney } = useWeldbooksFormat();
  const schema = useMemo(() => makeCertificateSchema(t.validation), [t.validation]);
  const form = useForm<CertificateFormValues>({ resolver: zodResolver(schema), defaultValues: initial });
  const values = form.watch();
  const errors = form.formState.errors;

  const scan = useCertificateScanUpload();
  const scanInput = useRef<HTMLInputElement>(null);
  const [scanName, setScanName] = useState<string | null>(null);
  const existingDocument = useAccountingDocument(values.documentId && !scanName ? values.documentId : null);
  const scanLabel = scanName ?? existingDocument.data?.fileName ?? tf.scan.onFile;
  const scanProblem = scan.problem ? tf.scan.problems[scan.problem] : null;

  const invoices = useCustomerInvoices(values.partyId, { enabled: !values.blanket });
  const stateOptions: MultiSelectOption[] = useMemo(
    () => allUsStates().map((s) => ({ value: s.code, label: `${s.name} (${s.code})` })),
    [],
  );

  // The state rules that decide validity when no expiry date is typed.
  const ruleHints = values.expiresOn
    ? []
    : applicableRuleHints(values.states, { reason: values.reason, form: values.form, blanket: values.blanket });

  const pickScan = async (file: File | undefined) => {
    if (!file) return;
    const uploaded = await scan.uploadScan(file);
    if (uploaded) {
      form.setValue('documentId', uploaded.documentId, { shouldDirty: true });
      setScanName(uploaded.fileName);
    }
    if (scanInput.current) scanInput.current.value = '';
  };

  const statuses = mode === 'edit' ? FORM_STATUSES : FORM_STATUSES.filter((s) => s !== 'revoked');

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-6">
      <Card>
        <CardContent className="space-y-5 pt-6">
          <Field label={tf.customer} htmlFor="certificate-customer" error={errors.partyId?.message}>
            <Controller
              control={form.control}
              name="partyId"
              render={({ field }) => (
                <CustomerPicker
                  id="certificate-customer"
                  value={field.value}
                  onChange={(partyId) => {
                    field.onChange(partyId);
                    form.setValue('invoiceId', '');
                  }}
                  placeholder={tf.customerPlaceholder}
                  searchPlaceholder={tf.customerSearch}
                  emptyText={tf.customerEmpty}
                  disabled={lockCustomer}
                  invalid={!!errors.partyId}
                />
              )}
            />
          </Field>

          <Field label={tf.states} htmlFor="certificate-states" help={tf.statesHelp} error={errors.states?.message}>
            <Controller
              control={form.control}
              name="states"
              render={({ field }) => (
                <MultiSelect
                  id="certificate-states"
                  options={stateOptions}
                  value={field.value}
                  onChange={field.onChange}
                  placeholder={tf.statesPlaceholder}
                  searchPlaceholder={tf.statesSearch}
                  emptyText={tf.statesEmpty}
                  aria-label={tf.states}
                />
              )}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tf.reason} htmlFor="certificate-reason">
              <Controller
                control={form.control}
                name="reason"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="certificate-reason" aria-label={tf.reason}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CERTIFICATE_REASONS.map((reason) => (
                        <SelectItem key={reason} value={reason}>
                          {t.certificates.reasons[reason]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Field label={tf.form} htmlFor="certificate-form">
              <Controller
                control={form.control}
                name="form"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="certificate-form" aria-label={tf.form}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CERTIFICATE_FORMS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {t.certificates.forms[kind]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={tf.number} htmlFor="certificate-number" error={errors.certificateNumber?.message}>
              <Input id="certificate-number" autoComplete="off" {...form.register('certificateNumber')} />
            </Field>
            <Field label={tf.issuedOn} htmlFor="certificate-issued" error={errors.issuedOn?.message}>
              <Input id="certificate-issued" type="date" {...form.register('issuedOn')} aria-invalid={!!errors.issuedOn} />
            </Field>
            <Field label={tf.expiresOn} htmlFor="certificate-expires" error={errors.expiresOn?.message}>
              <Input
                id="certificate-expires"
                type="date"
                {...form.register('expiresOn')}
                aria-invalid={!!errors.expiresOn}
                aria-describedby={describedBy('certificate-expires', { error: !!errors.expiresOn })}
              />
            </Field>
          </div>
          <p className="-mt-3 text-xs text-muted-foreground">{tf.expiresHelp}</p>
          {ruleHints.length > 0 ? (
            <ul className="-mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground" data-testid="rule-hints">
              {ruleHints.map(({ state, rule }) => (
                <li key={`${state}-${rule.expiry.kind}`}>
                  {format(tf.ruleHints[rule.expiry.kind], {
                    state,
                    months: 'months' in rule.expiry ? rule.expiry.months : '',
                  })}
                </li>
              ))}
            </ul>
          ) : null}

          <Field label={tf.coverage} htmlFor="certificate-coverage">
            <Controller
              control={form.control}
              name="blanket"
              render={({ field }) => (
                <RadioGroup
                  id="certificate-coverage"
                  value={field.value ? 'blanket' : 'single'}
                  onValueChange={(value) => field.onChange(value === 'blanket')}
                  className="gap-2"
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="blanket" id="certificate-coverage-blanket" />
                    <Label htmlFor="certificate-coverage-blanket" className="font-normal">
                      {tf.blanket}
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="single" id="certificate-coverage-single" />
                    <Label htmlFor="certificate-coverage-single" className="font-normal">
                      {tf.single}
                    </Label>
                  </div>
                </RadioGroup>
              )}
            />
          </Field>

          {!values.blanket ? (
            <Field label={tf.invoice} htmlFor="certificate-invoice" help={tf.invoiceHelp} error={errors.invoiceId?.message}>
              <Controller
                control={form.control}
                name="invoiceId"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange} disabled={!values.partyId}>
                    <SelectTrigger id="certificate-invoice" aria-label={tf.invoice} aria-invalid={!!errors.invoiceId}>
                      <SelectValue placeholder={invoices.data && invoices.data.length === 0 ? tf.invoiceEmpty : tf.invoicePlaceholder} />
                    </SelectTrigger>
                    <SelectContent>
                      {(invoices.data ?? []).map((invoice) => (
                        <SelectItem key={invoice.id} value={invoice.id}>
                          {invoice.invoiceNumber ?? invoice.id} · {formatDate(invoice.issueDate)}
                          {invoice.total ? ` · ${formatMoney(invoice.total)}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tf.receivedOn} htmlFor="certificate-received" error={errors.receivedOn?.message}>
              <Input id="certificate-received" type="date" {...form.register('receivedOn')} />
            </Field>
            <Field label={tf.status} htmlFor="certificate-status" help={tf.statusHelp}>
              <Controller
                control={form.control}
                name="status"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="certificate-status" aria-label={tf.status}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {statuses.map((status) => (
                        <SelectItem key={status} value={status}>
                          {t.certificates.statuses[status]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="certificate-scan">{tf.scan.label}</Label>
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={scanInput}
                id="certificate-scan"
                type="file"
                className="sr-only"
                accept="application/pdf,image/jpeg,image/png,image/webp"
                onChange={(event) => void pickScan(event.target.files?.[0])}
              />
              <Button type="button" variant="outline" size="sm" disabled={scan.isUploading} onClick={() => scanInput.current?.click()}>
                {scan.isUploading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : <Upload className="mr-1 h-4 w-4" aria-hidden />}
                {scan.isUploading ? tf.scan.uploading : values.documentId ? tf.scan.replace : tf.scan.upload}
              </Button>
              {values.documentId ? (
                <span className="flex items-center gap-1 text-sm text-muted-foreground" data-testid="certificate-scan-status">
                  <FileCheck2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
                  {scanLabel}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      form.setValue('documentId', '', { shouldDirty: true });
                      setScanName(null);
                    }}
                  >
                    {tf.scan.remove}
                  </Button>
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">{tf.scan.help}</p>
            {scanProblem ? (
              <p className="text-sm text-destructive" role="alert">
                {scanProblem}
              </p>
            ) : null}
          </div>

          <Field label={tf.notes} htmlFor="certificate-notes" error={errors.notes?.message}>
            <Textarea id="certificate-notes" rows={3} {...form.register('notes')} />
          </Field>

          {submitError ? (
            <Alert variant="destructive">
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={submitting || scan.isUploading}>
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
              {mode === 'create' ? tf.submitCreate : tf.submitUpdate}
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
