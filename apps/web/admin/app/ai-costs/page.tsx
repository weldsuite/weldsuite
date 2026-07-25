import { Card, CardContent } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { requireAdmin } from '@/lib/auth';
import {
  getGatewayCredits,
  getSpendByGatewayMonth,
  getTopModelsByCost,
  type GatewayCreditSummary,
} from '@/lib/ai-costs-data';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';

export const dynamic = 'force-dynamic';

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });

/** A rollup older than this means the cron is wedged and the numbers are stale. */
const ROLLUP_STALE_MS = 10 * 60 * 1000;

function remainingLabel(g: GatewayCreditSummary): string {
  if (g.allowanceNanoUsd === null && !g.allowanceExpiresAt) return 'no credit pool';
  if (g.remainingNanoUsd === null) return 'unlimited';
  return usd(g.remainingNanoUsd / 1e9);
}

export default async function AiCostsPage() {
  await requireAdmin();

  const [credits, byMonth, topModels] = await Promise.all([
    getGatewayCredits(),
    getSpendByGatewayMonth(),
    getTopModelsByCost(),
  ]);

  const now = Date.now();
  const stale = credits.filter(
    (c) => !c.lastRolledUpAt || now - c.lastRolledUpAt.getTime() > ROLLUP_STALE_MS,
  );

  return (
    <PageContent>
      <PageBody className="space-y-8">
        <PageHeading
          title="AI gateway costs"
          description="What each gateway costs us, versus what customers were charged. Customer pricing is identical across gateways by design — the difference is margin."
        />

        {stale.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <strong>Rollup may be stale.</strong> {stale.map((s) => s.gateway).join(', ')} last
            rolled up over 10 minutes ago. The credit rollup cron runs every minute in{' '}
            <code>workflow-worker</code>; while it is stuck, routing falls back to fee order.
          </div>
        )}

        <section className="space-y-3">
          <h2 className="text-lg font-medium">Service credit</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {credits.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No gateway credit rows yet — run the seed script (
                <code>packages/core/db/scripts/seed-ai-gateway-credits.ts</code>).
              </p>
            )}
            {credits.map((g) => (
              <Card key={g.gateway} className="py-4">
                <CardContent className="space-y-2 px-4">
                  <div className="flex items-center justify-between">
                    <span className="font-medium capitalize">{g.gateway}</span>
                    <span className="text-xs text-muted-foreground">
                      {g.enabled ? `priority ${g.priority}` : 'disabled'}
                    </span>
                  </div>
                  <dl className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Spent (period)</dt>
                      <dd className="tabular-nums">{usd(g.spentNanoUsd / 1e9)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Allowance</dt>
                      <dd className="tabular-nums">
                        {g.allowanceNanoUsd === null ? '—' : usd(g.allowanceNanoUsd / 1e9)}
                      </dd>
                    </div>
                    <div className="flex justify-between font-medium">
                      <dt>Remaining</dt>
                      <dd className="tabular-nums">{remainingLabel(g)}</dd>
                    </div>
                    {g.manualAdjustmentNanoUsd !== 0 && (
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Invoice true-up</dt>
                        <dd className="tabular-nums">{usd(g.manualAdjustmentNanoUsd / 1e9)}</dd>
                      </div>
                    )}
                  </dl>
                  <p className="text-xs text-muted-foreground">
                    Period ends {g.periodEnd.toISOString().slice(0, 10)}
                    {g.allowanceExpiresAt
                      ? ` · credit expires ${g.allowanceExpiresAt.toISOString().slice(0, 10)}`
                      : ''}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Spend is our <em>estimate</em>, derived from published list prices — it drifts from the
            real invoice (cached-token discounts, per-request fees). Reconcile monthly via the{' '}
            <code>manual_adjustment_nano_usd</code> column.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-medium">Margin by gateway &amp; month</h2>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader className="[&_tr]:border-border/70">
                <TableRow>
                  <TableHead className="text-[13.5px]">Month</TableHead>
                  <TableHead className="text-[13.5px]">Gateway</TableHead>
                  <TableHead className="text-right text-[13.5px]">Calls</TableHead>
                  <TableHead className="text-right text-[13.5px]">On credit</TableHead>
                  <TableHead className="text-right text-[13.5px]">We paid</TableHead>
                  <TableHead className="text-right text-[13.5px]">Billed</TableHead>
                  <TableHead className="text-right text-[13.5px]">Margin</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr]:border-border/70">
                {byMonth.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-10 text-center text-sm text-muted-foreground"
                    >
                      No AI usage recorded yet.
                    </TableCell>
                  </TableRow>
                )}
                {byMonth.map((r) => (
                  <TableRow key={`${r.month}-${r.gateway}`} className="h-10 hover:bg-muted/50">
                    <TableCell className="py-2 tabular-nums">{r.month}</TableCell>
                    <TableCell className="py-2 capitalize">{r.gateway}</TableCell>
                    <TableCell className="py-2 text-right tabular-nums">
                      {r.calls.toLocaleString()}
                    </TableCell>
                    <TableCell className="py-2 text-right tabular-nums">
                      {r.freeCalls.toLocaleString()}
                    </TableCell>
                    <TableCell className="py-2 text-right tabular-nums">{usd(r.costUsd)}</TableCell>
                    <TableCell className="py-2 text-right tabular-nums">
                      {usd(r.billedUsd)}
                    </TableCell>
                    <TableCell className="py-2 text-right font-medium tabular-nums">
                      {usd(r.billedUsd - r.costUsd)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-medium">Top models by cost (this month)</h2>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader className="[&_tr]:border-border/70">
                <TableRow>
                  <TableHead className="text-[13.5px]">Model</TableHead>
                  <TableHead className="text-[13.5px]">Gateway</TableHead>
                  <TableHead className="text-right text-[13.5px]">Calls</TableHead>
                  <TableHead className="text-right text-[13.5px]">We paid</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr]:border-border/70">
                {topModels.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="py-10 text-center text-sm text-muted-foreground"
                    >
                      No AI usage recorded yet.
                    </TableCell>
                  </TableRow>
                )}
                {topModels.map((m) => (
                  <TableRow key={`${m.modelId}-${m.gateway}`} className="h-10 hover:bg-muted/50">
                    <TableCell className="py-2 font-mono text-xs">{m.modelId}</TableCell>
                    <TableCell className="py-2 capitalize">{m.gateway}</TableCell>
                    <TableCell className="py-2 text-right tabular-nums">
                      {m.calls.toLocaleString()}
                    </TableCell>
                    <TableCell className="py-2 text-right tabular-nums">{usd(m.costUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      </PageBody>
    </PageContent>
  );
}
