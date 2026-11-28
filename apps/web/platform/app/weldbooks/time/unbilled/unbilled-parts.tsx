/**
 * The pieces of the Unbilled time page: the customers on the left, a customer's hours grouped by
 * project (each hour has a checkbox), the preview of the invoice lines and its totals, and the
 * choice of a draft invoice to add the hours to.
 */

import { useMemo, useState } from 'react';
import { Link } from '@/lib/router';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { useInfiniteAccountingInvoices } from '@/hooks/queries/use-accounting-queries';
import type { UnbilledCustomer, UnbilledProject } from '@/lib/api/domains/weldbooks-time-billing';
import { useI18n } from '@/lib/i18n/provider';
import { plural } from '@/lib/i18n/plural';
import { cn } from '@/lib/utils';
import { type PreviewLine, type TimeTotals } from '@/lib/weldbooks/time-billing';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

/** One row of the customer list is a customer in one currency. */
export function customerKey(customer: UnbilledCustomer): string {
  return `${customer.customer.contactId}:${customer.currency}`;
}

// ─── Customers ─────────────────────────────────────────────────────────────

export function CustomerList({
  customers,
  selectedKey,
  onSelect,
}: Readonly<{ customers: UnbilledCustomer[]; selectedKey: string | null; onSelect: (key: string) => void }>) {
  const { t, language } = useI18n();
  const copy = t.weldbooksContactPage.unbilled;
  const { formatMoney, formatNumber } = useWeldbooksFormat();
  return (
    <nav aria-label={copy.customers} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <h2 className="px-4 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {copy.customersLabel}
      </h2>
      <ul className="m-0 list-none p-0">
        {customers.map((customer) => {
          const key = customerKey(customer);
          const active = key === selectedKey;
          return (
            <li key={key}>
              <button
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => onSelect(key)}
                className={cn(
                  'flex w-full items-start gap-3 border-l-2 px-4 py-3 text-left outline-none transition-colors',
                  'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'border-primary bg-accent/60' : 'border-transparent',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{customer.customer.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {plural(customer.projects.length, copy.projectCount, language)}
                  </span>
                </span>
                <span className="flex-shrink-0 text-right">
                  <span className="block text-sm font-medium tabular-nums">
                    {copy.hours.replace('{hours}', formatNumber(customer.hours))}
                  </span>
                  <span className="block text-xs tabular-nums text-muted-foreground">
                    {formatMoney(customer.amount, customer.currency)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ─── Entries ───────────────────────────────────────────────────────────────

/** "rate €95.00 an hour from the project": what the entries of a project share, when they share it. */
function rateNote(
  project: UnbilledProject,
  currency: string,
  templates: Readonly<Record<'entry' | 'project' | 'member', string>>,
  formatMoney: (value: string, currency: string) => string,
): string | null {
  const first = project.entries[0];
  if (!first || first.rateSource === 'none') return null;
  const same = project.entries.every((entry) => entry.rateSource === first.rateSource && entry.rate === first.rate);
  if (!same) return null;
  return templates[first.rateSource].replace('{rate}', formatMoney(first.rate, currency));
}

export function EntriesTable({
  customer,
  unchecked,
  onToggle,
  onToggleProject,
}: Readonly<{
  customer: UnbilledCustomer;
  /** The entries left out: all are in until the person unticks one. */
  unchecked: ReadonlySet<string>;
  onToggle: (entryId: string) => void;
  onToggleProject: (project: UnbilledProject, checked: boolean) => void;
}>) {
  const { t } = useI18n();
  const copy = t.weldbooksContactPage.unbilled;
  const { formatMoney, formatDate, formatNumber } = useWeldbooksFormat();
  return (
    <div
      role="region"
      aria-label={copy.caption.replace('{customer}', customer.customer.name)}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className="overflow-x-auto"
    >
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{copy.caption.replace('{customer}', customer.customer.name)}</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th scope="col" className="w-10 px-3 py-2">
              <span className="sr-only">{copy.what}</span>
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              {copy.date}
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              {copy.who}
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              {copy.what}
            </th>
            <th scope="col" className="px-2 py-2 text-right font-medium">
              {copy.hoursColumn}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {copy.amount}
            </th>
          </tr>
        </thead>
        {customer.projects.map((project) => {
          const ticked = project.entries.filter((entry) => !unchecked.has(entry.id)).length;
          const all = ticked === project.entries.length;
          const note = rateNote(
            project,
            customer.currency,
            { entry: copy.rateFromEntry, project: copy.rateFromProject, member: copy.rateFromMember },
            formatMoney,
          );
          const unrated = project.entries.some((entry) => entry.rateSource === 'none');
          return (
            <tbody key={project.projectId} className="border-b border-border last:border-b-0">
              <tr className="bg-muted/40">
                <th scope="rowgroup" colSpan={6} className="px-3 py-2 text-left font-normal">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Checkbox
                      checked={all ? true : ticked === 0 ? false : 'indeterminate'}
                      onCheckedChange={(checked) => onToggleProject(project, checked === true)}
                      aria-label={copy.selectAll.replace('{project}', project.name)}
                    />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {copy.project}
                    </span>
                    <span className="font-medium">{project.name}</span>
                    {note ? <span className="text-xs text-muted-foreground">· {note}</span> : null}
                    {unrated ? (
                      <>
                        <SoftBadge tone="warning">{copy.noRate}</SoftBadge>
                        <Link
                          href={`/weldflow/project/${encodeURIComponent(project.projectId)}/settings`}
                          className="text-xs text-primary underline-offset-2 hover:underline"
                        >
                          {copy.setRate}
                        </Link>
                      </>
                    ) : null}
                  </div>
                </th>
              </tr>
              {project.entries.map((entry) => {
                const checked = !unchecked.has(entry.id);
                return (
                  <tr key={entry.id} className={cn('border-t border-border', !checked && 'text-muted-foreground')}>
                    <td className="px-3 py-2">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => onToggle(entry.id)}
                        aria-label={copy.selectEntry
                          .replace('{date}', formatDate(entry.date))
                          .replace('{who}', entry.userName)}
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 tabular-nums">{formatDate(entry.date)}</td>
                    <td className="px-2 py-2">{entry.userName}</td>
                    <td className="px-2 py-2">
                      {entry.description || entry.activity || '—'}
                      {entry.rateSource === 'none' ? (
                        <span className="ml-2 inline-block align-middle">
                          <SoftBadge tone="warning">{copy.noRate}</SoftBadge>
                        </span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{formatNumber(entry.hours)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                      {formatMoney(entry.amount, customer.currency)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

// ─── Preview ───────────────────────────────────────────────────────────────

export function InvoicePreview({
  lines,
  totals,
  currency,
  hasUnrated,
}: Readonly<{ lines: PreviewLine[]; totals: TimeTotals; currency: string; hasUnrated: boolean }>) {
  const { t } = useI18n();
  const copy = t.weldbooksContactPage.unbilled;
  const { formatMoney, formatNumber } = useWeldbooksFormat();
  return (
    <section aria-labelledby="unbilled-preview" className="space-y-3">
      <h2 id="unbilled-preview" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {copy.previewTitle}
      </h2>
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">{copy.previewEmpty}</p>
      ) : (
        <ul className="m-0 list-none space-y-2 p-0">
          {lines.map((line) => (
            <li key={line.entryIds.join(',')} className="flex items-start justify-between gap-3 text-sm">
              <span className="min-w-0 break-words">{line.description}</span>
              <span className="flex-shrink-0 font-medium tabular-nums">{formatMoney(line.amount, currency)}</span>
            </li>
          ))}
        </ul>
      )}
      <dl className="space-y-1 border-t border-border pt-3 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">{copy.totalHours}</dt>
          <dd className="tabular-nums">{copy.hours.replace('{hours}', formatNumber(totals.hours))}</dd>
        </div>
        <div className="flex justify-between font-semibold">
          <dt>{copy.totalExcl}</dt>
          <dd className="tabular-nums">{formatMoney(totals.amount, currency)}</dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">{copy.vatNote}</p>
      {hasUnrated ? <p className="text-xs text-amber-700 dark:text-amber-400">{copy.noRateHint}</p> : null}
    </section>
  );
}

// ─── Add to a draft ────────────────────────────────────────────────────────

/** Drafts of one customer in the currency the hours bill in. */
export function DraftPickerDialog({
  open,
  onOpenChange,
  contactId,
  currency,
  pending,
  onPick,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  currency: string;
  pending: boolean;
  onPick: (invoiceId: string) => void;
}>) {
  const { t } = useI18n();
  const copy = t.weldbooksContactPage.unbilled;
  const { formatMoney } = useWeldbooksFormat();
  const drafts = useInfiniteAccountingInvoices({ contactId, status: 'draft', type: 'invoice' }, { enabled: open });
  const rows = useMemo(
    () => (drafts.data?.rows ?? []).filter((invoice) => invoice.status === 'draft' && (invoice.currency ?? currency) === currency),
    [drafts.data?.rows, currency],
  );
  const [choice, setChoice] = useState<string>('');
  const picked = rows.some((row) => row.id === choice) ? choice : (rows[0]?.id ?? '');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.chooseDraftTitle}</DialogTitle>
          <DialogDescription>{copy.chooseDraftDescription}</DialogDescription>
        </DialogHeader>
        {drafts.isLoading ? (
          <InlineSpinner className="py-6" />
        ) : rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">{copy.noDrafts}</p>
        ) : (
          <RadioGroup value={picked} onValueChange={setChoice} aria-label={copy.chooseDraftTitle}>
            {rows.map((invoice) => (
              <div key={invoice.id} className="flex items-center gap-2">
                <RadioGroupItem value={invoice.id} id={`draft-${invoice.id}`} />
                <Label htmlFor={`draft-${invoice.id}`} className="font-normal">
                  {copy.draftOption
                    .replace('{number}', invoice.invoiceNumber ?? copy.draftNoNumber)
                    .replace('{total}', formatMoney(invoice.total ?? '0', invoice.currency))}
                </Label>
              </div>
            ))}
          </RadioGroup>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {copy.cancel}
          </Button>
          <Button type="button" disabled={!picked || pending} onClick={() => onPick(picked)}>
            {copy.add}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
