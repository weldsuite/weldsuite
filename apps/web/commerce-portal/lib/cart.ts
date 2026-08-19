export type CartLine = {
  productId: string;
  name: string;
  price: string;
  quantity: number;
  imageUrl?: string | null;
  currency?: string | null;
};

const KEY = 'cportal_cart';

export function readCart(): CartLine[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CartLine[]) : [];
  } catch {
    return [];
  }
}

export function writeCart(lines: CartLine[]): void {
  localStorage.setItem(KEY, JSON.stringify(lines));
}

export function addToCart(line: Omit<CartLine, 'quantity'> & { quantity?: number }): CartLine[] {
  const cart = readCart();
  const qty = line.quantity ?? 1;
  const existing = cart.find((l) => l.productId === line.productId);
  if (existing) existing.quantity += qty;
  else cart.push({ ...line, quantity: qty });
  writeCart(cart);
  return cart;
}

export function clearCart(): void {
  writeCart([]);
}
