/**
 * Barcode helpers shared by the search screen and the Zebra scan hook.
 *
 * Hardware scanners sometimes wrap the payload with CR/LF, GS1 FNC1 (ASCII 29),
 * or surrounding whitespace. We strip those so SKU / barcode lookups match.
 */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export function normalizeBarcode(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(CONTROL_CHARS, '').trim();
}

export interface ScannableProduct {
  id: string;
  sku?: string | null;
  barcode?: string | null;
}

/**
 * Prefer an exact barcode or SKU hit. Warehouse scans should open that product
 * rather than leaving the operator on a filtered list of near-matches.
 */
export function pickExactProduct<T extends ScannableProduct>(
  products: T[],
  scanned: string,
): T | null {
  const code = normalizeBarcode(scanned).toLowerCase();
  if (!code) return null;

  const barcodeHit = products.find((p) => (p.barcode ?? '').trim().toLowerCase() === code);
  if (barcodeHit) return barcodeHit;

  const skuHit = products.find((p) => (p.sku ?? '').trim().toLowerCase() === code);
  return skuHit ?? null;
}

export function buildProductSearchSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base || 'product'}-${suffix}`;
}

export function buildCreateProductPayload(input: {
  name: string;
  sku?: string;
  barcode?: string;
}): {
  name: string;
  slug: string;
  sku?: string;
  barcode?: string;
  status: 'active';
  trackInventory: true;
  price: 0;
} {
  const name = input.name.trim();
  const sku = input.sku?.trim() ? input.sku.trim().toUpperCase() : undefined;
  const barcode = normalizeBarcode(input.barcode) || undefined;
  return {
    name,
    slug: buildProductSearchSlug(name),
    ...(sku ? { sku } : {}),
    ...(barcode ? { barcode } : {}),
    status: 'active',
    trackInventory: true,
    price: 0,
  };
}

export function buildAdjustPayload(input: {
  productId: string;
  warehouseId: string;
  delta: number;
  reason?: string;
}): {
  productId: string;
  warehouseId: string;
  delta: number;
  reason: string;
  sourceType: 'mobile';
} {
  return {
    productId: input.productId,
    warehouseId: input.warehouseId,
    delta: input.delta,
    reason: (input.reason?.trim() || 'Adjusted from WeldStash'),
    sourceType: 'mobile',
  };
}

export function pickDefaultWarehouse<T extends { id: string; isDefault?: boolean | null; isActive?: boolean | null }>(
  warehouses: T[],
): T | null {
  const active = warehouses.filter((w) => w.isActive !== false);
  const pool = active.length > 0 ? active : warehouses;
  if (pool.length === 0) return null;
  return pool.find((w) => w.isDefault) ?? pool[0];
}
