/** Cart writes: add to cart, quantities, discount codes, quick order. */

import { createServerFn } from '@tanstack/react-start';
import { isStorefrontError, type Cart, type CartItemInput } from '@weldsuite/commerce-sdk';
import { discountReason, format, plural } from '@weldsuite/storefront-theme';
import { buyingClosed } from '../../access';
import { getCartToken, setCartToken } from '../session';
import { cartOptions, currentShopper, shopRequest, type ShopRequest } from '../shop';
import { backPath, failed, failedWith, field, formData, localeOf, stringsFor, succeeded, wholeNumber } from './respond';
import { problemRows, toCsvLine } from './problems';

/** Adds `item` to the shopper's cart, or starts one with it (none yet, or the old one was checked out or expired). */
async function addToCart(shop: ShopRequest, item: CartItemInput): Promise<Cart> {
  const options = await cartOptions(shop);
  const token = getCartToken();
  if (token) {
    try {
      return await shop.client.cart.addItem(token, item, options);
    } catch (error) {
      if (!isStorefrontError(error, 'CART_NOT_FOUND', 'CART_NOT_OPEN')) throw error;
    }
  }
  const created = await shop.client.cart.create({ items: [item], ...options });
  setCartToken(created.cartToken, shop.https);
  return created.cart;
}

/** Product page: add the chosen variant (by its option values) to the cart. */
export const addItem = createServerFn({ method: 'POST' })
  .validator(formData)
  .handler(async ({ data: form }) => {
    const shop = await shopRequest();
    const s = stringsFor(shop.site.locale);
    const back = backPath(form, '/products');
    if (buyingClosed(shop.doc.settings.access, Boolean(await currentShopper(shop)))) {
      return failed(back, 'SESSION_REQUIRED', s.errors.codes.SESSION_REQUIRED);
    }
    const productId = field(form, 'productId');
    const quantity = wholeNumber(form, 'quantity', 1, 999);
    if (!productId) return failed(back, 'NOT_FOUND', s.product.notFound);
    if (quantity === null) return failed(back, 'QUANTITY', s.errors.local.QUANTITY, { fieldErrors: { quantity: s.errors.local.QUANTITY } });
    try {
      const product = await shop.client.products.get(productId, shop.options);
      let item: CartItemInput = { productId: product.id, quantity };
      if (product.variants.length > 0) {
        const missing = product.options.find((option) => !field(form, `option:${option.name}`));
        if (missing) return failed(back, 'CHOOSE_OPTION', format(s.product.choose, { name: missing.name.toLowerCase() }));
        const variant = product.variants.find((v) => product.options.every((option) => v.optionValues[option.name] === field(form, `option:${option.name}`)));
        if (!variant) return failed(back, 'COMBINATION_UNAVAILABLE', s.errors.local.COMBINATION_UNAVAILABLE);
        if (!variant.available) return failed(back, 'OPTION_SOLD_OUT', s.errors.local.OPTION_SOLD_OUT);
        item = { variantId: variant.id, quantity };
      }
      const cart = await addToCart(shop, item);
      return succeeded('/cart', { ok: true, message: plural(localeOf(shop.site.locale), s.product.added, cart.itemCount) });
    } catch (error) {
      return failedWith(back, s, error);
    }
  });

/** Cart page: set a line's quantity (`set` from the −/+ buttons, or `quantity` from the field; 0 removes it). */
export const updateLine = createServerFn({ method: 'POST' })
  .validator(formData)
  .handler(async ({ data: form }) => {
    const shop = await shopRequest();
    const s = stringsFor(shop.site.locale);
    const token = getCartToken();
    const lineId = field(form, 'lineId');
    const quantity = form.has('set') ? wholeNumber(form, 'set', 0, 999) : wholeNumber(form, 'quantity', 0, 999);
    if (!token || !lineId) return failed('/cart', 'CART_NOT_FOUND', s.errors.codes.CART_NOT_FOUND);
    if (quantity === null) return failed('/cart', 'QUANTITY', s.errors.local.QUANTITY);
    try {
      await shop.client.cart.updateItem(token, lineId, quantity, await cartOptions(shop));
      return succeeded('/cart');
    } catch (error) {
      return failedWith('/cart', s, error);
    }
  });

export const removeLine = createServerFn({ method: 'POST' })
  .validator(formData)
  .handler(async ({ data: form }) => {
    const shop = await shopRequest();
    const s = stringsFor(shop.site.locale);
    const token = getCartToken();
    const lineId = field(form, 'lineId');
    if (!token || !lineId) return failed('/cart', 'CART_NOT_FOUND', s.errors.codes.CART_NOT_FOUND);
    try {
      await shop.client.cart.removeItem(token, lineId, await cartOptions(shop));
      return succeeded('/cart');
    } catch (error) {
      return failedWith('/cart', s, error);
    }
  });

