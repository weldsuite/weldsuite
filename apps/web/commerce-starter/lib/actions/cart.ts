'use server';

import { isStorefrontError, type Cart, type CartItemInput } from '@weldsuite/commerce-sdk';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requestOptions, storefront } from '../commerce';
import { getSessionToken } from '../data';
import { describeError, discountReason } from '../errors';
import { getCartToken, setCartToken } from '../session';
import { problemRows, text, wholeNumber, type FormState, type ProblemRow } from './state';

async function cartOptions() {
  return { ...(await requestOptions()), shopperToken: await getSessionToken() };
}

/**
 * Add `item` to the shopper's cart, or start a cart with it when there is
 * none (or the old one was checked out or expired).
 */
async function addToCart(item: CartItemInput): Promise<Cart> {
  const options = await cartOptions();
  const token = await getCartToken();
  if (token) {
    try {
      return await storefront().cart.addItem(token, item, options);
    } catch (error) {
      if (!isStorefrontError(error, 'CART_NOT_FOUND', 'CART_NOT_OPEN')) throw error;
    }
  }
  const created = await storefront().cart.create({ items: [item], ...options });
  await setCartToken(created.cartToken);
  return created.cart;
}

/** Product page: add the chosen variant (picked by its option values) to the cart. */
export async function addItemAction(_prev: FormState, form: FormData): Promise<FormState> {
  const productId = text(form, 'productId');
  const quantity = wholeNumber(form, 'quantity', 1, 999);
  if (!productId) return { status: 'error', message: 'Choose a product.' };
  if (quantity === null) {
    return { status: 'error', message: 'Enter a quantity from 1 to 999.', fieldErrors: { quantity: 'From 1 to 999' } };
  }
  try {
    const product = await storefront().products.get(productId, await requestOptions());
    let item: CartItemInput = { productId: product.id, quantity };
    if (product.variants.length > 0) {
      const missing = product.options.find((option) => !text(form, `option:${option.name}`));
      if (missing) return { status: 'error', message: `Choose a ${missing.name.toLowerCase()}.` };
      const variant = product.variants.find((v) =>
        product.options.every((option) => v.optionValues[option.name] === text(form, `option:${option.name}`)),
      );
      if (!variant) return { status: 'error', message: 'That combination is not available.' };
      if (!variant.available) return { status: 'error', message: 'That option is sold out.' };
      item = { variantId: variant.id, quantity };
    }
    const cart = await addToCart(item);
    revalidatePath('/', 'layout');
    return { status: 'success', message: `Added to your cart. You have ${cart.itemCount} ${cart.itemCount === 1 ? 'item' : 'items'} in it.` };
  } catch (error) {
    return { status: 'error', message: describeError(error) };
  }
}

/** Cart page: back to the cart with an error code to show. */
function backToCart(error: unknown): never {
  const code = isStorefrontError(error) ? error.code : 'UNKNOWN';
  if (!isStorefrontError(error)) console.error('[cart]', error);
  redirect(`/cart?error=${encodeURIComponent(code)}`);
}

/** Cart page: set a line's quantity (the −/+ buttons send `set`, the field sends `quantity`). */
export async function updateLineAction(form: FormData): Promise<void> {
  const token = await getCartToken();
  const lineId = text(form, 'lineId');
  const quantity = form.has('set') ? wholeNumber(form, 'set', 0, 999) : wholeNumber(form, 'quantity', 0, 999);
  if (!token || !lineId) redirect('/cart');
  if (quantity === null) redirect('/cart?error=QUANTITY');
  try {
    await storefront().cart.updateItem(token, lineId, quantity, await cartOptions());
  } catch (error) {
    backToCart(error);
  }
  revalidatePath('/', 'layout');
}

export async function removeLineAction(form: FormData): Promise<void> {
  const token = await getCartToken();
  const lineId = text(form, 'lineId');
  if (!token || !lineId) redirect('/cart');
  try {
    await storefront().cart.removeItem(token, lineId, await cartOptions());
  } catch (error) {
    backToCart(error);
  }
  revalidatePath('/', 'layout');
}

