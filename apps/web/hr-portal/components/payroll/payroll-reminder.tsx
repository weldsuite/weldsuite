'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { useMe } from '@/lib/me-context';
import { usePayrollStatus } from '@/lib/hooks/use-payroll-status';

/**
 * Home-page nudge while payroll still lacks details or a signed tax form.
 * Renders nothing when the workspace has no payroll or nothing is open, and
 * never blocks the page: it follows the same cached query as the navigation.
 */
export function PayrollReminder() {
  const slug = String(useParams().workspace ?? '');
  const me = useMe();
  const { dict } = useI18n();
  const payroll = usePayrollStatus(slug, me.kind === 'employee');
  if (!payroll.needsAttention) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 sm:p-5">
      <h2 className="font-medium text-amber-900">{dict.payroll.reminder.title}</h2>
      <p className="mt-1 text-sm text-amber-900">{dict.payroll.reminder.body}</p>
      <Link href={`/${slug}/me/payroll`} className="mt-2 inline-block text-sm font-medium text-amber-900 underline underline-offset-2">
        {dict.payroll.reminder.link}
      </Link>
    </div>
  );
}
