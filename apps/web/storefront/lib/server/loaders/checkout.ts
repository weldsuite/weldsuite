/** Loaders of checkout, the Mollie return page and a guest's order page. */

import { notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import {
  createIdempotencyKey,
  isStorefrontError,
  type Cart,
  type PaymentInfo,
  type PaymentMethod,
  type ShippingRateOffer,
  type StorefrontOrder,
} from '@weldsuite/commerce-sdk';
import { format, t } from '@weldsuite/storefront-theme';
import { z } from 'zod';
import { buyingClosed, catalogueClosed } from '../../access';
import { withQuery } from '../../paths';
import { makeHead, type PageHead } from '../../seo';
import { headContext } from '../head';
import { getCartToken, getCheckoutState } from '../session';
import { activeCompany, currentCart, currentShopper, sessionToken, shopRequest, type ShopRequest } from '../shop';

export interface CheckoutView {
  /** What stands between the shopper and paying: signing in, or choosing a company. */
  gate: 'sign-in' | 'company' | null;
  cart: Cart;
  /** The countries the channel ships to (ISO-2). */
  countries: string[];
  rates: ShippingRateOffer[];
  methods: PaymentMethod[];
  company: { name: string; spendLimit: string | null; currency: string | null } | null;
  b2b: boolean;
  email: string | null;
  idempotencyKey: string;
  head: PageHead;
}

export const getCheckoutPage = createServerFn({ method: 'GET' }).handler(async (): Promise<CheckoutView> => {
  const shop = await shopRequest();
  const shopper = await currentShopper(shop);
  const access = shop.doc.settings.access;
  if (catalogueClosed(access, shopper !== null) || buyingClosed(access, shopper !== null)) {
    throw redirect({ href: withQuery('/account', { next: '/checkout' }) });
  }
  const cart = await currentCart(shop);
  if (!cart || cart.items.length === 0) throw redirect({ href: '/cart' });
  const channel = await shop.client.channel.get(shop.options);
  const company = activeCompany(shopper);
  const b2b = channel.audience === 'b2b';
  const head = makeHead(headContext(shop), { title: t(shop.site.locale).checkout.title, path: '/checkout', personal: true });
  const gate = (!channel.guestCheckout || b2b) && !shopper ? 'sign-in' : b2b && !company ? 'company' : null;
  const token = getCartToken();
  const rates =
    gate === null && cart.shippingAddress && token
      ? await shop.client.cart.shippingRates(token, { ...shop.options, shopperToken: await sessionToken(shop) })
      : [];
  // Pay on invoice is for a B2B buyer buying for a company.
  const methods = channel.paymentMethods.filter((method) => method === 'mollie' || (method === 'invoice' && b2b && company !== null));
  return {
    gate,
    cart,
    countries: channel.sellingCountries,
    rates,
    methods,
    company: company ? { name: company.name, spendLimit: company.spendLimit, currency: company.currency } : null,
    b2b,
    email: cart.email ?? shopper?.email ?? null,
    idempotencyKey: createIdempotencyKey(),
    head,
  };
});

/** How a checkout ended: placed (no payment), paid, still waiting, failed, or unknown (unreadable). */
export type Outcome = 'placed' | 'paid' | 'waiting' | 'failed' | 'unknown';

export interface ReturnView {
  found: boolean;
  orderId: string;
  paymentId: string | null;
  payment: PaymentInfo | null;
  order: StorefrontOrder | null;
  link: string | null;
  outcome: Outcome;
  number: string;
  method: 'mollie' | 'invoice';
  error: string | null;
  head: PageHead;
}

function outcomeOf(paymentId: string | null, payment: PaymentInfo | null): Outcome {
  if (!paymentId) return 'placed';
  if (!payment) return 'unknown';
  if (payment.status === 'paid' || payment.status === 'authorized') return 'paid';
  if (payment.status === 'open' || payment.status === 'pending') return 'waiting';
  return 'failed';
}

async function loadPayment(shop: ShopRequest, paymentId: string | null): Promise<PaymentInfo | null> {
  if (!paymentId) return null;
  try {
    return await shop.client.payments.get(paymentId, shop.options);
  } catch (error) {
    if (!isStorefrontError(error)) throw error;
    return null;
  }
}

async function loadOrder(shop: ShopRequest, orderId: string, orderToken: string | null): Promise<StorefrontOrder | null> {
  const session = await sessionToken(shop);
  try {
    if (session) return await shop.client.orders.get(session, orderId, shop.options);
    if (orderToken) return await shop.client.orders.getGuest(orderId, orderToken, shop.options);
  } catch (error) {
    if (!isStorefrontError(error)) throw error;
  }
  return null;
}

/**
 * Where Mollie sends the shopper back (`?order=…&payment=…`), and the
 * confirmation of an order on invoice. Coming back never marks anything paid:
 * the payment is read back through the API. The checkout cookie holds a
 * guest's order token; without it or a payment of this order there is nothing to show.
 */
export const getCheckoutReturn = createServerFn({ method: 'GET' })
  .validator(z.object({ order: z.string().max(100).optional(), payment: z.string().max(100).optional(), error: z.string().max(60).optional() }))
  .handler(async ({ data: input }): Promise<ReturnView> => {
    const shop = await shopRequest();
    const head = makeHead(headContext(shop), { title: t(shop.site.locale).orderReturn.title, personal: true });
    const orderId = input.order ?? '';
    const empty: ReturnView = { found: false, orderId, paymentId: null, payment: null, order: null, link: null, outcome: 'unknown', number: '', method: 'mollie', error: input.error ?? null, head };
    if (!orderId) return empty;
    const state = getCheckoutState();
    const own = state?.orderId === orderId ? state : undefined;
    const paymentId = input.payment ?? own?.paymentId ?? null;
    const read = await loadPayment(shop, paymentId);
    // A payment of another order (a copied or edited link) counts as none.
    const payment = read?.orderId === orderId ? read : null;
    if (!own && !payment) return empty;
    const signedIn = Boolean(await sessionToken(shop));
    const orderToken = own?.orderToken ?? null;
    const order = await loadOrder(shop, orderId, orderToken);
    const link = signedIn
      ? `/account/orders/${encodeURIComponent(orderId)}`
      : orderToken
        ? withQuery(`/orders/${encodeURIComponent(orderId)}`, { token: orderToken })
        : null;
    return {
      found: true,
      orderId,
      paymentId,
      payment,
      order,
      link,
      outcome: outcomeOf(paymentId, payment),
      number: payment?.orderNumber ?? order?.orderNumber ?? own?.orderNumber ?? '',
      method: own?.paymentMethod ?? (paymentId ? 'mollie' : 'invoice'),
      error: input.error ?? null,
      head,
    };
  });

/** A guest's order, by the link in the confirmation email (`/orders/<id>?token=…`). */
export const getGuestOrder = createServerFn({ method: 'GET' })
  .validator(z.object({ id: z.string().min(1).max(100), token: z.string().max(200).optional() }))
  .handler(async ({ data: input }): Promise<{ order: StorefrontOrder; head: PageHead }> => {
    const shop = await shopRequest();
    const s = t(shop.site.locale);
    if (!input.token) throw notFound();
    try {
      const order = await shop.client.orders.getGuest(input.id, input.token, shop.options);
      return { order, head: makeHead(headContext(shop), { title: format(s.order.title, { number: order.orderNumber }), personal: true }) };
    } catch (error) {
      if (isStorefrontError(error, 'NOT_FOUND', 'VALIDATION_ERROR')) throw notFound();
      throw error;
    }
  });
