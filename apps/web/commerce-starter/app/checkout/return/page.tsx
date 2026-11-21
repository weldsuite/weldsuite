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

  if (!orderId || !state || state.orderId !== orderId) {
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

  let payment: PaymentInfo | null = null;
  if (state.paymentId) {
    try {
      payment = await storefront().payments.get(state.paymentId, await requestOptions());
    } catch (cause) {
      if (!isStorefrontError(cause)) throw cause;
    }
  }
  const signedIn = Boolean(await getSessionToken());
  const order = await loadOrder(state.orderId, state.orderToken);
  const link = orderLink(state.orderId, state.orderToken, signedIn);
  const number = payment?.orderNumber ?? order?.orderNumber ?? state.orderNumber;

  const paid = payment && (payment.status === 'paid' || payment.status === 'authorized');
  const waiting = payment && (payment.status === 'open' || payment.status === 'pending');
  const failed = payment && !paid && !waiting;
  const awaitingApproval = order?.approvalStatus === 'pending';

  return (
    <div className="flex flex-col gap-8">
      <div className="flex max-w-2xl flex-col gap-3">
        {!state.paymentId ? (
          <>
            <h1 className="text-3xl font-semibold">Thank you, your order is placed</h1>
            <p>
              Order <strong>{number}</strong>{' '}
              {awaitingApproval
                ? 'is waiting for approval by your company. We let you know once it is decided.'
                : 'will be invoiced. You will get a confirmation email.'}
            </p>
          </>
        ) : paid ? (
          <>
            <h1 className="text-3xl font-semibold">Thank you, we received your payment</h1>
            <p>
              Order <strong>{number}</strong> is paid. You will get a confirmation email.
            </p>
          </>
        ) : !payment ? (
          <>
            <h1 className="text-3xl font-semibold">We couldn&apos;t check your payment</h1>
            <p>
              Your order <strong>{number}</strong> is saved. We couldn&apos;t reach the payment service just now: check again in a
              moment.
            </p>
            <p>
              <Link href={`/checkout/return?order=${encodeURIComponent(state.orderId)}`} className="btn btn-secondary">
                Check again
              </Link>
            </p>
          </>
        ) : waiting ? (
          <>
            <h1 className="text-3xl font-semibold">We&apos;re checking your payment</h1>
            <p>
              Mollie hasn&apos;t confirmed the payment for order <strong>{number}</strong> yet. This usually takes a few seconds.
            </p>
            <p>
              <Link href={`/checkout/return?order=${encodeURIComponent(state.orderId)}`} className="btn btn-secondary">
                Check again
              </Link>
            </p>
          </>
        ) : (
          <>
            <h1 className="text-3xl font-semibold">The payment didn&apos;t go through</h1>
            <p>
              {payment?.status === 'canceled'
                ? 'You cancelled the payment.'
                : payment?.status === 'expired'
                  ? 'The payment expired.'
                  : 'The payment failed.'}{' '}
              Your order <strong>{number}</strong> is saved: you can try again.
            </p>
          </>
        )}

        {error ? (
          <p role="alert" className="rounded-lg border border-danger bg-danger-soft px-4 py-3 text-danger">
            {messageForCode(error)}
          </p>
        ) : null}

        {failed ? (
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
