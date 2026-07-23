/**
 * Shared handling for AI "insufficient credits" (HTTP 402) responses.
 *
 * The app-api AI endpoints hard-gate on the prepaid credit wallet and return
 * 402 `insufficient_credits` when it's empty (see services/ai/billing.ts). The
 * platform api client throws that as an `Error` whose message is the backend
 * copy ("Insufficient credits. …"); some callers instead hold the parsed
 * `{ error: { code } }` body. {@link isInsufficientCreditsError} detects both.
 *
 * {@link useAiCreditsToast} returns a guard: pass it whatever your catch/onError
 * gets; if it's an out-of-credits error it shows a toast with a **Top up**
 * action (→ Settings → Billing) and returns `true` so the caller can skip its
 * generic error toast.
 */

import { useCallback } from 'react';
import { toast } from 'sonner';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';

/** True when `value` represents a 402 insufficient-credits error. */
export function isInsufficientCreditsError(value: unknown): boolean {
  if (value instanceof Error && /insufficient credits/i.test(value.message)) {
    return true;
  }
  if (value && typeof value === 'object') {
    const obj = value as { code?: unknown; error?: { code?: unknown } };
    const code = obj.error?.code ?? obj.code;
    if (code === 'insufficient_credits') return true;
  }
  return false;
}

/**
 * Returns `handle(err) => boolean`. When `err` is an out-of-credits error it
 * shows the top-up toast and returns `true`; otherwise it does nothing and
 * returns `false` (caller should show its own error).
 */
export function useAiCreditsToast() {
  const router = useRouter();
  const { t } = useI18n();

  return useCallback(
    (err: unknown): boolean => {
      if (!isInsufficientCreditsError(err)) return false;
      toast.error(t.mail.ai.insufficientCreditsTitle, {
        description: t.mail.ai.insufficientCreditsDescription,
        action: {
          label: t.mail.ai.topUp,
          onClick: () => router.push('/settings/billing'),
        },
      });
      return true;
    },
    [router, t],
  );
}
