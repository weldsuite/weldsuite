/**
 * The shop's settings, fixed at build time (see .env.example). Everything
 * here ends up in the browser bundle, which is why only a publishable key
 * (wcp_…) is accepted.
 */

export interface ShopConfig {
  apiUrl: string;
  key: string;
  /** The shop's own origin, e.g. https://shop.example.com (no trailing slash). */
  shopUrl: string;
  locale: string;
}

export type ConfigProblem = 'MISSING_API_URL' | 'MISSING_KEY' | 'PRIVATE_KEY' | 'NOT_A_KEY' | 'MISSING_SHOP_URL' | 'BAD_SHOP_URL';

function origin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The settings, or what is wrong with them. */
export function readConfig(env: Record<string, string | undefined>): { config: ShopConfig } | { problem: ConfigProblem } {
  const apiUrl = env.VITE_WELDCOMMERCE_API_URL?.trim();
  const key = env.VITE_WELDCOMMERCE_KEY?.trim();
  const shopUrl = env.VITE_SHOP_URL?.trim();
  if (!apiUrl) return { problem: 'MISSING_API_URL' };
  if (!key) return { problem: 'MISSING_KEY' };
  if (key.startsWith('wcs_')) return { problem: 'PRIVATE_KEY' };
  if (!key.startsWith('wcp_')) return { problem: 'NOT_A_KEY' };
  if (!shopUrl) return { problem: 'MISSING_SHOP_URL' };
  const shop = origin(shopUrl);
  if (!shop) return { problem: 'BAD_SHOP_URL' };
  return { config: { apiUrl, key, shopUrl: shop, locale: env.VITE_SHOP_LOCALE?.trim() || 'en-IE' } };
}