/** Cart page: a discount code (`code`), or `remove` to take it off. */
export const discountCode = createServerFn({ method: 'POST' })
  .validator(formData)
  .handler(async ({ data: form }) => {
    const shop = await shopRequest();
    const s = stringsFor(shop.site.locale);
    const back = backPath(form, '/cart');
    const token = getCartToken();
    if (!token) return failed(back, 'CART_EMPTY', s.errors.local.CART_EMPTY);
    try {
      if (form.has('remove')) {
        await shop.client.cart.removeDiscount(token, await cartOptions(shop));
        return succeeded(back);
      }
      const code = field(form, 'code');
      if (!code) return failed(back, 'DISCOUNT_REQUIRED', s.errors.local.DISCOUNT_REQUIRED, { fieldErrors: { code: s.errors.local.DISCOUNT_REQUIRED } });
      const cart = await shop.client.cart.applyDiscount(token, code, await cartOptions(shop));
      if (cart.discountProblem) {
        const message = discountReason(s, cart.discountProblem);
        return failed(back, 'DISCOUNT_NOT_APPLICABLE', message, { fieldErrors: { code: message } });
      }
      return succeeded(back, { ok: true, message: format(s.cart.discountApplied, { code: cart.discount?.code ?? code }) });
    } catch (error) {
      if (isStorefrontError(error, 'DISCOUNT_NOT_APPLICABLE')) {
        const message = discountReason(s, error.details?.reason);
        return failed(back, 'DISCOUNT_NOT_APPLICABLE', message, { fieldErrors: { code: message } });
      }
      return failedWith(back, s, error);
    }
  });

/** What the shopper pasted, or the uploaded file; untrimmed, so line numbers stay right. */
async function pastedCsv(form: FormData): Promise<string | 'TOO_LARGE'> {
  const file = form.get('file');
  if (file instanceof File && file.size > 0) {
    if (file.size > 200_000) return 'TOO_LARGE';
    return await file.text();
  }
  const pasted = form.get('csv');
  return typeof pasted === 'string' ? pasted : '';
}

/** B2B quick order: SKUs and quantities, pasted or uploaded as CSV. */
export const quickOrder = createServerFn({ method: 'POST' })
  .validator(formData)
  .handler(async ({ data: form }) => {
    const shop = await shopRequest();
    const s = stringsFor(shop.site.locale);
    const back = '/quick-order';
    if (!(await currentShopper(shop))) return failed(back, 'SESSION_REQUIRED', s.errors.codes.SESSION_REQUIRED);
    const csv = await pastedCsv(form);
    if (csv === 'TOO_LARGE') return failed(back, 'FILE_TOO_LARGE', s.errors.local.FILE_TOO_LARGE);
    const lines = csv.split(/\r?\n/);
    const filled = lines.filter((line) => line.trim() !== '').length;
    if (filled === 0) return failed(back, 'QUICK_ORDER_EMPTY', s.errors.local.QUICK_ORDER_EMPTY, { fieldErrors: { csv: s.errors.local.QUICK_ORDER_EMPTY } });
    if (filled > 500) return failed(back, 'QUICK_ORDER_TOO_MANY', s.errors.local.QUICK_ORDER_TOO_MANY);
    const normalised = lines.map(toCsvLine).join('\n');
    try {
      const options = await cartOptions(shop);
      const token = getCartToken();
      let result;
      try {
        result = await shop.client.cart.quickOrder({ csv: normalised }, { ...options, cartToken: token });
      } catch (error) {
        if (!token || !isStorefrontError(error, 'CART_NOT_FOUND', 'CART_NOT_OPEN')) throw error;
        result = await shop.client.cart.quickOrder({ csv: normalised }, options);
      }
      if (result.cartToken) setCartToken(result.cartToken, shop.https);
      const rows = problemRows(result.problems);
      const count = plural(localeOf(shop.site.locale), s.b2b.added, result.cart.itemCount);
      if (rows.length === 0) return succeeded('/cart', { ok: true, message: count });
      if (rows.every((row) => row.added)) return succeeded('/cart', { ok: true, message: `${s.b2b.addedLowStock} ${count}`, problems: rows });
      return failed(back, 'QUICK_ORDER_PROBLEMS', `${s.b2b.someNotAdded} ${count}`, { problems: rows });
    } catch (error) {
      return failedWith(back, s, error);
    }
  });
