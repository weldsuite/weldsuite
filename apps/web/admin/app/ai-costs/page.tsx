import { requireAdmin } from '@/lib/auth';
import {
  getGatewayCredits,
  getSpendByGatewayMonth,
  getTopModelsByCost,
  type GatewayCreditSummary,
} from '@/lib/ai-costs-data';

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
    <div className="p-6 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">AI gateway costs</h1>
        <p className="text-sm text-muted-foreground mt-1">
          What each gateway costs us, versus what customers were charged. Customer pricing is
          identical across gateways by design — the difference is margin.
        </p>
      </header>

      {stale.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <strong>Rollup may be stale.</strong> {stale.map((s) => s.gateway).join(', ')} last rolled
          up over 10 minutes ago. The credit rollup cron runs every minute in{' '}
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
            <div key={g.gateway} className="rounded-lg border p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-medium capitalize">{g.gateway}</span>
                <span className="text-xs text-muted-foreground">
                  {g.enabled ? `priority ${g.priority}` : 'disabled'}
                </span>
              </div>
              <dl className="text-sm space-y-1">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Spent (period)</dt>
                  <dd>{usd(g.spentNanoUsd / 1e9)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Allowance</dt>
                  <dd>{g.allowanceNanoUsd === null ? '—' : usd(g.allowanceNanoUsd / 1e9)}</dd>
                </div>
                <div className="flex justify-between font-medium">
                  <dt>Remaining</dt>
                  <dd>{remainingLabel(g)}</dd>
                </div>
                {g.manualAdjustmentNanoUsd !== 0 && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Invoice true-up</dt>
                    <dd>{usd(g.manualAdjustmentNanoUsd / 1e9)}</dd>
                  </div>
                )}
              </dl>
              <p className="text-xs text-muted-foreground">
                Period ends {g.periodEnd.toISOString().slice(0, 10)}
                {g.allowanceExpiresAt
                  ? ` · credit expires ${g.allowanceExpiresAt.toISOString().slice(0, 10)}`
                  : ''}
              </p>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Spend is our <em>estimate</em>, derived from published list prices — it drifts from the real
          invoice (cached-token discounts, per-request fees). Reconcile monthly via the{' '}
          <code>manual_adjustment_nano_usd</code> column.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Margin by gateway &amp; month</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left border-b">
                <th className="py-2 pr-4 font-medium">Month</th>
                <th className="py-2 pr-4 font-medium">Gateway</th>
                <th className="py-2 pr-4 font-medium text-right">Calls</th>
                <th className="py-2 pr-4 font-medium text-right">On credit</th>
                <th className="py-2 pr-4 font-medium text-right">We paid</th>
                <th className="py-2 pr-4 font-medium text-right">Billed</th>
                <th className="py-2 font-medium text-right">Margin</th>
              </tr>
            </thead>
            <tbody>
              {byMonth.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-4 text-muted-foreground">
                    No AI usage recorded yet.
                  </td>
                </tr>
              )}
              {byMonth.map((r) => (
                <tr key={`${r.month}-${r.gateway}`} className="border-b last:border-0">
                  <td className="py-2 pr-4">{r.month}</td>
                  <td className="py-2 pr-4 capitalize">{r.gateway}</td>
                  <td className="py-2 pr-4 text-right">{r.calls.toLocaleString()}</td>
                  <td className="py-2 pr-4 text-right">{r.freeCalls.toLocaleString()}</td>
                  <td className="py-2 pr-4 text-right">{usd(r.costUsd)}</td>
                  <td className="py-2 pr-4 text-right">{usd(r.billedUsd)}</td>
                  <td className="py-2 text-right font-medium">{usd(r.billedUsd - r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Top models by cost (this month)</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left border-b">
                <th className="py-2 pr-4 font-medium">Model</th>
                <th className="py-2 pr-4 font-medium">Gateway</th>
                <th className="py-2 pr-4 font-medium text-right">Calls</th>
                <th className="py-2 font-medium text-right">We paid</th>
              </tr>
            </thead>
            <tbody>
              {topModels.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-muted-foreground">
                    No AI usage recorded yet.
                  </td>
                </tr>
              )}
              {topModels.map((m) => (
                <tr key={`${m.modelId}-${m.gateway}`} className="border-b last:border-0">
                  <td className="py-2 pr-4 font-mono text-xs">{m.modelId}</td>
                  <td className="py-2 pr-4 capitalize">{m.gateway}</td>
                  <td className="py-2 pr-4 text-right">{m.calls.toLocaleString()}</td>
                  <td className="py-2 text-right">{usd(m.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
