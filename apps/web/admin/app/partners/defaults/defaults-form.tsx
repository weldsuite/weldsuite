'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { savePartnerContractDefaults } from '@/actions/partner-contract-defaults';
import { ContractFields } from '@/components/partners/contract-fields';
import { useSubmit } from '@/components/partners/use-submit';
import { formatDateTime } from '@/lib/billing-format';
import type { PlanOption } from '@/lib/billing-types';
import { fill } from '@/lib/i18n';
import type { PartnerContractDefaultsView } from '@/lib/partner-contract-defaults-data';
import { contractPayload, defaultContractForm, parseContractForm } from '@/lib/partners';
import { partnersCopy } from '@/lib/partners-copy';

export function DefaultsForm({
  defaults,
  planOptions,
  canWrite,
}: Readonly<{ defaults: PartnerContractDefaultsView; planOptions: PlanOption[]; canWrite: boolean }>) {
  const t = partnersCopy().defaults;
  const router = useRouter();
  const { submit, isPending } = useSubmit();
  const [form, setForm] = useState(() => defaultContractForm(defaults.terms));

  const onSubmit = () => {
    const payload = { ...form, effectiveFrom: '', notes: '' };
    const parsed = parseContractForm(payload);
    if (!parsed.ok) return void toast.error(parsed.error);
    submit(() => savePartnerContractDefaults(contractPayload(payload)), {
      success: t.saved,
      onSuccess: () => router.refresh(),
    });
  };

  return (
    <Card className="py-4">
      <CardContent className="space-y-4 px-4">
        <p className="text-xs text-muted-foreground">
          {defaults.updatedAt
            ? fill(t.lastSaved, { date: formatDateTime(defaults.updatedAt), by: defaults.updatedBy ?? '—' })
            : t.builtIn}
        </p>
        <ContractFields
          value={form}
          onChange={setForm}
          disabled={isPending || !canWrite}
          planOptions={planOptions}
          idPrefix="contract-defaults"
          showEffectiveFrom={false}
          showNotes={false}
        />
        {canWrite && (
          <div className="flex justify-end">
            <Button disabled={isPending} onClick={onSubmit}>
              {isPending ? partnersCopy().common.working : t.submit}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
