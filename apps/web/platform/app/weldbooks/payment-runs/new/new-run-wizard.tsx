import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useBankAccounts } from '@/hooks/queries/use-weldbooks-banking-queries';
import {
  useCreatePaymentRun,
  usePayableBills,
  usePaymentSettings,
  useSubmitPaymentRun,
} from '@/hooks/queries/use-weldbooks-payment-runs-queries';
import { describeRunError } from '../run-errors';
import { BillsStep } from './bills-step';
import {
  buildCreateInput,
  buildItems,
  defaultApprovals,
  dropBlockedPicks,
  isPaymentBankAccount,
  reconcilePicks,
  reviewVendors,
  type PickMap,
} from './new-run-model';
import { ReviewStep } from './review-step';
import { SetupStep, methodReadiness, type SetupValues } from './setup-step';

type Step = 'setup' | 'bills' | 'review';

const STEPS: readonly Step[] = ['setup', 'bills', 'review'];

/** Plans a payment run in three steps: how and from where, which bills, and a last look. */
export function NewRunWizard() {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { today } = useWeldbooksFormat();

  const [step, setStep] = useState<Step>('setup');
  const [values, setValues] = useState<SetupValues>(() => ({
    bankAccountId: '',
    method: 'check',
    paymentDate: today(),
    secCode: 'auto',
    sameDay: false,
    requiredApprovals: defaultApprovals('check'),
    notes: '',
    dueBefore: '',
  }));
  const [picks, setPicks] = useState<PickMap>({});
  const [busy, setBusy] = useState(false);

  const accountsQuery = useBankAccounts();
  const accounts = useMemo(() => (accountsQuery.data?.data ?? []).filter(isPaymentBankAccount), [accountsQuery.data]);
  const settingsQuery = usePaymentSettings(values.bankAccountId || undefined);
  const settings = settingsQuery.data;
  const requirePrenotes = settings?.achSettings.requirePrenotes ?? false;

  const billsQuery = usePayableBills(
    { bankAccountId: values.bankAccountId || undefined, dueBefore: values.dueBefore || undefined },
    { enabled: step !== 'setup' && !!values.bankAccountId },
  );
  const vendors = useMemo(() => billsQuery.data ?? [], [billsQuery.data]);

  // New bills arrive unpicked; picks of bills that left the list go with them.
  useEffect(() => {
    setPicks((previous) => reconcilePicks(vendors, previous));
  }, [vendors]);

  // Same Day only exists on ACH and only when the bank account allows it.
  useEffect(() => {
    if (values.sameDay && (values.method !== 'ach' || settings?.achSettings.sameDayAllowed === false)) {
      setValues((current) => ({ ...current, sameDay: false }));
    }
  }, [values.sameDay, values.method, settings?.achSettings.sameDayAllowed]);

  const createRun = useCreatePaymentRun();
  const submitRun = useSubmitPaymentRun();

  const built = useMemo(() => buildItems(vendors, picks, values.method), [vendors, picks, values.method]);
  const review = useMemo(() => reviewVendors(vendors, picks, values.method, { requirePrenotes }), [vendors, picks, values.method, requirePrenotes]);
  const bankAccountName = accounts.find((a) => a.id === values.bankAccountId)?.name ?? '';
  const canManage = can('banking:manage');

  const change = (patch: Partial<SetupValues>) => {
    setValues((current) => ({ ...current, ...patch }));
    // A different method can block bills that were picked.
    const method = patch.method;
    if (method) setPicks((current) => dropBlockedPicks(current, vendors, method));
  };

  const create = async (submit: boolean) => {
    if (built.items.length === 0) return;
    setBusy(true);
    try {
      const run = await createRun.mutateAsync(buildCreateInput(values, built.items));
      if (submit) {
        try {
          await submitRun.mutateAsync(run.id);
          toast.success(tp.wizard.submitted);
        } catch (err) {
          toast.error(tp.wizard.submitFailed, { description: describeRunError(err, tp.errors, tp.errors.generic) });
        }
      } else {
        toast.success(tp.wizard.created);
      }
      await navigate({ to: '/weldbooks/payment-runs/$id', params: { id: run.id } });
    } catch (err) {
      toast.error(tp.wizard.createFailed, { description: describeRunError(err, tp.errors, tp.errors.generic) });
    } finally {
      setBusy(false);
    }
  };

  const stepIndex = STEPS.indexOf(step);
  const methodNotReady = values.method === 'check' && !!settings && !methodReadiness(settings, 'check').ready;

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap items-center gap-2 text-sm" aria-label={tp.wizard.stepsLabel}>
        {STEPS.map((id, index) => (
          <li
            key={id}
            aria-current={id === step ? 'step' : undefined}
            className={
              id === step
                ? 'rounded-full bg-primary px-3 py-1 font-medium text-primary-foreground'
                : index < stepIndex
                  ? 'rounded-full bg-muted px-3 py-1 text-foreground'
                  : 'rounded-full px-3 py-1 text-muted-foreground'
            }
          >
            {index + 1}. {tp.wizard.steps[id]}
          </li>
        ))}
      </ol>

      {step === 'setup' ? (
        <SetupStep
          values={values}
          onChange={change}
          accounts={accounts}
          accountsLoading={accountsQuery.isLoading}
          settings={settings}
          settingsLoading={settingsQuery.isLoading && !!values.bankAccountId}
          canManage={canManage}
          onNext={() => setStep('bills')}
        />
      ) : null}

      {step === 'bills' ? (
        <BillsStep
          vendors={vendors}
          loading={billsQuery.isLoading}
          failed={billsQuery.isError}
          onRetry={() => billsQuery.refetch()}
          method={values.method}
          picks={picks}
          onPicksChange={setPicks}
          requirePrenotes={requirePrenotes}
          built={built}
          onBack={() => setStep('setup')}
          onNext={() => setStep('review')}
        />
      ) : null}

      {step === 'review' ? (
        <ReviewStep
          values={values}
          bankAccountName={bankAccountName}
          vendors={review}
          built={built}
          canCreate={can('banking:create') && !methodNotReady}
          busy={busy}
          onBack={() => setStep('bills')}
          onCreate={create}
        />
      ) : null}
    </div>
  );
}
