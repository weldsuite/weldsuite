// Client-safe helpers for plan billing on Mollie (Kubernetes editions, ADR
// BILL-014) and for the billing history rows it writes next to Global's
// Stripe mirror.

import type { MollieBillingAccount } from './billing-types';
import type { MollieBillingCopy } from './mollie-billing-copy';

/**
 * Where staff change billing on Kubernetes: the `weldsuite` binary in the
 * server pod (rust/bins/weldsuite/src/admin.rs).
 */
export const BILLING_CLI_PREFIX = 'kubectl -n weldsuite exec deploy/weldsuite -- weldsuite admin billing';

export type BillingCliCommand = keyof Omit<MollieBillingCopy['cli'], 'intro'>;

/** The `weldsuite admin billing` commands for one workspace, after {@link BILLING_CLI_PREFIX}. */
export function billingCliCommands(workspaceId: string): Array<{ key: BillingCliCommand; args: string }> {
  const change = '--as <email> --reason <text>';
  return [
    { key: 'show', args: `show ${workspaceId}` },
    {
      key: 'comp',
      args: `comp ${workspaceId} [--plan <id|slug>] [--seats <n>] [--until <YYYY-MM-DD>|none] ${change}`,
    },
    { key: 'uncomp', args: `uncomp ${workspaceId} ${change}` },
    { key: 'refund', args: `refund <bpy_…|tr_…> [--amount <cents>] ${change}` },
    { key: 'retryNow', args: `retry-now ${workspaceId} ${change}` },
  ];
}

/** `creditcard` → "Card"; an unknown method falls through as-is. */
export function mandateMethodLabel(copy: MollieBillingCopy, method: string | null): string | null {
  if (!method) return null;
  return (copy.methods as Record<string, string>)[method] ?? method;
}

/** "Visa •••• 4242", "NL91 •••• 4300 · SEPA Direct Debit", "Card", or "None". */
export function mandateSummary(
  copy: MollieBillingCopy,
  account: Pick<MollieBillingAccount, 'mandateLabel' | 'mandateMethod'>,
): string {
  const method = mandateMethodLabel(copy, account.mandateMethod);
  if (account.mandateLabel) {
    return method && account.mandateMethod !== 'creditcard' ? `${account.mandateLabel} · ${method}` : account.mandateLabel;
  }
  return method ?? copy.none;
}

/** What a Mollie charge was for; unknown kinds fall through with spaces. */
export function paymentKindLabel(copy: MollieBillingCopy, kind: string | null): string | null {
  if (!kind) return null;
  return (copy.history.kinds as Record<string, string>)[kind] ?? kind.replace(/_/g, ' ');
}

/**
 * A history row Stripe holds (Global). Its refund and void run through the
 * billing worker; any other provider's row (Mollie, WeldBooks) can't.
 */
export function isStripeRow(row: { provider: string | null | undefined }): boolean {
  return (row.provider ?? 'stripe') === 'stripe';
}

/**
 * Only absolute http(s) links open from the console. A WeldBooks invoice's
 * `pdf_url` is a platform API path (`/api/billing/invoices/:id/document`) that
 * needs the customer's session, so it would 404 here.
 */
export function isAbsoluteUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}
