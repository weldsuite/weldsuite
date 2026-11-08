import Link from '@/components/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { partnersCopy } from '@/lib/partners-copy';
import type { NewPartnerPageData } from './data';
import { NewPartnerForm } from './new-partner-form';

/** Rendered only for writers; the page's server function (fn.ts) redirects viewers. */
export function NewPartnerPage({
  planOptions,
  contractDefaults,
}: Readonly<Extract<NewPartnerPageData, { canWrite: true }>>) {
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
        <NewPartnerForm planOptions={planOptions} contractDefaults={contractDefaults} />
      </PageBody>
    </PageContent>
  );
}
