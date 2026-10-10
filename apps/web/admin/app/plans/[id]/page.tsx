import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { ActivityTable } from '@/components/billing/activity-table';
import { requireAdmin } from '@/lib/auth';
import { getPlanDetail, listAuditEvents } from '@/lib/billing-data';
import { adminCopy } from '@/lib/i18n';
import { PlanForm } from '../plan-form';
import { SyncPlanButton } from './sync-plan-button';

export const dynamic = 'force-dynamic';

export default async function PlanDetailPage(props: Readonly<{ params: Promise<{ id: string }> }>) {
  const identity = await requireAdmin();
  const { id } = await props.params;
  const plan = await getPlanDetail(id);
  if (!plan) notFound();
  const history = await listAuditEvents({ plan: plan.id, limit: 50 });
  const t = adminCopy();
  const canWrite = identity.role !== 'viewer';

  const stripeRows: Array<[string, string | null]> = [
    [t.plans.stripe.product, plan.stripeProductId],
    [t.plans.stripe.monthlyPrice, plan.stripePriceIdMonthly],
    [t.plans.stripe.yearlyPrice, plan.stripePriceIdYearly],
  ];

  return (
    <PageContent>
      <PageBody width="narrow" className="space-y-6">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2 text-muted-foreground">
            <Link href="/plans">
              <ArrowLeft className="h-4 w-4" />
              {t.plans.backToPlans}
            </Link>
          </Button>
          <PageHeading
            title={plan.name}
            description={<span className="font-mono text-xs">{plan.slug}</span>}
            actions={
              <>
                <Badge variant={plan.isActive ? 'success' : 'secondary'}>
                  {plan.isActive ? t.plans.active : t.plans.hidden}
                </Badge>
                {plan.isDefault && <Badge variant="outline">{t.plans.default}</Badge>}
              </>
            }
          />
        </div>

        <Card className="py-4">
          <CardContent className="space-y-3 px-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium">{t.plans.stripe.title}</h2>
              {canWrite && <SyncPlanButton planId={plan.id} />}
            </div>
            <dl className="space-y-1.5 text-sm">
              {stripeRows.map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 border-b border-border/50 pb-1.5">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-mono text-xs">{value ?? t.plans.stripe.none}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        <PlanForm key={plan.updatedAt} plan={plan} canWrite={canWrite} />

        <div className="space-y-3">
          <h2 className="text-sm font-medium">{t.plans.history}</h2>
          <ActivityTable events={history} />
        </div>
      </PageBody>
    </PageContent>
  );
}
