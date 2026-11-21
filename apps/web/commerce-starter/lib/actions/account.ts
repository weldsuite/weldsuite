'use server';

import { isStorefrontError } from '@weldsuite/commerce-sdk';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requestOptions, storefront } from '../commerce';
import { getSessionToken } from '../data';
import { describeError } from '../errors';
import { clearShopperToken, getCartToken, getShopperToken, setCartToken, setShopperToken } from '../session';
import { safePath, text, type FormState } from './state';

export interface SignInState extends FormState {
  step: 'email' | 'code';
  email?: string;
  next?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Passwordless sign-in, one action for both steps: without a `code` it
 * emails one, with a `code` it checks it.
 */
export async function signInAction(prev: SignInState, form: FormData): Promise<SignInState> {
  return form.has('code') ? verifyCode(prev, form) : requestCode(prev, form);
}

/** Sign-in step 1: email a code. The email stays in the form, not in the URL. */
async function requestCode(_prev: SignInState, form: FormData): Promise<SignInState> {
  const email = text(form, 'email');
  const next = safePath(text(form, 'next'), '/account');
  if (!EMAIL.test(email)) {
    return { status: 'error', step: 'email', next, message: 'Enter your email address.', fieldErrors: { email: 'Enter an email address like name@example.com' } };
  }
  try {
    await storefront().auth.requestCode(email, await requestOptions());
    return { status: 'success', step: 'code', email, next, message: `We sent a 6-digit code to ${email}.` };
  } catch (error) {
    return { status: 'error', step: 'email', email, next, message: describeError(error) };
  }
}

/** Sign-in step 2: check the code and keep the session in a cookie. */
async function verifyCode(_prev: SignInState, form: FormData): Promise<SignInState> {
  const email = text(form, 'email');
  const code = text(form, 'code').replace(/\s/g, '');
  const next = safePath(text(form, 'next'), '/account');
  if (!/^\d{6}$/.test(code)) {
    return { status: 'error', step: 'code', email, next, message: 'Enter the 6 digits from the email.', fieldErrors: { code: 'Six digits' } };
  }
  try {
    const session = await storefront().auth.verify(email, code, await requestOptions());
    await setShopperToken(session.sessionToken, session.expiresAt);
    // Reading the cart with the session attaches it to the shopper.
    const cartToken = await getCartToken();
    if (cartToken) {
      await storefront()
        .cart.get(cartToken, { ...(await requestOptions()), shopperToken: session.sessionToken })
        .catch(() => undefined);
    }
  } catch (error) {
    if (isStorefrontError(error, 'INVALID_CODE')) {
      const left = error.details?.attemptsLeft;
      return {
        status: 'error',
        step: 'code',
        email,
        next,
        message: typeof left === 'number' ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : describeError(error),
        fieldErrors: { code: 'Not right' },
      };
    }
    if (isStorefrontError(error, 'CODE_EXPIRED')) {
      return { status: 'error', step: 'email', email, next, message: describeError(error) };
    }
    return { status: 'error', step: 'code', email, next, message: describeError(error) };
  }
  revalidatePath('/', 'layout');
  redirect(next);
}

export async function signOutAction(): Promise<void> {
  const token = await getShopperToken();
  if (token) await storefront().auth.signOut(token, await requestOptions()).catch(() => undefined);
  await clearShopperToken();
  revalidatePath('/', 'layout');
  redirect('/');
}

async function requireSession(): Promise<string> {
  const token = await getSessionToken();
  if (!token) redirect('/account/sign-in');
  return token;
}

export async function updateProfileAction(_prev: FormState, form: FormData): Promise<FormState> {
  const token = await requireSession();
  try {
    await storefront().account.update(
      token,
      {
        firstName: text(form, 'firstName') || null,
        lastName: text(form, 'lastName') || null,
        phone: text(form, 'phone') || null,
      },
      await requestOptions(),
    );
    revalidatePath('/account');
    return { status: 'success', message: 'Your details are saved.' };
  } catch (error) {
    return { status: 'error', message: describeError(error) };
  }
}

export async function selectCompanyAction(_prev: FormState, form: FormData): Promise<FormState> {
  const token = await requireSession();
  const companyId = text(form, 'companyId');
  if (!companyId) return { status: 'error', message: 'Choose a company.' };
  try {
    await storefront().account.selectCompany(token, companyId, await requestOptions());
    revalidatePath('/', 'layout');
    return { status: 'success', message: 'You are now buying for this company.' };
  } catch (error) {
    return { status: 'error', message: describeError(error) };
  }
}

export interface ReorderState extends FormState {
  problems?: Array<{ sku: string | null; message: string }>;
}

/** Order page: put the order's lines in the cart again. */
export async function reorderAction(_prev: ReorderState, form: FormData): Promise<ReorderState> {
  const token = await requireSession();
  const orderId = text(form, 'orderId');
  let goToCart = false;
  try {
    const options = await requestOptions();
    const cartToken = await getCartToken();
    let result;
    try {
      result = await storefront().orders.reorder(token, orderId, { ...options, cartToken });
    } catch (error) {
      if (!cartToken || !isStorefrontError(error, 'CART_NOT_FOUND', 'CART_NOT_OPEN')) throw error;
      result = await storefront().orders.reorder(token, orderId, options);
    }
    if (result.cartToken) await setCartToken(result.cartToken);
    revalidatePath('/', 'layout');
    if (result.problems.length > 0) {
      return {
        status: 'error',
        message: 'Some items could not be added again. The rest are in your cart.',
        problems: result.problems.map((p) => ({ sku: p.sku, message: p.message })),
      };
    }
    goToCart = true;
  } catch (error) {
    return { status: 'error', message: describeError(error) };
  }
  if (goToCart) redirect('/cart');
  return { status: 'idle' };
}

/** Approvals: approve or reject a company order. */
export async function decideApprovalAction(_prev: FormState, form: FormData): Promise<FormState> {
  const token = await requireSession();
  const orderId = text(form, 'orderId');
  const decision = text(form, 'decision');
  const comment = text(form, 'comment') || undefined;
  if (decision !== 'approve' && decision !== 'reject') return { status: 'error', message: 'Choose approve or reject.' };
  let orderNumber: string;
  try {
    const order =
      decision === 'approve'
        ? await storefront().approvals.approve(token, orderId, { comment }, await requestOptions())
        : await storefront().approvals.reject(token, orderId, { comment }, await requestOptions());
    orderNumber = order.orderNumber;
  } catch (error) {
    return { status: 'error', message: describeError(error) };
  }
  // The order leaves the list, so the confirmation goes on the page.
  revalidatePath('/account/approvals');
  redirect(`/account/approvals?${decision === 'approve' ? 'approved' : 'rejected'}=${encodeURIComponent(orderNumber)}`);
}
