'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ActionDialog } from '@/components/billing/action-dialog';
import { syncPlan } from '@/actions/plans';
import { adminCopy } from '@/lib/i18n';

export function SyncPlanButton({ planId }: Readonly<{ planId: string }>) {
  const t = adminCopy();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <RefreshCw className="h-3.5 w-3.5" />
        {t.plans.stripe.sync}
      </Button>
      {open && (
        <ActionDialog
          title={t.plans.stripe.syncTitle}
          description={t.plans.stripe.syncDescription}
          submitLabel={t.plans.stripe.sync}
          onClose={() => setOpen(false)}
          onSubmit={(reason, requestId) => syncPlan(planId, { reason }, requestId)}
          successMessage={t.plans.stripe.synced}
        />
      )}
    </>
  );
}
