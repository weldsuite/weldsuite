/**
 * Warns before deleting companies that still have open deals (TASK-1040).
 *
 * Deleting a company leaves its deals on the pipeline board without a
 * company, so the user should know before it happens. `confirmDelete`
 * resolves `true` straight away when nothing is at stake, and otherwise
 * opens a confirmation ("This company has N open deals...") and resolves with
 * the user's choice. Render `dialog` once next to the delete trigger.
 *
 * The open-deal count comes from `GET /opportunities?customerIds=…&status=open`,
 * so it covers the deals the current user may see (owner-scoped unless they
 * hold `opportunities:scope:all`). A failed lookup never blocks the delete.
 */

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useAppApiClient } from '@/lib/api/use-app-api';

const ID_CHUNK = 50;

interface OpenDealsPage {
  data?: Array<{ customerId?: string | null }>;
  pagination?: { totalCount?: number };
}

interface PendingDelete {
  companies: number;
  deals: number;
}

export function useCompanyDeleteGuard(): {
  confirmDelete: (companyIds: string[]) => Promise<boolean>;
  dialog: ReactNode;
} {
  const st = useTranslations();
  const { getClient } = useAppApiClient();
  const [pending, setPending] = useState<PendingDelete | null>(null);
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);

  const countOpenDeals = useCallback(
    async (companyIds: string[]): Promise<PendingDelete> => {
      const client = await getClient();
      const withDeals = new Set<string>();
      let deals = 0;
      for (let i = 0; i < companyIds.length; i += ID_CHUNK) {
        const chunk = companyIds.slice(i, i + ID_CHUNK);
        const res = await client.get<OpenDealsPage>(
          `/opportunities?customerIds=${encodeURIComponent(chunk.join(','))}&status=open&limit=100`,
        );
        deals += res.pagination?.totalCount ?? res.data?.length ?? 0;
        for (const deal of res.data ?? []) {
          if (deal.customerId) withDeals.add(deal.customerId);
        }
      }
      return { companies: withDeals.size, deals };
    },
    [getClient],
  );

  const confirmDelete = useCallback(
    async (companyIds: string[]): Promise<boolean> => {
      if (companyIds.length === 0) return true;
      let found: PendingDelete;
      try {
        found = await countOpenDeals(companyIds);
      } catch (error) {
        console.error('[Companies] open-deal lookup failed:', error);
        return true;
      }
      if (found.deals === 0) return true;
      return new Promise<boolean>((resolve) => {
        resolveRef.current = resolve;
        setPending(found);
      });
    },
    [countOpenDeals],
  );

  const settle = useCallback((ok: boolean) => {
    resolveRef.current?.(ok);
    resolveRef.current = null;
    setPending(null);
  }, []);

  let description: string;
  if (pending && pending.companies > 1) {
    description = st('sweep.entities.companyDeleteBulkOpenDeals', {
      count: pending.companies,
      deals: pending.deals,
    });
  } else if (pending?.deals === 1) {
    description = st('sweep.entities.companyDeleteOpenDealsOne');
  } else {
    description = st('sweep.entities.companyDeleteOpenDealsOther', { count: pending?.deals ?? 0 });
  }

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
      title={st('sweep.entities.companyDeleteConfirm')}
      description={description}
      variant="destructive"
      confirmLabel={st('sweep.entities.delete')}
      cancelLabel={st('common.actions.cancel')}
      onConfirm={() => settle(true)}
    />
  );

  return { confirmDelete, dialog };
}
