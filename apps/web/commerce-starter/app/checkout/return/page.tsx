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

/** This page again, for the same order and payment. */
function returnHref(orderId: string, paymentId: string | null): string {
  const query = new URLSearchParams({ order: orderId });
  if (paymentId) query.set('payment', paymentId);
  return `/checkout/return?${query.toString()}`;
}

function CheckAgain({ href }: Readonly<{ href: string }>) {
  return (
    <p>
      <Link href={href} className="btn btn-secondary">
        Check again
      </Link>
    </p>
  );
}

/** What an order without a payment (yet) waits for. */
function placedText(awaitingApproval: boolean, method: 'mollie' | 'invoice'): string {
  if (awaitingApproval && method === 'mollie') {
    return 'is waiting for approval by your company. Once it is approved, we email you a link to pay.';
  }
  if (awaitingApproval) return 'is waiting for approval by your company. We let you know once it is decided.';
  if (method === 'invoice') return 'will be invoiced. You will get a confirmation email.';
  return 'is placed. You will get a confirmation email.';
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

/** Everything the page shows about one checkout. */
interface ReturnView {
  orderId: string;
  paymentId: string | null;
  payment: PaymentInfo | null;
  order: StorefrontOrder | null;
  link: string | null;
  outcome: Outcome;
  number: string;
  method: 'mollie' | 'invoice';
}

/**
 * The checkout behind `?order=…&payment=…` (Mollie's return URL carries
 * both). The checkout cookie is a fallback for the payment id and holds a
 * guest's order token; without either, there is nothing to show.
 */
async function resolveReturn(params: Record<string, string | string[] | undefined>): Promise<ReturnView | null> {
  const orderId = single(params.order);
  if (!orderId) return null;
  const state = await getCheckoutState();
  const own = state?.orderId === orderId ? state : undefined;
  const paymentId = single(params.payment) ?? own?.paymentId ?? null;
  const read = await loadPayment(paymentId);
  // A payment of another order (a copied or edited link) counts as none.
  const payment = read?.orderId === orderId ? read : null;
  if (!own && !payment) return null;
  const signedIn = Boolean(await getSessionToken());
  const orderToken = own?.orderToken ?? null;
  const order = await loadOrder(orderId, orderToken);
  return {
    orderId,
    paymentId,
    payment,
    order,
    link: orderLink(orderId, orderToken, signedIn),
    outcome: outcomeOf(paymentId, payment),
    number: payment?.orderNumber ?? order?.orderNumber ?? own?.orderNumber ?? '',
    method: own?.paymentMethod ?? (paymentId ? 'mollie' : 'invoice'),
  };
}

function OutcomeMessage({ view }: Readonly<{ view: ReturnView }>) {
  const { outcome, number, payment } = view;
  const again = returnHref(view.orderId, view.paymentId);
  switch (outcome) {
    case 'placed':
      return (
        <>
          <h1 className="text-3xl font-semibold">Thank you, your order is placed</h1>
          <p>
            Order <strong>{number}</strong> {placedText(view.order?.approvalStatus === 'pending', view.method)}
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
          <CheckAgain href={again} />
        </>
      );
    case 'waiting':
      return (
        <>
          <h1 className="text-3xl font-semibold">We&apos;re checking your payment</h1>
          <p>
            Mollie hasn&apos;t confirmed the payment for order <strong>{number}</strong> yet. This usually takes a few seconds.
          </p>
          <CheckAgain href={again} />
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
 * Where Mollie sends the shopper back (`?order=<orderId>&payment=<paymentId>`),
 * and the confirmation of an order on invoice. Coming back never marks
 * anything paid: the payment is read back from Mollie through the API.
 */
export default async function CheckoutReturnPage({ searchParams }: Readonly<Props>) {
  const params = await searchParams;
  const error = single(params.error);
  const view = await resolveReturn(params);
  if (!view) return <NotFound />;
  const { order, link } = view;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex max-w-2xl flex-col gap-3">
        <OutcomeMessage view={view} />

        {error ? (
          <p role="alert" className="rounded-lg border border-danger bg-danger-soft px-4 py-3 text-danger">
            {messageForCode(error)}
          </p>
        ) : null}

        {view.outcome === 'failed' && view.paymentId ? (
          <form action={retryPaymentAction}>
            <input type="hidden" name="orderId" value={view.orderId} />
            <input type="hidden" name="paymentId" value={view.paymentId} />
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
