/** Shopper sign-in (an emailed code), account details, reorder and B2B approvals. */

import { createServerFn } from '@tanstack/react-start';
import { isStorefrontError, type SignInLocale } from '@weldsuite/commerce-sdk';
import { format, plural } from '@weldsuite/storefront-theme';
import { safePath, withQuery } from '../../paths';
import { clearPendingSignIn, clearShopperToken, getCartToken, getPendingSignIn, getShopperToken, setCartToken, setPendingSignIn, setShopperToken } from '../session';
import { sessionToken, shopRequest, type ShopRequest } from '../shop';
import { problemRows } from './problems';
import { failed, failedWith, field, formData, go, localeOf, stringsFor, succeeded } from './respond';

/** The sign-in email's language: the shop's when WeldCommerce writes it (en, nl), else English. */
export function emailLocale(locale: string): SignInLocale {
  return locale === 'nl' ? 'nl' : 'en';
}

/** Something like name@example.com: one @, no spaces, a dot inside the domain. */
export function looksLikeEmail(value: string): boolean {
  if (/\s/.test(value) || value.length > 254) return false;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return false;
  return value.slice(at + 2, -1).includes('.');
}

/** Sign-in step 1: email a code. The email is kept in a short-lived httpOnly cookie, not the URL. */
export const requestCode = createServerFn({ method: 'POST' })
  .validator(formData)
  .handler(async ({ data: form }) => {
    const shop = await shopRequest();
    const s = stringsFor(shop.site.locale);
    const email = field(form, 'email');
    const next = safePath(field(form, 'next'), '/account');
    const back = withQuery('/account', { next: next === '/account' ? null : next });
    if (!looksLikeEmail(email)) return failed(back, 'EMAIL_INVALID', s.errors.local.EMAIL_INVALID, { fieldErrors: { email: s.errors.local.EMAIL_INVALID } });
    try {
      await shop.client.auth.requestCode(email, { locale: emailLocale(shop.site.locale), ...shop.options });
      setPendingSignIn(email, shop.https);
      return succeeded(back, { ok: true, message: format(s.account.codeSent, { email }) });
    } catch (error) {
      return failedWith(back, s, error);
    }
  });

/** Sign-in step 2: check the code; the session goes in an httpOnly cookie, the cart is attached to it. */
export const verifyCode = createServerFn({ method: 'POST' })
  .validator(formData)
  .handler(async ({ data: form }) => {
    const shop = await shopRequest();
    const s = stringsFor(shop.site.locale);
    const email = getPendingSignIn() ?? field(form, 'email');
    const code = field(form, 'code').replace(/\s/g, '');
    const next = safePath(field(form, 'next'), '/account');
    const back = withQuery('/account', { next: next === '/account' ? null : next });
    if (!email) return failed(back, 'CODE_EXPIRED', s.errors.codes.CODE_EXPIRED);
    if (!/^\d{6}$/.test(code)) return failed(back, 'CODE_FORMAT', s.errors.local.CODE_FORMAT, { fieldErrors: { code: s.errors.local.CODE_FORMAT } });
    try {
      const session = await shop.client.auth.verify(email, code, shop.options);
      setShopperToken(session.sessionToken, session.expiresAt, shop.https);
      clearPendingSignIn(shop.https);
      // Reading the cart with the session attaches it to the shopper.
      const cartToken = getCartToken();
      if (cartToken) await shop.client.cart.get(cartToken, { ...shop.options, shopperToken: session.sessionToken }).catch(() => undefined);
    } catch (error) {
      if (isStorefrontError(error, 'INVALID_CODE') && typeof error.details?.attemptsLeft === 'number') {
        const message = plural(localeOf(shop.site.locale), s.account.attemptsLeft, error.details.attemptsLeft);
        return failed(back, 'INVALID_CODE', message, { fieldErrors: { code: message } });
      }
      if (isStorefrontError(error, 'CODE_EXPIRED')) clearPendingSignIn(shop.https);
      return failedWith(back, s, error);
    }
    return go(next);
  });

/** Back to step 1, for another email address. */
export const restartSignIn = createServerFn({ method: 'POST' })
  .validator(formData)
  .handler(async () => {
    const shop = await shopRequest();
    clearPendingSignIn(shop.https);
    return succeeded('/account');
  });

