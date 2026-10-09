'use client';

import { useParams } from 'next/navigation';
import { ChangeEvent, FormEvent, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import type { Dictionary, Locale } from '@/lib/i18n';
import { useMe } from '@/lib/me-context';
import { usePortalQuery } from '@/lib/hooks/use-portal-query';
import { PortalApiError, portalPost, portalUpload, portalUrl } from '@/lib/client';
import { formatDate, todayIso } from '@/lib/date';
import type {
  Declaration,
  DeclarationCategory,
  DeclarationCurrency,
  DeclarationStatus,
  EmployeeDeclarations,
} from '@/lib/types';
import { Button, Card, Input, Label, PageHeader, Select, Textarea } from '@/components/ui/primitives';
import { Badge } from '@/components/ui/badge';
import { LoadingState, ErrorState, EmptyState } from '@/components/ui/states';

const STATUS_TONE = {
  pending: 'warning',
  approved: 'positive',
  rejected: 'negative',
  paid: 'info',
  cancelled: 'neutral',
} as const satisfies Record<DeclarationStatus, string>;

const CATEGORIES: DeclarationCategory[] = ['travel', 'meals', 'accommodation', 'equipment', 'training', 'other'];
const CURRENCIES: DeclarationCurrency[] = ['EUR', 'USD', 'GBP'];

const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const RECEIPT_ACCEPT = RECEIPT_TYPES.join(',');
const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

function formatMoney(amount: number, currency: string, locale: Locale): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
  } catch {
    // An unknown currency code makes Intl throw; show the plain figure instead.
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** The reason a receipt can't be uploaded, or null when it is fine to send. */
function receiptProblem(file: File, dict: Dictionary): string | null {
  if (!RECEIPT_TYPES.includes(file.type)) return dict.declarations.receiptWrongType;
  if (file.size > RECEIPT_MAX_BYTES) return dict.declarations.receiptTooLarge;
  return null;
}

export default function DeclarationsView() {
  const slug = String(useParams().workspace ?? '');
  const me = useMe();
  const { dict, locale, timeZone, format } = useI18n();
  const { data, loading, error, refetch } = usePortalQuery<EmployeeDeclarations>(slug, '/employee/declarations');

  const [expenseDate, setExpenseDate] = useState(todayIso());
  const [category, setCategory] = useState<DeclarationCategory>('travel');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<DeclarationCurrency>('EUR');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // The declaration exists but its receipt didn't make it: not an error of the whole submit.
  const [receiptWarning, setReceiptWarning] = useState(false);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const canFile = me.kind === 'employee' && me.config.features.declarations;
  const today = todayIso();

  function pickFile(e: ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    setFormError(null);
    if (picked) {
      const problem = receiptProblem(picked, dict);
      if (problem) {
        setFormError(problem);
        e.target.value = '';
        setFile(null);
        return;
      }
    }
    setFile(picked);
  }

  async function submitDeclaration(e: FormEvent) {
    e.preventDefault();
    const value = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(value) || value <= 0) {
      setFormError(dict.declarations.invalidAmount);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    setReceiptWarning(false);
    let created: Declaration;
    try {
      created = await portalPost<Declaration>(slug, '/employee/declarations', {
        expenseDate,
        category,
        description: description.trim(),
        amount: value,
        currency,
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : dict.errors.generic);
      setSubmitting(false);
      return;
    }

    // Filing is two calls. From here on the declaration exists, whatever happens to the receipt.
    if (file) {
      try {
        const form = new FormData();
        form.append('file', file);
        await portalUpload<Declaration>(slug, `/employee/declarations/${created.id}/receipt`, form);
      } catch {
        setReceiptWarning(true);
      }
    }
    setAmount('');
    setDescription('');
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
    setSubmitting(false);
    refetch();
  }

  async function withdraw(id: string) {
    setWithdrawingId(id);
    setRowError(null);
    try {
      await portalPost<Declaration>(slug, `/employee/declarations/${id}/cancel`);
      refetch();
    } catch (err) {
      setRowError({ id, message: err instanceof Error ? err.message : dict.errors.generic });
    } finally {
      setWithdrawingId(null);
    }
  }

  async function attachReceipt(id: string, e: ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = '';
    if (!picked) return;
    const problem = receiptProblem(picked, dict);
    if (problem) {
      setRowError({ id, message: problem });
      return;
    }
    setUploadingId(id);
    setRowError(null);
    setReceiptWarning(false);
    try {
      const form = new FormData();
      form.append('file', picked);
      await portalUpload<Declaration>(slug, `/employee/declarations/${id}/receipt`, form);
      refetch();
    } catch (err) {
      const conflict = err instanceof PortalApiError && err.status === 409;
      setRowError({ id, message: conflict && err.message ? err.message : dict.declarations.receiptUploadFailed });
    } finally {
      setUploadingId(null);
    }
  }

  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState onRetry={refetch} />;

  return (
    <div className="space-y-6">
      <PageHeader title={dict.declarations.title} />

      <Card>
        <h2 className="font-medium text-gray-900 mb-3">{dict.declarations.openTotals}</h2>
        {data.open.length === 0 ? (
          <EmptyState message={dict.declarations.nothingOutstanding} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.open.map((o) => (
              <div key={o.currency} className="rounded-md border border-gray-100 p-3">
                <p className="text-sm font-medium text-gray-900">{o.currency}</p>
                <dl className="mt-1 text-xs text-gray-500 space-y-0.5">
                  <div className="flex justify-between">
                    <dt>{dict.declarations.awaitingDecision}</dt>
                    <dd>{formatMoney(o.pending, o.currency, locale)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>{dict.declarations.approvedUnpaid}</dt>
                    <dd>{formatMoney(o.approved, o.currency, locale)}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <h2 className="font-medium text-gray-900 mb-3">{dict.declarations.newDeclaration}</h2>
        {!canFile ? (
          <p className="text-sm text-gray-500">{dict.declarations.disabled}</p>
        ) : (
          <form onSubmit={submitDeclaration} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <Label htmlFor="expenseDate">{dict.declarations.expenseDate}</Label>
                <Input
                  id="expenseDate"
                  type="date"
                  value={expenseDate}
                  max={today}
                  onChange={(e) => setExpenseDate(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="category">{dict.declarations.category}</Label>
                <Select id="category" value={category} onChange={(e) => setCategory(e.target.value as DeclarationCategory)}>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {dict.declarations.categories[c]}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="amount">{dict.declarations.amount}</Label>
                <Input
                  id="amount"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="currency">{dict.declarations.currency}</Label>
                <Select id="currency" value={currency} onChange={(e) => setCurrency(e.target.value as DeclarationCurrency)}>
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div>
              <Label htmlFor="description">{dict.declarations.description}</Label>
              <Textarea
                id="description"
                rows={3}
                placeholder={dict.declarations.descriptionPlaceholder}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="receipt">
                {dict.declarations.receipt} <span className="text-gray-400 font-normal">({dict.common.optional})</span>
              </Label>
              <Input id="receipt" ref={fileInput} type="file" accept={RECEIPT_ACCEPT} onChange={pickFile} />
              <p className="mt-1 text-xs text-gray-500">{dict.declarations.receiptHint}</p>
            </div>
            {formError && <p className="text-sm text-red-600">{formError}</p>}
            {receiptWarning && <p className="text-sm text-amber-700">{dict.declarations.receiptFailed}</p>}
            <Button type="submit" disabled={submitting}>
              {dict.declarations.submit}
            </Button>
          </form>
        )}
      </Card>

      <Card>
        <h2 className="font-medium text-gray-900 mb-3">{dict.declarations.history}</h2>
        {data.declarations.length === 0 ? (
          <EmptyState message={dict.declarations.empty} />
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.declarations.map((d) => (
              <li key={d.id} className="py-3 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900">
                    {formatMoney(d.amount, d.currency, locale)} · {dict.declarations.categories[d.category]}
                  </p>
                  <p className="text-xs text-gray-500">
                    {formatDate(d.expenseDate, locale, timeZone)}
                    {d.paidAt && ` · ${format(dict.declarations.paidOn, { date: formatDate(d.paidAt, locale, timeZone) })}`}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5 break-words">{d.description}</p>
                  {d.reviewNote && <p className="text-xs text-gray-500 mt-0.5 break-words">{d.reviewNote}</p>}
                  {d.hasReceipt && (
                    <a
                      href={portalUrl(slug, `/employee/declarations/${d.id}/receipt`)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-0.5 inline-block text-xs portal-link underline underline-offset-2"
                    >
                      {dict.declarations.viewReceipt}
                    </a>
                  )}
                  {rowError?.id === d.id && <p className="text-xs text-red-600 mt-0.5">{rowError.message}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={STATUS_TONE[d.status]}>{dict.declarations.status[d.status]}</Badge>
                  {d.status === 'pending' && (
                    <>
                      <label className="text-xs text-gray-500 underline underline-offset-2 cursor-pointer rounded focus-within:ring-2 focus-within:ring-gray-400 has-[:disabled]:opacity-50">
                        {uploadingId === d.id
                          ? dict.declarations.uploading
                          : d.hasReceipt
                            ? dict.declarations.replaceReceipt
                            : dict.declarations.addReceipt}
                        <input
                          type="file"
                          accept={RECEIPT_ACCEPT}
                          className="sr-only"
                          disabled={uploadingId === d.id}
                          onChange={(e) => void attachReceipt(d.id, e)}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={withdrawingId === d.id}
                        onClick={() => void withdraw(d.id)}
                        className="text-xs text-gray-500 underline underline-offset-2 disabled:opacity-50"
                      >
                        {dict.declarations.withdraw}
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
