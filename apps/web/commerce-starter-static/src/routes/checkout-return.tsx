import { isStorefrontError, type PaymentInfo, type StorefrontOrder } from '@weldsuite/commerce-sdk';
import { Link, redirect, useFetcher, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';

import { FormMessage, SubmitButton, type ActionState } from '../components/form-bits';
import { PageMeta } from '../components/page-meta';
import { OrderLines } from './order';
import { field } from '../lib/cart';
import { storefront } from '../lib/client';
import { describeError, messageForCode, text } from '../lib/messages';
import { getCheckoutState, setCheckoutState } from '../lib/storage';
import { orderPath, returnPath } from '../lib/urls';

/** How the checkout ended: placed (no payment yet), paid, still waiting, failed, or unknown (unreadable). */
type Outcome = 'placed' | 'paid' | 'waiting' | 'failed' | 'unknown';

interface ReturnData {
  found: boolean;
  orderId: string;
  paymentId: string | null;
  payment: PaymentInfo | null;
  order: StorefrontOrder | null;
  outcome: Outcome;
  number: string;
  link: string | null;
  error: string | null;
}

function outcomeOf(paymentId: string | null, payment: PaymentInfo | null): Outcome {
  if (!paymentId) return 'placed';
  if (!payment) return 'unknown';
  if (payment.status === 'paid' || payment.status === 'authorized') return 'paid';
  if (payment.status === 'open' || payment.status === 'pending') return 'waiting';
  return 'failed';
}

/**
 * Where Mollie sends the shopper back (`?order=…&payment=…`). Coming back
 * never marks anything paid: the payment is read back through the API. The
 * last checkout in storage holds a guest's order token.
 */
export async function loader({ request }: LoaderFunctionArgs): Promise<ReturnData> {
  const url = new URL(request.url);
  const orderId = url.searchParams.get('order') ?? '';
  const error = url.searchParams.get('error');
  const empty: ReturnData = { found: false, orderId, paymentId: null, payment: null, order: null, outcome: 'unknown', number: '', link: null, error };
  if (!orderId) return empty;
  const state = getCheckoutState();
  const own = state?.orderId === orderId ? state : undefined;
  const paymentId = url.searchParams.get('payment') ?? own?.paymentId ?? null;
  let payment: PaymentInfo | null = null;
  if (paymentId) {
    try {
      const read = await storefront().payments.get(paymentId);
      // A payment of another order (a copied or edited link) counts as none.
      payment = read.orderId === orderId ? read : null;
    } catch (cause) {
      if (!isStorefrontError(cause)) throw cause;
    }
  }
  if (!own && !payment) return empty;
  const token = own?.orderToken ?? null;
  const order = token ? await storefront().orders.getGuest(orderId, token).catch(() => null) : null;
  return {
    found: true,
    orderId,
    paymentId,
    payment,
    order,
    outcome: outcomeOf(paymentId, payment),
    number: payment?.orderNumber ?? order?.orderNumber ?? own?.orderNumber ?? '',
    link: token ? orderPath(orderId, token) : null,
    error,
  };
}

/** A new Mollie payment after a failed, cancelled or expired one. */
export async function action({ request }: ActionFunctionArgs): Promise<ActionState | Response> {
  const form = await request.formData();
  const orderId = field(form, 'orderId');
  const paymentId = field(form, 'paymentId');
  try {
    const payment = await storefront().payments.retry(paymentId);
    const state = getCheckoutState();
    if (state?.orderId === orderId) setCheckoutState({ ...state, paymentId: payment.id });
    return redirect(payment.checkoutUrl ?? returnPath(orderId, payment.id));
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

function Outcome({ view }: Readonly<{ view: ReturnData }>) {
  const n = view.number;
  const [title, body] = {
    placed: [text.placedTitle, text.placed(n)],
    paid: [text.paidTitle, text.paid(n)],
    waiting: [text.waitingTitle, text.waiting(n)],
    unknown: [text.unknownTitle, text.unknown(n)],
    failed: [text.failedTitle, text.failed(view.payment?.status, n)],
  }[view.outcome];
  return (
    <>
      <h1 className="text-3xl font-semibold">{title}</h1>
      <p role="status">{body}</p>
    </>
  );
}

export function Component() {
  const view = useLoaderData() as ReturnData;
  const fetcher = useFetcher<ActionState>();
  if (!view.found) {
    return (
      <div className="flex max-w-xl flex-col items-start gap-4">
        <PageMeta title={text.returnNotFoundTitle} />
        <h1 className="text-3xl font-semibold">{text.returnNotFoundTitle}</h1>
        <p>{text.returnNotFound}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      <PageMeta title={text.yourOrder} />
      <meta name="robots" content="noindex" />
      {/* The order and payment ids are in the URL: never send them on. */}
      <meta name="referrer" content="no-referrer" />
      <div className="flex max-w-2xl flex-col items-start gap-4">
        <Outcome view={view} />
        {view.error ? (
          <p role="alert" className="notice notice-danger">
            {messageForCode(view.error)}
          </p>
        ) : null}
        {view.outcome === 'waiting' || view.outcome === 'unknown' ? (
          <Link to={returnPath(view.orderId, view.paymentId)} className="btn btn-secondary">
            {text.checkAgain}
          </Link>
        ) : null}
        {view.outcome === 'failed' && view.paymentId ? (
          <fetcher.Form method="post" className="flex flex-col gap-3">
            <input type="hidden" name="orderId" value={view.orderId} />
            <input type="hidden" name="paymentId" value={view.paymentId} />
            <FormMessage state={fetcher.data} />
            <SubmitButton busy={fetcher.state !== 'idle'} busyText={text.starting}>
              {text.tryAgain}
            </SubmitButton>
          </fetcher.Form>
        ) : null}
        {view.link ? (
          <Link to={view.link} className="font-medium underline underline-offset-4">
            {text.viewOrder}
          </Link>
        ) : null}
      </div>
      {view.order ? <OrderLines order={view.order} /> : null}
    </div>
  );
}
