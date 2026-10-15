/**
 * Outbound mail guard: what the workspace may send through WeldMail, what it
 * has used and how its recent mail was delivered (mail-api
 * `GET /api/mail-sending/usage`). See docs/plans/weldmail-outbound-abuse.md.
 */

import { useQuery } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type { OutboundUsage } from '@weldsuite/app-api-client/schemas/outbound-mail';

export const mailSendingKeys = {
  all: ['mail', 'sending'] as const,
  usage: () => [...mailSendingKeys.all, 'usage'] as const,
};

/**
 * The workspace's sending limits and usage. `data` is `null` when the guard is
 * not available (the API says so, or the request failed), so callers render
 * nothing instead of an error: this is information, never a gate.
 */
export function useMailSendingUsage(options: { enabled?: boolean } = {}) {
  const { mailSending } = useAppApi();
  return useQuery<OutboundUsage | null>({
    queryKey: mailSendingKeys.usage(),
    queryFn: async () => {
      try {
        const res = await mailSending.usage();
        return res.data ?? null;
      } catch {
        return null;
      }
    },
    enabled: options.enabled ?? true,
    // Counters move on every send, but nobody needs them to the second.
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
