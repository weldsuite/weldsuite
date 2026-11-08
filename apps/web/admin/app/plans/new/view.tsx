import Link from '@/components/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { adminCopy } from '@/lib/i18n';
import { PlanForm } from '../plan-form';
import type { NewPlanPageData } from './data';

export function NewPlanPage({ canWrite }: Readonly<NewPlanPageData>) {
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
          <PageHeading title={t.plans.newPlan} description={t.plans.description} />
        </div>
        <PlanForm plan={null} canWrite={canWrite} />
      </PageBody>
    </PageContent>
  );
}
