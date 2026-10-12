/**
 * Singleton TanStack Query client.
 *
 * Created at module scope so it can be passed to TanStack Router's
 * `createRouter` context AND used by QueryProvider — guaranteeing route
 * loaders share the same cache as the page hooks.
 */

import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import { isNotLicensedError, isReadOnlyError } from '@/lib/partner/api-errors';
import { partnerKeys } from '@/lib/partner/partner-keys';

/**
 * Two failures are expected in a partner-managed workspace and are explained
 * once instead of surfacing as a broken screen:
 *  - `APP_NOT_LICENSED` (403): the licence leaves out the app behind this call;
 *  - `WORKSPACE_READ_ONLY` (403): the workspace is paused for non-payment.
 * One toast per kind every few seconds; the read-only case also refreshes the
 * managed-billing query so the banner appears without a reload.
 */
const TOAST_COOLDOWN_MS = 8000;
const lastToastAt = new Map<string, number>();

function partnerNameFromCache(): string | null {
  const [entry] = queryClient.getQueriesData<{ data?: { partner?: { name?: string } } | null }>({
    queryKey: [...partnerKeys.all, 'managed-billing'],
  });
  return entry?.[1]?.data?.partner?.name ?? null;
}

function toastOnce(id: string, title: string, description: string) {
  const now = Date.now();
  if (now - (lastToastAt.get(id) ?? 0) < TOAST_COOLDOWN_MS) return;
  lastToastAt.set(id, now);
  toast.error(title, { id, description });
}

function explainLicenceError(error: unknown) {
  if (isNotLicensedError(error)) {
    const t = getTranslations('partner').errors;
    const partner = partnerNameFromCache();
    toastOnce(
      'app-not-licensed',
      t.notLicensedTitle,
      partner ? t.notLicensedWithPartner.replace('{partner}', partner) : t.notLicensed,
    );
  } else if (isReadOnlyError(error)) {
    const t = getTranslations('partner').errors;
    toastOnce('workspace-read-only', t.readOnlyTitle, t.readOnly);
    void queryClient.invalidateQueries({ queryKey: [...partnerKeys.all, 'managed-billing'] });
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: explainLicenceError }),
  mutationCache: new MutationCache({ onError: explainLicenceError }),
  defaultOptions: {
    queries: {
      // Stale-while-revalidate: rehydrated cache renders instantly on first
      // paint (via PersistQueryClientProvider), and because every entry is
      // immediately considered stale, a background refetch fires on mount and
      // updates the UI once it settles. This keeps the view fast (no spinner,
      // no flash) while guaranteeing the data is never served stale without a
      // refresh. Realtime events still invalidate on top of this.
      staleTime: 0,
      // Keep cached query data around long enough for the persister to write
      // it to localStorage AND for it to still be present after a reload.
      // Without this, the default 5-minute gcTime drops entries before they
      // can be persisted/rehydrated, defeating the persist-client.
      gcTime: 24 * 60 * 60 * 1000, // 24 hours
      refetchOnWindowFocus: false,
    },
  },
});
