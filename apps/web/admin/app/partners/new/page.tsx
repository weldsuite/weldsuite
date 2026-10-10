import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { requireAdmin } from '@/lib/auth';
import { listPlanOptions } from '@/lib/billing-data';
import { partnersCopy } from '@/lib/partners-copy';
import { NewPartnerForm } from './new-partner-form';

export const dynamic = 'force-dynamic';

export default async function NewPartnerPage() {
  const identity = await requireAdmin();
  if (identity.role === 'viewer') redirect('/partners');
  const plans = await listPlanOptions();
  const t = partnersCopy();

  return (
    <PageContent>
      <PageBody width="narrow" className="space-y-6">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2 text-muted-foreground">
            <Link href="/partners">
              <ArrowLeft className="h-4 w-4" />
              {t.common.backToPartners}
            </Link>
          </Button>
          <PageHeading title={t.new.title} description={t.new.description} />
        </div>
        <NewPartnerForm planOptions={plans} />
      </PageBody>
    </PageContent>
  );
}
