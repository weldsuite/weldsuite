/*
 * Every sentence the shop shows, in one place. English only: translate this
 * file (or put a lookup in front of it) when you add languages.
 */

import { isStorefrontError, type CartMissing, type StorefrontErrorCode } from '@weldsuite/commerce-sdk';

import type { ConfigProblem } from './config';

const ERRORS: Partial<Record<StorefrontErrorCode, string>> = {
  INVALID_KEY: 'The shop is not set up correctly. Try again later.',
  ORIGIN_NOT_ALLOWED: 'This address of the shop is not allowed to use its key. Add it to the key’s allowed origins.',
  RATE_LIMITED: 'Too many requests right now. Wait a moment and try again.',
  WORKSPACE_MOVING: 'The shop is being updated. Try again in a minute.',
  CHANNEL_INACTIVE: 'The shop is closed at the moment.',
  CART_NOT_FOUND: 'Your cart has expired. Add the items again.',
  CART_NOT_OPEN: 'This cart has already been checked out. Start a new one.',
  CART_TOO_LARGE: 'Your cart has too many lines.',
  NOT_SELLABLE: 'This product is not for sale right now.',
  COUNTRY_NOT_SOLD: 'We do not ship to that country.',
  RATE_NOT_AVAILABLE: 'That shipping method is not available for your address.',
  TAX_ENGINE_UNAVAILABLE: 'We could not work out the VAT just now. Try again in a moment.',
  SELLER_ENTITY_REQUIRED: 'The shop is not ready to sell yet.',
  SELLER_ENTITY_NOT_EU: 'The shop is not ready to sell yet.',
  CART_NOT_READY: 'Some details are still missing.',
  OUT_OF_STOCK: 'Some items are no longer in stock. Check your cart.',
  PRICE_CHANGED: 'The total has changed. Check your order and try again.',
  PAYMENT_METHOD_NOT_ENABLED: 'That payment method is not available.',
  GUEST_CHECKOUT_DISABLED: 'This shop asks shoppers to sign in at checkout, which this storefront does not offer yet.',
  IDEMPOTENCY_KEY_REUSED: 'Reload the page and try again.',
  PAYMENT_PROVIDER_NOT_CONNECTED: 'Online payment is not available at the moment.',
  PAYMENTS_UNAVAILABLE: 'Online payment is not available at the moment.',
  REDIRECT_NOT_ALLOWED: 'Online payment is not set up for this address of the shop.',
  ORDER_URL_NOT_ALLOWED: 'Online payment is not set up for this address of the shop.',
  PROVIDER_ERROR: 'The payment could not be started. Try again.',
  ALREADY_PAID: 'This order is already paid.',
  ORDER_NOT_PAYABLE: 'This order cannot be paid online right now.',
  PAYMENT_IN_PROGRESS: 'A payment for this order is already in progress.',
  APPROVAL_PENDING: 'This order is waiting for approval.',
  INVALID_CURSOR: 'That page of results is out of date. Start again from the first page.',
  NOT_FOUND: 'We could not find that.',
  NETWORK_ERROR: 'We could not reach the shop. Check your connection and try again.',
};

const DISCOUNT_REASONS: Record<string, string> = {
  NOT_FOUND: 'That discount code does not exist.',
  NOT_ACTIVE: 'That discount code is not active.',
  NOT_STARTED: 'That discount code is not valid yet.',
  EXPIRED: 'That discount code has expired.',
  USAGE_LIMIT: 'That discount code has been used up.',
  CUSTOMER_LIMIT: 'You have already used that discount code.',
  MINIMUM_SUBTOTAL: 'Your order is below the minimum for that discount code.',
  MINIMUM_QUANTITY: 'Add more items to use that discount code.',
  CURRENCY: 'That discount code is not valid in this currency.',
  NOT_ELIGIBLE: 'That discount code does not apply to these items.',
};

export const GENERIC_ERROR = 'Something went wrong. Try again.';

export function discountReason(reason: string | null | undefined): string {
  return (reason && DISCOUNT_REASONS[reason]) || 'That discount code does not apply.';
}

/** A sentence for an API error code (from a URL's `?error=`, say); a generic one otherwise. */
export function messageForCode(code: string | null | undefined): string {
  return (code && ERRORS[code as StorefrontErrorCode]) || GENERIC_ERROR;
}