export async function applyDiscountAction(_prev: FormState, form: FormData): Promise<FormState> {
  const token = await getCartToken();
  const code = text(form, 'code');
  if (!token) return { status: 'error', message: 'Your cart is empty.' };
  if (!code) return { status: 'error', message: 'Enter a discount code.', fieldErrors: { code: 'Required' } };
  try {
    const cart = await storefront().cart.applyDiscount(token, code, await cartOptions());
    revalidatePath('/', 'layout');
    if (cart.discountProblem) return { status: 'error', message: discountReason(cart.discountProblem) };
    return { status: 'success', message: `Discount code ${cart.discount?.code ?? code} applied.` };
  } catch (error) {
    return { status: 'error', message: describeError(error), fieldErrors: { code: describeError(error) } };
  }
}

export async function removeDiscountAction(): Promise<void> {
  const token = await getCartToken();
  if (!token) redirect('/cart');
  try {
    await storefront().cart.removeDiscount(token, await cartOptions());
  } catch (error) {
    backToCart(error);
  }
  revalidatePath('/', 'layout');
}

const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char);

/**
 * Accept "SKU quantity", "SKU;quantity" and tab-separated lines (pasted from
 * a spreadsheet) too: the API reads "SKU,quantity". The first `;` or tab
 * becomes a comma, or else the last run of spaces, whichever comes first.
 */
function toCsvLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.includes(',')) return trimmed;
  const separators = [trimmed.indexOf(';'), trimmed.indexOf('\t')].filter((at) => at >= 0);
  const separator = separators.length > 0 ? Math.min(...separators) : -1;
  // The last run of whitespace: [runStart, runEnd].
  let runEnd = trimmed.length - 1;
  while (runEnd >= 0 && !isSpace(trimmed[runEnd])) runEnd -= 1;
  let runStart = runEnd;
  while (runStart > 0 && isSpace(trimmed[runStart - 1])) runStart -= 1;
  if (separator >= 0 && (runEnd < 0 || separator <= runStart)) {
    return `${trimmed.slice(0, separator)},${trimmed.slice(separator + 1)}`;
  }
  if (runEnd >= 0) return `${trimmed.slice(0, runStart)},${trimmed.slice(runEnd + 1)}`;
  return trimmed;
}

/** Quick order: SKUs and quantities pasted or uploaded as CSV. */
export interface QuickOrderState extends FormState {
  added?: number;
  problems?: ProblemRow[];
}

/** What the shopper pasted, or the uploaded file; untrimmed, so line numbers stay right. */
async function pastedCsv(form: FormData): Promise<string | QuickOrderState> {
  const file = form.get('file');
  if (file instanceof File && file.size > 0) {
    if (file.size > 200_000) return { status: 'error', message: 'The file is too large (at most 200 KB).' };
    return await file.text();
  }
  const pasted = form.get('csv');
  return typeof pasted === 'string' ? pasted : '';
}

function quickOrderMessage(rows: ProblemRow[], itemCount: number): string {
  if (rows.length === 0) return `Added. Your cart now has ${itemCount} items.`;
  if (rows.every((row) => row.added)) {
    return `Added. Some items have fewer in stock than you asked for. Your cart now has ${itemCount} items.`;
  }
  return `Some lines could not be added. Your cart now has ${itemCount} items.`;
}

export async function quickOrderAction(_prev: QuickOrderState, form: FormData): Promise<QuickOrderState> {
  const csv = await pastedCsv(form);
  if (typeof csv !== 'string') return csv;
  // Blank lines stay: the API reports problems by line number.
  const lines = csv.split(/\r?\n/);
  const filled = lines.filter((line) => line.trim() !== '').length;
  if (filled === 0) {
    return { status: 'error', message: 'Paste or upload at least one line: SKU,quantity.', fieldErrors: { csv: 'Required' } };
  }
  if (filled > 500) return { status: 'error', message: 'At most 500 lines at a time.' };
  const normalised = lines.map(toCsvLine).join('\n');
  try {
    const options = await cartOptions();
    const token = await getCartToken();
    let result;
    try {
      result = await storefront().cart.quickOrder({ csv: normalised }, { ...options, cartToken: token });
    } catch (error) {
      if (!token || !isStorefrontError(error, 'CART_NOT_FOUND', 'CART_NOT_OPEN')) throw error;
      result = await storefront().cart.quickOrder({ csv: normalised }, options);
    }
    if (result.cartToken) await setCartToken(result.cartToken);
    revalidatePath('/', 'layout');
    const rows = problemRows(result.problems);
    return {
      status: rows.every((row) => row.added) ? 'success' : 'error',
      message: quickOrderMessage(rows, result.cart.itemCount),
      added: result.cart.itemCount,
      problems: rows,
    };
  } catch (error) {
    return { status: 'error', message: describeError(error) };
  }
}
