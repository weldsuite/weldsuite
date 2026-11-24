/** Loaders of the account pages, quick order and approvals. */

import { notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { isStorefrontError, type Approval, type Page, type Shopper, type StorefrontOrder } from '@weldsuite/commerce-sdk';
import { format, t, type ShopAccess } from '@weldsuite/storefront-theme';
import { z } from 'zod';
import { safePath, withQuery } from '../../paths';
import { makeHead, type PageHead } from '../../seo';
import { headContext } from '../head';
import { getPendingSignIn } from '../session';
import { activeCompany, currentShopper, sessionToken, shopRequest, type ShopRequest } from '../shop';

export type AccountView =
  | { signedIn: false; step: 'email' | 'code'; email: string | null; next: string; reason: 'shop' | 'prices' | null; head: PageHead }
  | { signedIn: true; shopper: Shopper; orders: StorefrontOrder[]; b2b: boolean; head: PageHead };

/** Why signing in is needed: the shop is for signed-in buyers only, or shows them alone its prices. */
function signInReason(access: ShopAccess): 'shop' | 'prices' | null {
  if (access === 'signed_in') return 'shop';
  if (access === 'prices_signed_in') return 'prices';
  return null;
}

export const getAccountPage = createServerFn({ method: 'GET' })
  .validator(z.object({ next: z.string().max(500).optional() }))
  .handler(async ({ data: input }): Promise<AccountView> => {
    const shop = await shopRequest();
    const s = t(shop.site.locale);
    const shopper = await currentShopper(shop);
    if (!shopper) {
      const pending = getPendingSignIn() ?? null;
      return {
        signedIn: false,
        step: pending ? 'code' : 'email',
        email: pending,
        next: safePath(input.next, '/account'),
        reason: signInReason(shop.doc.settings.access),
        head: makeHead(headContext(shop), { title: s.account.signInTitle, personal: true }),
      };
    }
    const token = await sessionToken(shop);
    const orders = token ? await shop.client.orders.list(token, { ...shop.options, limit: 5 }).catch(() => ({ data: [] as StorefrontOrder[] })) : { data: [] };
    return {
      signedIn: true,
      shopper,
      orders: orders.data,
      b2b: shop.site.channel.audience === 'b2b',
      head: makeHead(headContext(shop), { title: s.account.title, personal: true }),
    };
  });

async function requireSession(shop: ShopRequest, path: string): Promise<string> {
  const token = await sessionToken(shop);
  if (!token) throw redirect({ href: withQuery('/account', { next: path }) });
  return token;
}

export const getOrdersPage = createServerFn({ method: 'GET' })
  .validator(z.object({ cursor: z.string().max(500).optional() }))
  .handler(async ({ data: input }): Promise<{ page: Page<StorefrontOrder>; cursor: string | null; head: PageHead }> => {
    const shop = await shopRequest();
    const token = await requireSession(shop, '/account/orders');
    let page: Page<StorefrontOrder>;
    try {
      page = await shop.client.orders.list(token, { ...shop.options, limit: 25, ...(input.cursor ? { cursor: input.cursor } : {}) });
    } catch (error) {
      if (!input.cursor || !isStorefrontError(error, 'INVALID_CURSOR')) throw error;
      page = await shop.client.orders.list(token, { ...shop.options, limit: 25 });
    }
    return { page, cursor: input.cursor ?? null, head: makeHead(headContext(shop), { title: t(shop.site.locale).account.orders, personal: true }) };
  });

export const getOrderPage = createServerFn({ method: 'GET' })
  .validator(z.object({ id: z.string().min(1).max(100) }))
  .handler(async ({ data: input }): Promise<{ order: StorefrontOrder; head: PageHead }> => {
    const shop = await shopRequest();
    const token = await requireSession(shop, `/account/orders/${encodeURIComponent(input.id)}`);
    try {
      const order = await shop.client.orders.get(token, input.id, shop.options);
      return { order, head: makeHead(headContext(shop), { title: format(t(shop.site.locale).order.title, { number: order.orderNumber }), personal: true }) };
    } catch (error) {
      if (isStorefrontError(error, 'NOT_FOUND')) throw notFound();
      throw error;
    }
  });

/** Quick order and approvals exist on B2B channels only. */
async function requireB2b(shop: ShopRequest): Promise<void> {
  if (shop.site.channel.audience !== 'b2b') throw notFound();
}

export const getQuickOrderPage = createServerFn({ method: 'GET' }).handler(async (): Promise<{ head: PageHead }> => {
  const shop = await shopRequest();
  await requireB2b(shop);
  await requireSession(shop, '/quick-order');
  return { head: makeHead(headContext(shop), { title: t(shop.site.locale).b2b.quickOrderTitle, personal: true }) };
});

export interface ApprovalsView {
  approvals: Approval[];
  /** The shopper may not decide (not an approver or admin of the active company). */
  refused: string | null;
  company: string | null;
  head: PageHead;
}

export const getApprovalsPage = createServerFn({ method: 'GET' }).handler(async (): Promise<ApprovalsView> => {
  const shop = await shopRequest();
  await requireB2b(shop);
  const token = await requireSession(shop, '/account/approvals');
  const s = t(shop.site.locale);
  const head = makeHead(headContext(shop), { title: s.b2b.approvalsTitle, personal: true });
  const company = activeCompany(await currentShopper(shop))?.name ?? null;
  try {
    return { approvals: await shop.client.approvals.list(token, shop.options), refused: null, company, head };
  } catch (error) {
    if (isStorefrontError(error, 'NOT_AN_APPROVER', 'COMPANY_REQUIRED')) return { approvals: [], refused: error.code, company, head };
    throw error;
  }
});
