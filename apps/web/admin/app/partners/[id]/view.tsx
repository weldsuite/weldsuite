import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { LoadError } from '@/components/partners/load-error';
import { PartnerStatusBadge } from '@/components/partners/badges';
import { partnersCopy } from '@/lib/partners-copy';
import type { PartnerDetailPageData } from './data';
import { PartnerDetail } from './partner-detail';

export function PartnerDetailPage({
  result,
  canWrite,
  planOptions,
  appOptions,
  initialTab,
  nowIso,
}: Readonly<PartnerDetailPageData>) {
  const t = partnersCopy();

  return (
    <PageContent>
      <PageBody className="space-y-6">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2 text-muted-foreground">
            <Link href="/partners">
              <ArrowLeft className="h-4 w-4" />
              {t.common.backToPartners}
            </Link>
          </Button>
          {result.ok ? (
            <PageHeading
              title={result.data.partner.name}
              description={<span className="font-mono text-xs">{result.data.partner.id}</span>}
              actions={<PartnerStatusBadge status={result.data.partner.status} />}
            />
          ) : (
            <PageHeading title={t.list.title} />
          )}
        </div>

        {result.ok ? (
          <PartnerDetail
            detail={result.data}
            canWrite={canWrite}
            planOptions={planOptions}
            appOptions={appOptions}
            initialTab={initialTab}
            nowIso={nowIso}
          />
        ) : (
          <LoadError code={result.code} message={result.error} />
        )}
      </PageBody>
    </PageContent>
  );
}
