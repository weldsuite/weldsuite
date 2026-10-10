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
import { LoadError } from '@/components/partners/load-error';
import { PartnerStatusBadge } from '@/components/partners/badges';
import { requireAdmin } from '@/lib/auth';
import { formatDay } from '@/lib/billing-format';
import { fill } from '@/lib/i18n';
import { listPartners } from '@/lib/partners-data';
import { partnersCopy } from '@/lib/partners-copy';

export const dynamic = 'force-dynamic';

export default async function PartnersPage() {
  const identity = await requireAdmin();
  const result = await listPartners(identity);
  const t = partnersCopy().list;

  return (
    <PageContent>
      <PageBody className="space-y-6">
        <PageHeading
          title={t.title}
          description={t.description}
          actions={
            identity.role !== 'viewer' && (
              <Button asChild size="sm">
                <Link href="/partners/new">
                  <Plus className="h-4 w-4" />
                  {t.newPartner}
                </Link>
              </Button>
            )
          }
        />

        {!result.ok ? (
          <LoadError code={result.code} message={result.error} />
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.columns.partner}</TableHead>
                  <TableHead className="w-32">{t.columns.status}</TableHead>
                  <TableHead>{t.columns.billingEmail}</TableHead>
                  <TableHead className="w-28 text-right">{t.columns.workspaces}</TableHead>
                  <TableHead className="w-36">{t.columns.territories}</TableHead>
                  <TableHead className="w-32">{t.columns.overdue}</TableHead>
                  <TableHead className="w-32">{t.columns.created}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-16 text-center text-sm text-muted-foreground">
                      {t.empty}
                    </TableCell>
                  </TableRow>
                )}
                {result.data.map((partner) => (
                  <TableRow key={partner.id} className="h-12 hover:bg-muted/50">
                    <TableCell>
                      <Link href={`/partners/${partner.id}`} className="font-medium underline-offset-2 hover:underline">
                        {partner.name}
                      </Link>
                      <div className="font-mono text-[11px] text-muted-foreground">{partner.id}</div>
                    </TableCell>
                    <TableCell>
                      <PartnerStatusBadge status={partner.status} />
                    </TableCell>
                    <TableCell className="text-sm">{partner.billingEmail}</TableCell>
                    <TableCell className="text-right tabular-nums">{partner.workspaceCount}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {partner.territories.length === 0
                        ? t.noTerritories
                        : partner.territories.length <= 4
                          ? partner.territories.join(', ')
                          : fill(t.territoriesCount, { count: partner.territories.length })}
                    </TableCell>
                    <TableCell>
                      {partner.overdueStatementCount > 0 ? (
                        <Badge variant="warning">{fill(t.overdueCount, { count: partner.overdueStatementCount })}</Badge>
                      ) : (
                        <span className="text-muted-foreground">{t.notOverdue}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatDay(partner.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </PageBody>
    </PageContent>
  );
}
