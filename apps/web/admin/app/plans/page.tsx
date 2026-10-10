import Link from 'next/link';
import { Plus } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { requireAdmin } from '@/lib/auth';
import { listPlanDetails } from '@/lib/billing-data';
import { formatCredits, formatDecimal } from '@/lib/billing-format';
import { adminCopy } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

export default async function PlansPage() {
  const identity = await requireAdmin();
  const plans = await listPlanDetails();
  const t = adminCopy();

  return (
    <PageContent>
      <PageBody className="space-y-6">
        <PageHeading
          title={t.plans.title}
          description={t.plans.description}
          actions={
            identity.role !== 'viewer' && (
              <Button asChild size="sm">
                <Link href="/plans/new">
                  <Plus className="h-4 w-4" />
                  {t.plans.newPlan}
                </Link>
              </Button>
            )
          }
        />

        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.plans.columns.plan}</TableHead>
                <TableHead className="w-36 text-right">{t.plans.columns.monthly}</TableHead>
                <TableHead className="w-36 text-right">{t.plans.columns.yearly}</TableHead>
                <TableHead className="w-28 text-right">{t.plans.columns.credits}</TableHead>
                <TableHead className="w-28 text-right">{t.plans.columns.users}</TableHead>
                <TableHead className="w-28 text-right">{t.plans.columns.workspaces}</TableHead>
                <TableHead className="w-36">{t.plans.columns.stripe}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-16 text-center text-sm text-muted-foreground">
                    {t.plans.empty}
                  </TableCell>
                </TableRow>
              )}
              {plans.map((plan) => (
                <TableRow key={plan.id} className="h-12 hover:bg-muted/50">
                  <TableCell>
                    <Link href={`/plans/${plan.id}`} className="font-medium underline-offset-2 hover:underline">
                      {plan.name}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[11px] text-muted-foreground">{plan.slug}</span>
                      <Badge variant={plan.isActive ? 'success' : 'secondary'}>
                        {plan.isActive ? t.plans.active : t.plans.hidden}
                      </Badge>
                      {plan.isDefault && <Badge variant="outline">{t.plans.default}</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDecimal(plan.priceMonthly, plan.currency)}
                    <div className="text-[11px] text-muted-foreground">{t.plans.perSeat}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {Number.parseFloat(plan.priceYearly) > 0 ? formatDecimal(plan.priceYearly, plan.currency) : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCredits(plan.monthlyCredits)}</TableCell>
                  <TableCell className="text-right tabular-nums">{plan.maxUsers ?? t.common.unlimited}</TableCell>
                  <TableCell className="text-right tabular-nums">{plan.workspaceCount}</TableCell>
                  <TableCell>
                    <Badge variant={plan.stripeProductId && plan.hasMonthlyPrice ? 'success' : 'warning'}>
                      {plan.stripeProductId && plan.hasMonthlyPrice ? t.plans.synced : t.plans.notSynced}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </PageBody>
    </PageContent>
  );
}
