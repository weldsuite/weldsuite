import type { Approval } from '@weldsuite/commerce-sdk';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ApprovalForm } from '@/components/account-forms';
import { requestOptions, shopLocale, shopTimeZone, storefront } from '@/lib/commerce';
import { activeCompany, getShopper, getSessionToken } from '@/lib/data';
import { date, money } from '@/lib/format';
import { single } from '@/lib/params';

export const metadata: Metadata = { title: 'Orders to approve', robots: { index: false } };

const REASONS: Record<string, string> = {
  buyer_limit: "Above the buyer's spend limit",
  company_threshold: "Above the company's approval threshold",
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function itemSummary(items: Approval['order']['items']): string {
  const shown = items
    .slice(0, 5)
    .map((item) => `${item.quantity} × ${item.name}`)
    .join(', ');
  return items.length > 5 ? `${shown}, and ${items.length - 5} more` : shown;
}

function ApprovalCard({ approval }: { approval: Approval }) {
  const { order, reason, requestedBy } = approval;
  return (
    <article aria-labelledby={`approval-${order.id}`} className="flex flex-col gap-4 rounded-2xl border border-line p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`approval-${order.id}`} className="text-lg font-semibold">
          <Link href={`/account/orders/${encodeURIComponent(order.id)}`} className="underline underline-offset-4">
            Order {order.orderNumber}
          </Link>
        </h2>
        <p className="text-lg font-semibold tabular-nums">{money(order.total, order.currency, shopLocale)}</p>
      </header>
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
        <dt className="text-ink-muted">Requested by</dt>
        <dd>{requestedBy.name ?? 'A buyer'}</dd>
        <dt className="text-ink-muted">Placed</dt>
        <dd>{date(order.placedAt, shopLocale, shopTimeZone)}</dd>
        <dt className="text-ink-muted">Why</dt>
        <dd>{REASONS[reason] ?? reason}</dd>
        <dt className="text-ink-muted">Items</dt>
        <dd>{itemSummary(order.items)}</dd>
      </dl>
      <ApprovalForm orderId={order.id} orderNumber={order.orderNumber} />
    </article>
  );
}

function Approvals({ canApprove, approvals }: { canApprove: boolean; approvals: Approval[] }) {
  if (!canApprove) {
    return <p className="rounded-lg bg-surface-muted p-6">Only your company&apos;s approvers and admins approve orders.</p>;
  }
  if (approvals.length === 0) {
    return <p className="rounded-lg bg-surface-muted p-6">Nothing waits for your approval.</p>;
  }
  return (
    <ul role="list" className="flex flex-col gap-4">
      {approvals.map((approval) => (
        <li key={approval.order.id}>
          <ApprovalCard approval={approval} />
        </li>
      ))}
    </ul>
  );
}

export default async function ApprovalsPage({ searchParams }: Props) {
  const params = await searchParams;
  const approved = single(params.approved);
  const rejected = single(params.rejected);
  const shopper = await getShopper();
  const session = await getSessionToken();
  if (!shopper || !session) redirect('/account/sign-in?next=/account/approvals');
  const company = activeCompany(shopper);
  const canApprove = company?.role === 'approver' || company?.role === 'admin';

  const approvals = canApprove ? await storefront().approvals.list(session, await requestOptions()) : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <p>
          <Link href="/account" className="text-sm underline underline-offset-4">
            Your account
          </Link>
        </p>
        <h1 className="text-3xl font-semibold">Orders to approve</h1>
        {company ? <p className="text-ink-muted">For {company.name}</p> : null}
      </div>

      <div role="status" aria-live="polite">
        {approved || rejected ? (
          <p className="rounded-lg border border-success bg-success-soft px-4 py-3 font-medium text-success">
            Order {approved ?? rejected} {approved ? 'approved' : 'rejected'}.
          </p>
        ) : null}
      </div>

      <Approvals canApprove={canApprove} approvals={approvals} />
    </div>
  );
}
