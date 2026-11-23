/** Addresses the API needs: where Mollie sends the shopper back, and the order link for emails. */

/** `https://shop.example.com/checkout/return` (Mollie adds `order=…&payment=…`). */
export function paymentReturnUrl(shopUrl: string): string {
  return `${shopUrl.replace(/\/+$/, '')}/checkout/return`;
}

/**
 * The order link of the confirmation email: the API fills in `{orderId}` and
 * `{token}` (empty for a signed-in shopper). It must be https.
 */
export function orderUrlTemplate(shopUrl: string): string | undefined {
  const base = shopUrl.replace(/\/+$/, '');
  return base.startsWith('https://') ? `${base}/orders/{orderId}?token={token}` : undefined;
}

/** The guest order page of an order. */
export function orderPath(orderId: string, orderToken: string): string {
  return `/orders/${encodeURIComponent(orderId)}?token=${encodeURIComponent(orderToken)}`;
}

/** The return page of an order (and its payment). */
export function returnPath(orderId: string, paymentId: string | null, error?: string): string {
  const query = new URLSearchParams({ order: orderId });
  if (paymentId) query.set('payment', paymentId);
  if (error) query.set('error', error);
  return `/checkout/return?${query.toString()}`;
}

/** A product's page. */
export function productPath(slug: string): string {
  return `/products/${encodeURIComponent(slug)}`;
}

export function categoryPath(slug: string): string {
  return `/categories/${encodeURIComponent(slug)}`;
}
