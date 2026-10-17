import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import {
  useFiscalCalendar,
  useGenerateFiscalPeriods,
  useSetFiscalPeriodStatus,
} from '@/hooks/queries/use-weldbooks-assets-queries';
import type { GenerateFiscalPeriodsResult } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { errorMessage, fill } from '../fixed-assets/text';
import {
  FiscalCalendarBody,
  FiscalGenerateButton,
  FiscalYearControls,
  StatusConfirmDialog,
  type PendingStatusChange,
} from './fiscal-period-parts';

const YEAR_CHOICES = 7;

/** The periods of a fiscal year the entity's setup defines (calendar months, or 4-4-5 weeks) and the ones still to create. */
export default function FiscalPeriodsPage() {
  const { t } = useI18n();
  const tf = t.weldbooksUs.assets.fiscal;
  const { can } = usePermissions();
  const { today } = useWeldbooksFormat();

  const currentYear = Number(today().slice(0, 4));
  const [fiscalYear, setFiscalYear] = useState(currentYear);
  const [includeQuarters, setIncludeQuarters] = useState(false);
  const [includeYear, setIncludeYear] = useState(false);
  const [generated, setGenerated] = useState<GenerateFiscalPeriodsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingStatusChange>(null);
  const setStatus = useSetFiscalPeriodStatus();
  const canChangeStatus = can('reports:update');

  const params = useMemo(() => ({ fiscalYear, includeQuarters, includeYear }), [fiscalYear, includeQuarters, includeYear]);
  const calendar = useFiscalCalendar(params);
  const generate = useGenerateFiscalPeriods();
  const data = calendar.data;

  const yearOptions = useMemo(
    () => Array.from({ length: YEAR_CHOICES }, (_, index) => currentYear + 2 - index),
    [currentYear],
  );
  const missing = data?.periods.filter((period) => period.existingId === null).length ?? 0;

  const submit = async () => {
    setError(null);
    try {
      const result = await generate.mutateAsync(params);
      setGenerated(result);
      toast.success(fill(tf.generatedToast, { count: result.created.length }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const changeStatus = async () => {
    if (!confirm?.period.existingId) return;
    const { period, action } = confirm;
    setError(null);
    try {
      await setStatus.mutateAsync({ id: period.existingId!, action });
      toast.success(fill(action === 'close' ? tf.closedToast : tf.reopenedToast, { period: period.name }));
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      toast.error(action === 'close' ? tf.closeFailed : tf.reopenFailed, { description: message });
    } finally {
      setConfirm(null);
    }
  };

  return (
    <>
      {error ? (
        <p className="px-4 pt-4 text-sm text-destructive sm:px-6" role="alert" data-testid="fiscal-error">
          {error}
        </p>
      ) : null}

      <FiscalCalendarBody
        calendar={calendar}
        generated={generated}
        canChangeStatus={canChangeStatus}
        onChangeStatus={setConfirm}
        leftActionButtons={
          <FiscalYearControls
            fiscalYear={fiscalYear}
            yearOptions={yearOptions}
            includeQuarters={includeQuarters}
            includeYear={includeYear}
            onYearChange={(year) => {
              setFiscalYear(year);
              setGenerated(null);
            }}
            onIncludeQuartersChange={setIncludeQuarters}
            onIncludeYearChange={setIncludeYear}
          />
        }
        actionButtons={
          can('reports:create') ? (
            <FiscalGenerateButton
              generating={generate.isPending}
              missing={missing}
              hasData={Boolean(data)}
              onGenerate={() => void submit()}
            />
          ) : null
        }
      />

      <StatusConfirmDialog
        confirm={confirm}
        pending={setStatus.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void changeStatus()}
      />
    </>
  );
}
