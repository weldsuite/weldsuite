import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { partnersCopy } from '@/lib/partners-copy';
import type { PartnerContractDefaultsPageData } from './data';
import { DefaultsForm } from './defaults-form';

export function PartnerContractDefaultsPage({
  planOptions,
  defaults,
  canWrite,
}: Readonly<PartnerContractDefaultsPageData>) {
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
        <DefaultsForm defaults={defaults} planOptions={planOptions} canWrite={canWrite} />
      </PageBody>
    </PageContent>
  );
}
