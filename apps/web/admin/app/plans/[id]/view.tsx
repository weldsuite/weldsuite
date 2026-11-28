import Link from '@/components/link';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { ActivityTable } from '@/components/billing/activity-table';
import { adminCopy } from '@/lib/i18n';
import { PlanForm } from '../plan-form';
import type { PlanDetailPageData } from './data';

export function PlanDetailPage({ plan, history, canWrite }: Readonly<PlanDetailPageData>) {
  const t = adminCopy();

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

        {/* There is no Stripe: a plan is its row alone. */}
        <p className="text-sm text-muted-foreground">{t.plans.noStripe}</p>

        <PlanForm key={plan.updatedAt} plan={plan} canWrite={canWrite} />

        <div className="space-y-3">
          <h2 className="text-sm font-medium">{t.plans.history}</h2>
          <ActivityTable events={history} />
        </div>
      </PageBody>
    </PageContent>
  );
}
