import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { getCheckLayout } from '@/lib/weldbooks/check-layout';
import { renderAlignmentTestPdf } from '@/lib/weldbooks/check-pdf';
import { downloadBlob } from '@/lib/weldbooks/download';
import { pdfBlob, printPdfBytes } from '@/lib/weldbooks/print-pdf';
import type { UsBankAccount } from '@/lib/api/domains/weldbooks-banking';
import { useBankAccounts } from '@/hooks/queries/use-weldbooks-banking-queries';
import { usePaymentSettings, useUpdatePaymentSettings } from '@/hooks/queries/use-weldbooks-payment-runs-queries';
import type { BankPaymentSettings } from '@/lib/api/domains/weldbooks-payment-runs';
import { PaymentRunsFrame } from '../../components/payment-runs-frame';
import { useCheckPdfLabels } from '../../components/use-check-pdf-labels';
import { isPaymentBankAccount } from '../../new/new-run-model';
import { describeRunError } from '../../run-errors';
import { AchSection, CheckSection, PositivePaySection, ReadinessCard } from '../settings-sections';
import {
  alignmentOf,
  createSettingsSchema,
  toFormValues,
  toUpdateInput,
  type SettingsFormValues,
} from '../settings-model';

interface SettingsFormProps {
  settings: BankPaymentSettings;
  accounts: readonly UsBankAccount[];
  canEdit: boolean;
}

/**
 * The form itself. It only mounts once the settings are loaded, so every
 * field starts with its stored value: selects that first see an empty value
 * and then a real one report the empty one back to the form.
 */
function SettingsForm({ settings, accounts, canEdit }: Readonly<SettingsFormProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const ts = tp.settings;
  const labels = useCheckPdfLabels();
  const update = useUpdatePaymentSettings();
  const [printing, setPrinting] = useState(false);

  const schema = useMemo(() => createSettingsSchema(ts.validation), [ts.validation]);
  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(schema),
    defaultValues: toFormValues(settings),
  });
  const { handleSubmit, reset, getValues, formState } = form;

  // After a save the server's view becomes the new starting point (the typed EIN is dropped).
  useEffect(() => {
    reset(toFormValues(settings));
  }, [settings, reset]);

  const onSubmit = (values: SettingsFormValues) => {
    const input = toUpdateInput(values, settings);
    if (Object.keys(input).length === 0) {
      toast.info(ts.nothingChanged);
      return;
    }
    update.mutate(
      { bankAccountId: settings.bankAccountId, input },
      {
        onSuccess: () => toast.success(ts.saved),
        onError: (err) => toast.error(ts.saveFailed, { description: describeRunError(err, tp.errors, tp.errors.generic) }),
      },
    );
  };

  // A field the form does not show right now (the blank stock fields, say) can still be wrong.
  const onInvalid = () => toast.error(ts.invalid);

  /** The test page uses what is in the form, saved or not, so a shift can be tried before it is kept. */
  const printTest = async (mode: 'print' | 'download') => {
    setPrinting(true);
    try {
      const values = getValues();
      const alignment = alignmentOf(values);
      const result = await renderAlignmentTestPdf(getCheckLayout(values.layout, alignment), labels, { alignment });
      if (mode === 'download') downloadBlob(pdfBlob(result.bytes), 'check-alignment-test.pdf');
      else printPdfBytes(result.bytes);
    } catch {
      toast.error(ts.checks.printTestFailed);
    } finally {
      setPrinting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit, onInvalid)} className="space-y-4" noValidate>
      <CheckSection form={form} settings={settings} canEdit={canEdit} printing={printing} onPrintTest={() => void printTest('print')} />
      <AchSection form={form} settings={settings} accounts={accounts} canEdit={canEdit} />
      <PositivePaySection form={form} settings={settings} canEdit={canEdit} />

      {canEdit ? (
        <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 rounded-md border bg-background p-3">
          {formState.isDirty ? <span className="mr-auto text-sm text-muted-foreground">{ts.unsaved}</span> : null}
          <Button type="button" variant="outline" disabled={printing} onClick={() => void printTest('download')}>
            {ts.checks.downloadTest}
          </Button>
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {tp.common.save}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

/** Check, ACH and Positive Pay settings of one bank account. */
export default function PaymentSettingsPage() {
  const { bankAccountId } = useParams({ strict: false }) as { bankAccountId: string };
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const ts = tp.settings;
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canEdit = can('banking:manage');

  const settingsQuery = usePaymentSettings(bankAccountId);
  const settings = settingsQuery.data;
  const accountsQuery = useBankAccounts();
  const accounts = useMemo(() => (accountsQuery.data?.data ?? []).filter(isPaymentBankAccount), [accountsQuery.data]);

  const backAction = (
    <Button asChild variant="outline" size="sm">
      <Link to="/weldbooks/payment-runs/settings">
        <ArrowLeft className="h-4 w-4" />
        {ts.backToList}
      </Link>
    </Button>
  );

  if (settingsQuery.isLoading) {
    return (
      <PaymentRunsFrame title={ts.title} actions={backAction}>
        <PageLoader fullScreen={false} />
      </PaymentRunsFrame>
    );
  }

  if (settingsQuery.isError || !settings) {
    return (
      <PaymentRunsFrame title={ts.title} actions={backAction}>
        <div className="space-y-2">
          <p className="text-sm text-destructive" role="alert">
            {describeRunError(settingsQuery.error, tp.errors, tp.common.loadFailed)}
          </p>
          <Button variant="outline" size="sm" onClick={() => settingsQuery.refetch()}>{tp.common.retry}</Button>
        </div>
      </PaymentRunsFrame>
    );
  }

  return (
    <PaymentRunsFrame title={ts.titleFor.replace('{name}', settings.bankAccountName)} subtitle={ts.subtitle} actions={backAction}>
      {accounts.length > 1 ? (
        <div className="w-64">
          <Label htmlFor="settings-account" className="text-xs text-muted-foreground">{ts.switchAccount}</Label>
          <Select
            value={bankAccountId}
            onValueChange={(value) => navigate({ to: '/weldbooks/payment-runs/settings/$bankAccountId', params: { bankAccountId: value } })}
          >
            <SelectTrigger id="settings-account">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {!canEdit ? <p className="text-sm text-muted-foreground">{ts.readOnly}</p> : null}

      <ReadinessCard settings={settings} />

      <SettingsForm key={settings.bankAccountId} settings={settings} accounts={accounts} canEdit={canEdit} />
    </PaymentRunsFrame>
  );
}
