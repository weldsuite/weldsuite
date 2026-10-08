import { useCallback, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useCreateTaxReturn } from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import {
  isSalesTaxRequestError,
  salesTaxErrorDetails,
  type CreateReturnInput,
} from '@/lib/api/domains/weldbooks-sales-tax-center';

/**
 * Opens the return of a period: creates it and goes to it. A period that
 * already has a return (409) goes straight to that return.
 */
export function useOpenReturn() {
  const { t } = useI18n();
  const failed = t.weldbooksUs.salesTax.center.overview.openFailed;
  const navigate = useNavigate();
  const create = useCreateTaxReturn();
  const [openingKey, setOpeningKey] = useState<string | null>(null);

  const open = useCallback(
    async (key: string, input: CreateReturnInput) => {
      setOpeningKey(key);
      try {
        const created = await create.mutateAsync(input);
        await navigate({ to: '/weldbooks/sales-tax/returns/$id', params: { id: created.id } });
      } catch (err) {
        const existing = salesTaxErrorDetails(err)?.returnId;
        if (isSalesTaxRequestError(err) && err.status === 409 && typeof existing === 'string') {
          await navigate({ to: '/weldbooks/sales-tax/returns/$id', params: { id: existing } });
          return;
        }
        toast.error(failed, { description: err instanceof Error ? err.message : undefined });
      } finally {
        setOpeningKey(null);
      }
    },
    [create, navigate, failed],
  );

  return { open, openingKey };
}