export const signOut = createServerFn({ method: 'POST' })
  .validator(formData)
  .handler(async () => {
    const shop = await shopRequest();
    const token = getShopperToken();
    if (token) await shop.client.auth.signOut(token, shop.options).catch(() => undefined);
    clearShopperToken(shop.https);
    return go('/');
  });

async function requireSession(shop: ShopRequest, back: string): Promise<string> {
  return (await sessionToken(shop)) ?? go(withQuery('/account', { next: back }));
}

export const updateProfile = createServerFn({ method: 'POST' })
  .validator(formData)
  .handler(async ({ data: form }) => {
    const shop = await shopRequest();
    const s = stringsFor(shop.site.locale);
    const token = await requireSession(shop, '/account');
    try {
      await shop.client.account.update(
        token,
        { firstName: field(form, 'firstName') || null, lastName: field(form, 'lastName') || null, phone: field(form, 'phone') || null },
        shop.options,
      );
      return succeeded('/account', { ok: true, message: s.account.profileSaved });
    } catch (error) {
      return failedWith('/account', s, error);
    }
  });

export const selectCompany = createServerFn({ method: 'POST' })
  .validator(formData)
  .handler(async ({ data: form }) => {
    const shop = await shopRequest();
    const s = stringsFor(shop.site.locale);
    const token = await requireSession(shop, '/account');
    const companyId = field(form, 'companyId');
    if (!companyId) return failed('/account', 'CHOOSE_COMPANY', s.errors.local.CHOOSE_COMPANY);
    try {
      await shop.client.account.selectCompany(token, companyId, shop.options);
      return succeeded('/account', { ok: true, message: s.account.companySelected });
    } catch (error) {
      return failedWith('/account', s, error);
    }
  });

/** Order page: put the order's lines in the cart again. */
export const reorder = createServerFn({ method: 'POST' })
  .validator(formData)
  .handler(async ({ data: form }) => {
    const shop = await shopRequest();
    const s = stringsFor(shop.site.locale);
    const orderId = field(form, 'orderId');
    const back = `/account/orders/${encodeURIComponent(orderId)}`;
    const token = await requireSession(shop, back);
    try {
      const cartToken = getCartToken();
      let result;
      try {
        result = await shop.client.orders.reorder(token, orderId, { ...shop.options, cartToken });
      } catch (error) {
        if (!cartToken || !isStorefrontError(error, 'CART_NOT_FOUND', 'CART_NOT_OPEN')) throw error;
        result = await shop.client.orders.reorder(token, orderId, shop.options);
      }
      if (result.cartToken) setCartToken(result.cartToken, shop.https);
      if (result.problems.length === 0) return go('/cart');
      const rows = problemRows(result.problems);
      if (rows.every((row) => row.added)) return succeeded('/cart', { ok: true, message: s.order.reordered, problems: rows });
      return failed(back, 'REORDER_PROBLEMS', s.order.reorderProblems, { problems: rows });
    } catch (error) {
      return failedWith(back, s, error);
    }
  });

/** Approvals: approve or reject a company order. */
export const decideApproval = createServerFn({ method: 'POST' })
  .validator(formData)
  .handler(async ({ data: form }) => {
    const shop = await shopRequest();
    const s = stringsFor(shop.site.locale);
    const back = '/account/approvals';
    const token = await requireSession(shop, back);
    const orderId = field(form, 'orderId');
    const decision = field(form, 'decision');
    const comment = field(form, 'comment').slice(0, 2000) || undefined;
    if (decision !== 'approve' && decision !== 'reject') return failed(back, 'CHOOSE_DECISION', s.errors.local.CHOOSE_DECISION);
    let query: Record<string, string>;
    try {
      const options = { comment, ...shop.options };
      const order = decision === 'approve' ? await shop.client.approvals.approve(token, orderId, options) : await shop.client.approvals.reject(token, orderId, options);
      query = { [decision === 'approve' ? 'approved' : 'rejected']: order.orderNumber, ...(order.payment ? { payment: 'sent' } : {}) };
    } catch (error) {
      return failedWith(back, s, error);
    }
    // The order leaves the list, so the confirmation goes on the page.
    return go(withQuery(back, query));
  });
