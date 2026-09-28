/** Parse billing-worker JSON without throwing on empty/HTML bodies. */
export async function readJsonObject(resp: Response): Promise<Record<string, unknown>> {
  const text = await resp.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { error: text.slice(0, 200) };
  } catch {
    return { error: text.slice(0, 200) || `HTTP ${resp.status}` };
  }
}

export function billingErrorMessage(
  result: Record<string, unknown>,
  fallback: string,
): string {
  const err = result.error;
  if (typeof err === 'string' && err.trim()) return err;
  if (err && typeof err === 'object') {
    const nested = (err as { message?: unknown }).message;
    if (typeof nested === 'string' && nested.trim()) return nested;
  }
  if (typeof result.message === 'string' && result.message.trim()) return result.message;
  return fallback;
}

/**
 * Card-on-file did not confirm — send the buyer through Stripe Checkout
 * (same as WeldHost) instead of failing provision with a generic 400.
 */
export function shouldStartPhoneCheckout(result: Record<string, unknown>): boolean {
  if (result.requiresCheckout === true) return true;
  return result.success !== true;
}
