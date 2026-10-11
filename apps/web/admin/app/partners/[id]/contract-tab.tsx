'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { PartnerContractView } from '@weldsuite/app-api-client/schemas/partners';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { createPartnerContract } from '@/actions/partners';
import { ContractFields } from '@/components/partners/contract-fields';
import { useSubmit } from '@/components/partners/use-submit';
import { formatDay, formatDecimal } from '@/lib/billing-format';
import type { PlanOption } from '@/lib/billing-types';
import { fill } from '@/lib/i18n';
import {
  bpsToPercent,
  contractFormFromView,
  contractPayload,
  currentContract,
  defaultContractForm,
  parseContractForm,
} from '@/lib/partners';
import { partnersCopy } from '@/lib/partners-copy';
import type { PartnerTabProps } from './partner-detail';

export function ContractTab({ detail, canWrite, planOptions }: Readonly<PartnerTabProps>) {
  const t = partnersCopy().contract;
  const contracts = [...detail.contracts].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  const current = currentContract(detail.contracts);

  return (
    <div className="space-y-4">
      <Card className="py-4">
        <CardContent className="space-y-3 px-4">
          <h2 className="text-sm font-medium">{t.history}</h2>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.columns.from}</TableHead>
                  <TableHead>{t.columns.to}</TableHead>
                  <TableHead className="text-right">{t.columns.share}</TableHead>
                  <TableHead className="text-right">{t.columns.minimum}</TableHead>
                  <TableHead className="text-right">{t.columns.credits}</TableHead>
                  <TableHead className="text-right">{t.columns.creditFloor}</TableHead>
                  <TableHead>{t.columns.terms}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contracts.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                      {t.empty}
                    </TableCell>
                  </TableRow>
                )}
                {contracts.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="whitespace-nowrap">
                      {formatDay(c.effectiveFrom)}
                      {c.id === current?.id && (
                        <Badge variant="success" className="ml-2">
                          {t.current}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{c.effectiveTo ? formatDay(c.effectiveTo) : t.open}</TableCell>
                    <TableCell className="text-right tabular-nums">{bpsToPercent(c.revenueShareBps)}%</TableCell>
                    <TableCell className="text-right tabular-nums">{formatDecimal(c.baseMinimum, c.currency)}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.includedCredits.toLocaleString('en-GB')}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.creditFloorPrice}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {fill(t.termsSummary, { terms: c.paymentTermsDays, pastDue: c.pastDueAfterDays, readOnly: c.readOnlyAfterDays })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {canWrite && <NewContractForm key={current?.id ?? 'none'} current={current} planOptions={planOptions} partnerId={detail.partner.id} />}
    </div>
  );
}

function NewContractForm({
  current,
  planOptions,
  partnerId,
}: Readonly<{ current: PartnerContractView | null; planOptions: PlanOption[]; partnerId: string }>) {
  const t = partnersCopy().contract;
  const common = partnersCopy().common;
  const router = useRouter();
  const { submit, isPending } = useSubmit();
  const [form, setForm] = useState(() => (current ? contractFormFromView(current) : defaultContractForm()));

  const onSubmit = () => {
    const parsed = parseContractForm(form);
    if (!parsed.ok) return void toast.error(parsed.error);
    submit((requestId) => createPartnerContract(partnerId, contractPayload(form), requestId), {
      success: t.created,
      onSuccess: () => router.refresh(),
    });
  };

  return (
    <Card className="py-4">
      <CardContent className="space-y-4 px-4">
        <div>
          <h2 className="text-sm font-medium">{t.newTitle}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t.newHint}</p>
        </div>
        <ContractFields value={form} onChange={setForm} disabled={isPending} planOptions={planOptions} idPrefix="contract" />
        <div className="flex justify-end">
          <Button disabled={isPending} onClick={onSubmit}>
            {isPending ? common.working : t.submit}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
