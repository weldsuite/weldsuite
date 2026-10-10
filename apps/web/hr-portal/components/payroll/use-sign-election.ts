'use client';

import { useState } from 'react';
import { portalPost } from '@/lib/client';
import { useI18n } from '@/lib/i18n';
import { useSetPayrollDetails } from '@/lib/hooks/use-payroll-status';
import type { CreateHrTaxElectionInput, HrMyPayrollDetails } from '@/lib/payroll/types';

/**
 * Signs a tax election (`POST /employee/tax-elections`). The answer is the
 * employee's refreshed payroll details, which go straight into the cache so
 * the card flips to "Signed" and the "still to sign" list shrinks at once.
 */
export function useSignElection(slug: string) {
  const { dict } = useI18n();
  const setDetails = useSetPayrollDetails(slug);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** True when the election was stored. */
  async function sign(body: CreateHrTaxElectionInput): Promise<boolean> {
    setSubmitting(true);
    setError(null);
    try {
      const details = await portalPost<HrMyPayrollDetails>(slug, '/employee/tax-elections', body);
      setDetails(details);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : dict.errors.generic);
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  return { submitting, error, setError, sign };
}