/** A sentence for the shopper about a failed call. */
export function describeError(error: unknown): string {
  if (isStorefrontError(error, 'DISCOUNT_NOT_APPLICABLE')) return discountReason(error.details?.reason);
  if (isStorefrontError(error)) {
    if (error.code === 'VALIDATION_ERROR') return 'Check the highlighted fields.';
    return messageForCode(error.code);
  }
  return GENERIC_ERROR;
}

/** The field messages of a VALIDATION_ERROR, keyed by the API's field path (the form's field names). */
export function fieldErrors(error: unknown): Record<string, string> {
  return isStorefrontError(error, 'VALIDATION_ERROR') ? (error.details?.fields ?? {}) : {};
}

export const MISSING: Record<CartMissing, string> = {
  items: 'Items in your cart',
  email: 'Your email address',
  shippingAddress: 'A complete delivery address',
  shippingRate: 'A shipping method',
  billingAddress: 'A complete billing address',
};

export const SETUP: Record<ConfigProblem, string> = {
  MISSING_API_URL: 'Set VITE_WELDCOMMERCE_API_URL to your WeldSuite server.',
  MISSING_KEY: 'Set VITE_WELDCOMMERCE_KEY to a publishable storefront key (wcp_…).',
  PRIVATE_KEY: 'VITE_WELDCOMMERCE_KEY is a private key (wcs_…). Never ship one to a browser: use a publishable key (wcp_…).',
  NOT_A_KEY: 'VITE_WELDCOMMERCE_KEY must be a publishable storefront key (wcp_…).',
  MISSING_SHOP_URL: 'Set VITE_SHOP_URL to the shop’s https address.',
  BAD_SHOP_URL: 'VITE_SHOP_URL must be an http(s) address, like https://shop.example.com.',
};

