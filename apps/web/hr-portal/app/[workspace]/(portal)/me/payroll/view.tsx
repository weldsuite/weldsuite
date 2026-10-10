'use client';

import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { usePortalQuery } from '@/lib/hooks/use-portal-query';
import { PAYROLL_DETAILS_PATH } from '@/lib/hooks/use-payroll-status';
import { humanizeKey } from '@/lib/payroll/format';
import { missingSections } from '@/lib/payroll/missing';
import { usStateName } from '@/lib/payroll/us-states';
import type { HrMyPayrollDetails } from '@/lib/payroll/types';
import { Card, PageHeader } from '@/components/ui/primitives';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { PaymentDetailsForm } from '@/components/payroll/payment-details-form';
import { TaxForms } from '@/components/payroll/tax-forms';

/** Everything payroll is still waiting for, as short phrases: missing details first, then forms to sign. */
function useOpenItems(details: HrMyPayrollDetails): string[] {
  const { dict, format } = useI18n();
  const t = dict.payroll;
  const { groups, other } = missingSections(details.missing);
  const items: string[] = [];
  if (groups.has('nationalId')) items.push(details.country === 'NL' ? t.details.missing.nationalIdNl : t.details.missing.nationalIdUs);
  if (groups.has('dateOfBirth')) items.push(t.details.missing.dateOfBirth);
  if (groups.has('bank')) items.push(t.details.missing.bank);
  if (groups.has('address')) items.push(t.details.missing.address);
  if (groups.has('idDocument')) items.push(t.details.missing.idDocument);
  items.push(...other);
  for (const required of details.requiredElections) {
    if (required.kind === 'nl_loonheffingskorting') items.push(t.taxForms.nl.title);
    else if (required.kind === 'us_w4') items.push(t.taxForms.us.w4Title);
    else if (required.state) items.push(format(t.taxForms.us.stateTitle, { state: usStateName(required.state) }));
    else items.push(humanizeKey(required.kind));
  }
  return items;
}

function OpenItems({ details }: Readonly<{ details: HrMyPayrollDetails }>) {
  const { dict } = useI18n();
  const items = useOpenItems(details);
  if (items.length === 0) return null;
  return (
    <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-medium">{dict.payroll.details.missingTitle}</p>
      <ul className="mt-1 list-disc pl-5">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="mt-2">{dict.payroll.details.missingBody}</p>
    </div>
  );
}

export default function PayrollDetailsView() {
  const slug = String(useParams().workspace ?? '');
  const { dict, format } = useI18n();
  const t = dict.payroll.details;
  const { data, loading, error, refetch } = usePortalQuery<HrMyPayrollDetails>(slug, PAYROLL_DETAILS_PATH);

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState onRetry={refetch} />;

  if (data.country === null) {
    return (
      <div className="space-y-6">
        <PageHeader title={t.title} />
        <Card>
          <EmptyState message={t.notOnPayroll} />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t.title} />
      {data.employerName && <p className="-mt-3 text-sm text-gray-500">{format(t.employer, { employer: data.employerName })}</p>}

      <OpenItems details={data} />

      <Card>
        <h2 className="font-medium text-gray-900">{t.yourDetails}</h2>
        <p className="mt-1 mb-4 text-sm text-gray-500">{t.detailsIntro}</p>
        <PaymentDetailsForm slug={slug} country={data.country} details={data} />
      </Card>

      <TaxForms slug={slug} details={data} />
    </div>
  );
}
