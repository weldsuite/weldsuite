import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { requireAdmin } from '@/lib/auth';
import { listPlanOptions } from '@/lib/billing-data';
import { getPartnerContractDefaults } from '@/lib/partner-contract-defaults-data';
import { partnersCopy } from '@/lib/partners-copy';
import { DefaultsForm } from './defaults-form';

export const dynamic = 'force-dynamic';

export default async function PartnerContractDefaultsPage() {
  const identity = await requireAdmin();
  const [plans, defaults] = await Promise.all([listPlanOptions(), getPartnerContractDefaults()]);
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
          <PageHeading title={t.defaults.title} description={t.defaults.description} />
        </div>
        <DefaultsForm defaults={defaults} planOptions={plans} canWrite={identity.role !== 'viewer'} />
      </PageBody>
    </PageContent>
  );
}