/** The shop's own copy. */
export const text = {
  skipToContent: 'Skip to content',
  shopNav: 'Your shop',
  categoriesNav: 'Categories',
  allProducts: 'All products',
  search: 'Search',
  searchLabel: 'Search products',
  cart: 'Cart',
  cartCount: (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`,
  pricesNote: (currency: string, inclVat: boolean) => `Prices are in ${currency} and ${inclVat ? 'include' : 'exclude'} VAT.`,
  poweredBy: 'Powered by WeldCommerce.',
  setupTitle: 'Almost there',
  setupIntro: 'Connect this shop to WeldCommerce: copy .env.example to .env.local, fill it in and restart.',
  newArrivals: 'New arrivals',
  shopByCategory: 'Shop by category',
  viewAll: 'View all products',
  noProducts: 'There are no products here yet.',
  searchResults: (query: string) => `Results for “${query}”`,
  noResults: (query: string) => `Nothing matches “${query}”. Try another word.`,
  sortBy: 'Sort by',
  sortApply: 'Sort',
  sorts: { name: 'Name, A to Z', '-name': 'Name, Z to A', price: 'Price, low to high', '-price': 'Price, high to low', newest: 'Newest' },
  morePages: 'More products',
  firstPage: 'Back to the first page',
  from: (price: string) => `From ${price}`,
  was: (price: string) => `Was ${price}`,
  soldOut: 'Sold out',
  quantity: 'Quantity',
  addToCart: 'Add to cart',
  adding: 'Adding…',
  added: (count: number) => `Added to your cart. You have ${count} ${count === 1 ? 'item' : 'items'} in it.`,
  viewCart: 'View your cart',
  chooseOption: (name: string) => `Choose a ${name.toLowerCase()}.`,
  combinationUnavailable: 'That combination is not available.',
  optionSoldOut: 'That option is sold out.',
  quantityRange: 'Enter a quantity from 1 to 999.',
  description: 'Description',
  breadcrumb: 'Breadcrumb',
  home: 'Home',
  productImages: 'Product images',
  showImage: (index: number) => `Show image ${index}`,
  yourCart: 'Your cart',
  cartEmpty: 'Your cart is empty.',
  continueShopping: 'Continue shopping',
  oneFewer: (name: string) => `One fewer ${name}`,
  oneMore: (name: string) => `One more ${name}`,
  remove: 'Remove',
  removeItem: (name: string) => `Remove ${name}`,
  lineProblems: { OUT_OF_STOCK: 'Not enough in stock', NO_PRICE: 'No price, cannot be ordered', INACTIVE: 'No longer sold' },
  orderSummary: 'Order summary',
  subtotal: 'Subtotal',
  discount: 'Discount',
  shipping: 'Shipping',
  shippingLater: 'Calculated at checkout',
  free: 'Free',
  vat: (rate: string) => `VAT ${rate}`,
  vatTotal: 'VAT',
  vatLater: 'Worked out at checkout',
  vatIncluded: (amount: string) => `Including ${amount} VAT`,
  total: 'Total',
  checkout: 'Check out',
  discountCode: 'Discount code',
  applyDiscount: 'Apply',
  discountApplied: (code: string) => `Discount code ${code} applied.`,
  removeDiscount: (code: string) => `Remove discount code ${code}`,
  enterDiscount: 'Enter a discount code.',
  fixCart: 'Some items cannot be ordered. Remove them or change the quantity first.',
  checkoutTitle: 'Checkout',
  step: (n: number) => `Step ${n}: `,
  detailsStep: 'Your details',
  shippingStep: 'Shipping',
  paymentStep: 'Review and pay',
  email: 'Email',
  emailHint: 'For the order confirmation.',
  deliveryAddress: 'Delivery address',
  billingAddress: 'Billing address',
  billingSame: 'Billing address is the same as the delivery address',
  fullName: 'Full name',
  company: 'Company',
  line1: 'Street and house number',
  line2: 'Address line 2',
  postalCode: 'Postal code',
  city: 'City',
  region: 'State or province',
  country: 'Country',
  chooseCountry: 'Choose a country',
  phone: 'Phone',
  phoneHint: 'For the delivery company, if they need to reach you.',
  note: 'Note',
  optional: 'optional',
  required: 'Required',
  saving: 'Saving…',
  saveDetails: 'Save and continue to shipping',
  detailsSaved: 'Details saved.',
  detailsSavedNext: 'Details saved. Now choose how to ship your order.',
  fillHighlighted: 'Fill in the highlighted fields.',
  addressFirst: 'Fill in your delivery address first.',
  noShipping: 'We have no shipping method for this address. Check the country.',
  shippingMethod: 'Shipping method',
  useShipping: 'Use this shipping method',
  shippingSaved: 'Shipping method saved.',
  chooseShipping: 'Choose a shipping method.',
  stillNeeded: 'Still needed before you can pay:',
  changeCart: 'Change your cart',
  noPaymentMethod: 'There is no way to pay online for this order right now. Contact the shop.',
  pay: (amount: string) => `Pay ${amount}`,
  placing: 'Placing your order…',
  mollieNote: 'You will be taken to Mollie to pay (iDEAL, card, Bancontact and more), then come back here.',
  priceChanged: 'The total has changed. Check the new total below and place your order again.',
  yourOrder: 'Your order',
  viesUnavailable: 'We could not check your VAT number with the EU just now, so VAT is charged.',
  returnNotFoundTitle: 'We can’t find this checkout',
  returnNotFound: 'If you placed an order, the confirmation email has a link to it.',
  placedTitle: 'Thank you, your order is placed',
  placed: (n: string) => `Order ${n} is placed. You will get a confirmation email.`,
  paidTitle: 'Thank you, we received your payment',
  paid: (n: string) => `Order ${n} is paid. You will get a confirmation email.`,
  waitingTitle: 'We’re checking your payment',
  waiting: (n: string) => `The payment for order ${n} is not confirmed yet. This usually takes a few seconds.`,
  unknownTitle: 'We couldn’t check your payment',
  unknown: (n: string) => `Your order ${n} is saved. We couldn’t reach the payment service just now: check again in a moment.`,
  failedTitle: 'The payment didn’t go through',
  failed: (status: string | undefined, n: string) =>
    `${status === 'canceled' ? 'You cancelled the payment.' : status === 'expired' ? 'The payment expired.' : 'The payment failed.'} Your order ${n} is saved: you can try again.`,
  checkAgain: 'Check again',
  tryAgain: 'Try paying again',
  starting: 'Starting the payment…',
  viewOrder: 'View your order',
  orderTitle: (n: string) => `Order ${n}`,
  placedOn: (d: string) => `Placed on ${d}`,
  status: 'Status',
  payment: 'Payment',
  item: 'Item',
  price: 'Price',
  orderNotFound: 'We can’t find this order. Check the link in your confirmation email.',
  notFoundTitle: 'Page not found',
  notFound: 'The page you are looking for does not exist or has moved.',
  goHome: 'Go to the home page',
  errorTitle: 'Something went wrong',
  tryReload: 'Reload the page',
};
