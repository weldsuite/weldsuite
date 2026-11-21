import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { CompanyForm, ProfileForm } from '@/components/account-forms';
import { SubmitButton } from '@/components/form-bits';
import { signOutAction } from '@/lib/actions/account';
import { activeCompany, getChannel, getShopper } from '@/lib/data';

export const metadata: Metadata = { title: 'Your account', robots: { index: false } };

export default async function AccountPage() {
  const [shopper, channel] = await Promise.all([getShopper(), getChannel()]);
  if (!shopper) redirect('/account/sign-in?next=/account');
  const company = activeCompany(shopper);
  const canApprove = company?.role === 'approver' || company?.role === 'admin';
  const name = [shopper.firstName, shopper.lastName].filter(Boolean).join(' ');

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Your account</h1>
          <p className="text-ink-muted">
            {name ? `${name}, ` : ''}
            {shopper.email}
          </p>
        </div>
        <form action={signOutAction}>
          <SubmitButton className="btn btn-secondary" pendingText="Signing out…">
            Sign out
          </SubmitButton>
        </form>
      </div>

      <nav aria-label="Account">
        <ul role="list" className="flex flex-wrap gap-3">
          <li>
            <Link href="/account/orders" className="btn btn-primary">
              Your orders
            </Link>
          </li>
          {canApprove ? (
            <li>
              <Link href="/account/approvals" className="btn btn-secondary">
                Orders to approve
              </Link>
            </li>
          ) : null}
          {channel.audience === 'b2b' ? (
            <li>
              <Link href="/quick-order" className="btn btn-secondary">
                Quick order
              </Link>
            </li>
          ) : null}
        </ul>
      </nav>

      {shopper.companies.length > 0 ? (
        <section aria-labelledby="company" className="flex max-w-2xl flex-col gap-4">
          <h2 id="company" className="text-xl font-semibold">
            Company
          </h2>
          {shopper.companies.length === 1 && company ? (
            <p>
              You buy for <strong>{company.name}</strong>.
            </p>
          ) : (
            <CompanyForm shopper={shopper} />
          )}
        </section>
      ) : channel.audience === 'b2b' ? (
        <p className="max-w-2xl rounded-lg bg-warning-soft p-4">
          Your account isn&apos;t linked to a company yet, so you can&apos;t order here. Ask your company&apos;s admin to invite
          you, or contact the shop.
        </p>
      ) : null}

      <section aria-labelledby="details" className="flex max-w-2xl flex-col gap-4">
        <h2 id="details" className="text-xl font-semibold">
          Your details
        </h2>
        <ProfileForm shopper={shopper} />
      </section>
    </div>
  );
}
