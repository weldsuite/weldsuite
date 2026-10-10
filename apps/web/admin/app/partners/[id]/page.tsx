import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { LoadError } from '@/components/partners/load-error';
import { PartnerStatusBadge } from '@/components/partners/badges';
import { requireAdmin } from '@/lib/auth';
import { listApps } from '@/lib/apps-data';
import { listPlanOptions } from '@/lib/billing-data';
import { getPartnerDetail } from '@/lib/partners-data';
import { partnersCopy } from '@/lib/partners-copy';
import { PartnerDetail } from './partner-detail';

export const dynamic = 'force-dynamic';

export default async function PartnerDetailPage(
  props: Readonly<{ params: Promise<{ id: string }>; searchParams?: Promise<{ tab?: string }> }>,
) {
  const identity = await requireAdmin();
  const { id } = await props.params;
  const { tab } = (await props.searchParams) ?? {};
  const t = partnersCopy();

  const result = await getPartnerDetail(identity, id);
  if (!result.ok && result.code === 'NOT_FOUND') notFound();

  const [plans, apps] = result.ok ? await Promise.all([listPlanOptions(), listApps()]) : [[], []];

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
            canWrite={identity.role !== 'viewer'}
            planOptions={plans}
            appOptions={apps.map((a) => ({ code: a.code, name: a.name }))}
            initialTab={tab}
            nowIso={new Date().toISOString()}
          />
        ) : (
          <LoadError code={result.code} message={result.error} />
        )}
      </PageBody>
    </PageContent>
  );
}
