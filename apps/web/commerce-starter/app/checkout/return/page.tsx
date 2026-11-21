import { isStorefrontError, type PaymentInfo, type StorefrontOrder } from '@weldsuite/commerce-sdk';
import type { Metadata } from 'next';
import Link from 'next/link';

import { SubmitButton } from '@/components/form-bits';
import { OrderLines } from '@/components/totals';
import { retryPaymentAction } from '@/lib/actions/checkout';
import { requestOptions, shopLocale, storefront } from '@/lib/commerce';
import { getSessionToken } from '@/lib/data';
import { messageForCode } from '@/lib/errors';
import { single } from '@/lib/params';
import { getCheckoutState } from '@/lib/session';

export const metadata: Metadata = { title: 'Your order', robots: { index: false }, referrer: 'no-referrer' };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * How the checkout ended: placed on invoice, paid, still waiting for Mollie,
 * failed (cancelled, expired), or unknown (the payment couldn't be read).
 */
type Outcome = 'placed' | 'paid' | 'waiting' | 'failed' | 'unknown';

function outcomeOf(paymentId: string | null, payment: PaymentInfo | null): Outcome {
  if (!paymentId) return 'placed';
  if (!payment) return 'unknown';
  if (payment.status === 'paid' || payment.status === 'authorized') return 'paid';
  if (payment.status === 'open' || payment.status === 'pending') return 'waiting';
  return 'failed';
}

/** The Mollie payment, read back through the API; null when it can't be read. */
async function loadPayment(paymentId: string | null): Promise<PaymentInfo | null> {
  if (!paymentId) return null;
  try {
    return await storefront().payments.get(paymentId, await requestOptions());
  } catch (cause) {
    if (!isStorefrontError(cause)) throw cause;
    return null;
  }
}

/** The placed order, through the shopper's account or the guest's order token. */
async function loadOrder(orderId: string, orderToken: string | null): Promise<StorefrontOrder | null> {
  const options = await requestOptions();
  const session = await getSessionToken();
  try {
    if (session) return await storefront().orders.get(session, orderId, options);
    if (orderToken) return await storefront().orders.getGuest(orderId, orderToken, options);
  } catch (error) {
    if (!isStorefrontError(error)) throw error;
  }
  return null;
}

function orderLink(orderId: string, orderToken: string | null, signedIn: boolean): string | null {
  if (signedIn) return `/account/orders/${encodeURIComponent(orderId)}`;
  if (orderToken) return `/orders/${encodeURIComponent(orderId)}?token=${encodeURIComponent(orderToken)}`;
  return null;
}

function failureText(status: string | undefined): string {
  if (status === 'canceled') return 'You cancelled the payment.';
  if (status === 'expired') return 'The payment expired.';
  return 'The payment failed.';
}

function CheckAgain({ orderId }: { orderId: string }) {
  return (
    <p>
      <Link href={`/checkout/return?order=${encodeURIComponent(orderId)}`} className="btn btn-secondary">
        Check again
      </Link>
    </p>
  );
}

function NotFound() {
  return (
    <div className="flex max-w-xl flex-col items-start gap-4">
      <h1 className="text-3xl font-semibold">We can&apos;t find this checkout</h1>
      <p>If you placed an order, the confirmation email has a link to it. Signed in? Your orders are in your account.</p>
      <Link href="/account/orders" className="btn btn-secondary">
        Your orders
      </Link>
    </div>
  );
}

function OutcomeMessage({
  outcome,
  number,
  orderId,
  payment,
  awaitingApproval,
}: {
  outcome: Outcome;
  number: string;
  orderId: string;
  payment: PaymentInfo | null;
  awaitingApproval: boolean;
}) {
  switch (outcome) {
    case 'placed':
      return (
        <>
          <h1 className="text-3xl font-semibold">Thank you, your order is placed</h1>
          <p>
            Order <strong>{number}</strong>{' '}
            {awaitingApproval
              ? 'is waiting for approval by your company. We let you know once it is decided.'
              : 'will be invoiced. You will get a confirmation email.'}
          </p>
        </>
      );
    case 'paid':
      return (
        <>
          <h1 className="text-3xl font-semibold">Thank you, we received your payment</h1>
          <p>
            Order <strong>{number}</strong> is paid. You will get a confirmation email.
          </p>
        </>
      );
    case 'unknown':
      return (
        <>
          <h1 className="text-3xl font-semibold">We couldn&apos;t check your payment</h1>
          <p>
            Your order <strong>{number}</strong> is saved. We couldn&apos;t reach the payment service just now: check again in a
            moment.
          </p>
          <CheckAgain orderId={orderId} />
        </>
      );
    case 'waiting':
      return (
        <>
          <h1 className="text-3xl font-semibold">We&apos;re checking your payment</h1>
          <p>
            Mollie hasn&apos;t confirmed the payment for order <strong>{number}</strong> yet. This usually takes a few seconds.
          </p>
          <CheckAgain orderId={orderId} />
        </>
      );
    case 'failed':
      return (
        <>
          <h1 className="text-3xl font-semibold">The payment didn&apos;t go through</h1>
          <p>
            {failureText(payment?.status)} Your order <strong>{number}</strong> is saved: you can try again.
          </p>
        </>
      );
  }
}

/**
 * Where Mollie sends the shopper back (`?order=<orderId>`), and the
 * confirmation of an order on invoice. Coming back never marks anything
 * paid: the payment is read back from Mollie through the API.
 */
export default async function CheckoutReturnPage({ searchParams }: Props) {
  const params = await searchParams;
  const orderId = single(params.order);
  const error = single(params.error);
  const state = await getCheckoutState();
  if (!orderId || !state || state.orderId !== orderId) return <NotFound />;

  const payment = await loadPayment(state.paymentId);
  const signedIn = Boolean(await getSessionToken());
  const order = await loadOrder(state.orderId, state.orderToken);
  const link = orderLink(state.orderId, state.orderToken, signedIn);
  const outcome = outcomeOf(state.paymentId, payment);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex max-w-2xl flex-col gap-3">
        <OutcomeMessage
          outcome={outcome}
          number={payment?.orderNumber ?? order?.orderNumber ?? state.orderNumber}
          orderId={state.orderId}
          payment={payment}
          awaitingApproval={order?.approvalStatus === 'pending'}
        />

        {error ? (
          <p role="alert" className="rounded-lg border border-danger bg-danger-soft px-4 py-3 text-danger">
            {messageForCode(error)}
          </p>
        ) : null}

        {outcome === 'failed' ? (
          <form action={retryPaymentAction}>
            <SubmitButton pendingText="Starting the payment…">Try paying again</SubmitButton>
          </form>
        ) : null}

        {link ? (
          <p>
            <Link href={link} className="font-medium text-brand underline underline-offset-4">
              View your order
            </Link>
          </p>
        ) : null}
      </div>

      {order ? (
        <section aria-labelledby="order-heading" className="flex flex-col gap-4">
          <h2 id="order-heading" className="text-xl font-semibold">
            Order {order.orderNumber}
          </h2>
          <OrderLines order={order} locale={shopLocale} />
        </section>
      ) : null}
    </div>
  );
}
