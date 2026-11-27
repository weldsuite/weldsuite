/**
 * The review screen (`/weldbooks/documents/{id}/review`): the original document
 * on the left, the form that books it on the right. The form starts from what
 * the scan and the supplier's history say, so a known supplier's bill needs no
 * changes: check it, press Save and next. Booking makes the bill, receipt or
 * credit note, pays it when it can, and opens the next document to check.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useAtom } from 'jotai';
import { ArrowLeft, Ban, CheckCircle2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Kbd } from '@weldsuite/ui/components/kbd';
import { Label } from '@weldsuite/ui/components/label';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { usePermissions } from '@weldsuite/permissions/react';
import { SourceDocumentViewer } from '@/components/accounting/source-document-viewer';
import { RecordLink } from '@/components/object-panel/record-link';
import { useAccountingAccounts, useAccountingTaxRates } from '@/hooks/queries/use-accounting-queries';
import {
  useBankCandidates,
  useBookDocument,
  useBookingDefaults,
  useDocumentDuplicates,
  useDocumentPrefill,
  useInboxDocument,
  useNextDocuments,
  useRejectDocument,
} from '@/hooks/queries/use-weldbooks-receipts-queries';
import { useCurrentEntityCurrency } from '@/hooks/use-current-entity-currency';
import type { Account } from '@/lib/api/domains/weldbooks';
import type { DocumentPrefill, InboxDocument } from '@/lib/api/domains/weldbooks-receipts';
import { useI18n } from '@/lib/i18n/provider';
import { Link, useRouter } from '@/lib/router';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { BookedBanner, lastBookedAtom, summarizeBooking, type BookedSummary } from './booked-banner';
import { DuplicateWarning } from './duplicate-warning';
import { LinesEditor } from './lines-editor';
import { PaidWithList } from './paid-with';
import {
  REVIEW_KINDS,
  applyBookingDefaults,
  buildBookInput,
  candidateOverrides,
  canPayWith,
  initialPaidChoice,
  initialReviewState,
  isEnterOwnedBy,
  nextDocumentId,
  reviewProblem,
  type PaidChoice,
  type ReviewKind,
  type ReviewProblem,
  type ReviewState,
} from './review-model';
import { SupplierSection } from './supplier-section';

const INBOX_PATH = '/weldbooks/documents';

/** The address of a document's review screen. */
export function reviewPath(documentId: string): string {
  return `${INBOX_PATH}/${encodeURIComponent(documentId)}/review`;
}

export function ReviewScreen({ documentId }: Readonly<{ documentId: string }>) {
  const { t } = useI18n();
  const tr = t.weldbooksReceipts.review;
  const doc = useInboxDocument(documentId);
  const prefill = useDocumentPrefill(documentId);

  if (doc.isError) {
    return (
      <div className="p-6">
        <ErrorState message={tr.loadFailed} onRetry={() => void doc.refetch()} />
      </div>
    );
  }
  if (!doc.data || (prefill.isPending && doc.data.status !== 'linked')) return <PageLoader fullScreen={false} />;
  return (
    <ReviewForm
      key={documentId}
      doc={doc.data}
      prefill={prefill.data ?? null}
      prefillFailed={prefill.isError && doc.data.status !== 'linked'}
    />
  );
}

function BackLink() {
  const { t } = useI18n();
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2">
      <Link href={INBOX_PATH}>
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t.weldbooksReceipts.review.back}
      </Link>
    </Button>
  );
}

interface ReviewFormProps {
  doc: InboxDocument;
  prefill: DocumentPrefill | null;
  prefillFailed: boolean;
}

function ReviewForm({ doc, prefill, prefillFailed }: Readonly<ReviewFormProps>) {
  const { t } = useI18n();
  const tr = t.weldbooksReceipts.review;
  const router = useRouter();
  const { can } = usePermissions();
  const { today } = useWeldbooksFormat();
  const { entityCurrency } = useCurrentEntityCurrency();
  const [state, setState] = useState<ReviewState>(() => initialReviewState(prefill, today()));
  const [choice, setChoice] = useState<ReviewKind>(() => state.kind);
  const [showProblem, setShowProblem] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [finished, setFinished] = useState<BookedSummary | null>(null);
  const [lastBooked, setLastBooked] = useAtom(lastBookedAtom);
  const paidTouched = useRef(false);

  const canBook = can('bills:create') && can('bills:update');
  const canReject = can('invoices:update');
  const canReadBank = can('banking:read');
  const alreadyBooked = doc.status === 'linked';
  const book = useBookDocument();
  const reject = useRejectDocument();
  const nextDocs = useNextDocuments();

  const accountsQuery = useAccountingAccounts();
  const accounts = useMemo(() => (accountsQuery.data?.data ?? []) as Account[], [accountsQuery.data]);
  const taxRatesQuery = useAccountingTaxRates();
  const taxRates = useMemo(() => taxRatesQuery.data?.data ?? [], [taxRatesQuery.data]);

  const duplicates = useDocumentDuplicates(doc.id);
  const defaults = useBookingDefaults(state.contactId);
  const candidates = useBankCandidates(doc.id, candidateOverrides(state), {
    enabled: canReadBank && choice !== 'not_for_books' && canPayWith(state.kind) && !alreadyBooked,
  });

  // A supplier's usual category, VAT and project fill the lines that have none.
  useEffect(() => {
    if (!defaults.data) return;
    setState((current) => {
      const lines = applyBookingDefaults(current.lines, defaults.data);
      const changed = lines.some((line, index) => {
        const before = current.lines[index];
        return line.accountId !== before.accountId || line.taxRateId !== before.taxRateId || line.projectId !== before.projectId;
      });
      return changed ? { ...current, lines } : current;
    });
  }, [defaults.data]);

  // The sure bank line is preselected until the person picks something else.
  useEffect(() => {
    if (!candidates.data || paidTouched.current) return;
    setState((current) => ({ ...current, paid: initialPaidChoice(current.kind, prefill, candidates.data) }));
  }, [candidates.data, prefill]);

  // A chosen bank line that the search no longer offers (the amount or date changed) falls back to not paid yet.
  useEffect(() => {
    if (!candidates.data || candidates.isFetching) return;
    const paid = state.paid;
    if (paid.type === 'bank_transaction' && !candidates.data.some((candidate) => candidate.id === paid.bankTransactionId)) {
      setState((current) => ({ ...current, paid: { type: 'none' } }));
    }
  }, [candidates.data, candidates.isFetching, state.paid]);

  const problem: ReviewProblem | null = reviewProblem(state);
  const currency = state.currency || entityCurrency || null;
  const matchedName = prefill?.contactName ?? null;
  const vendor = doc.ocrResult?.vendor ?? null;

  const moveOn = (summary: BookedSummary | null) => {
    const next = nextDocumentId(nextDocs.data ?? [], doc.id);
    setLastBooked(summary);
    if (next) {
      router.push(reviewPath(next));
      return;
    }
    if (summary) setFinished(summary);
    else router.push(INBOX_PATH);
  };

  const submit = () => {
    if (alreadyBooked || book.isPending || choice === 'not_for_books' || !canBook) return;
    if (problem) {
      setShowProblem(true);
      return;
    }
    setShowProblem(false);
    setLastBooked(null);
    book.mutate(
      { id: doc.id, input: buildBookInput(state) },
      { onSuccess: (result) => moveOn(summarizeBooking(state.kind, result)) },
    );
  };

  // Enter outside a field, button or list saves and opens the next document.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isEnterOwnedBy(event.target)) {
        // Enter in a field of the form belongs to the field: it must not submit (book) by accident.
        if (event.target instanceof HTMLInputElement && event.target.closest('[data-review-form]')) event.preventDefault();
        return;
      }
      event.preventDefault();
      submitRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const onFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  const onKindChange = (value: string) => {
    if (!REVIEW_KINDS.includes(value as ReviewKind)) return;
    const next = value as ReviewKind;
    setChoice(next);
    if (next === 'not_for_books') return;
    setState((current) => ({
      ...current,
      kind: next,
      paid: canPayWith(next) ? current.paid : { type: 'none' },
    }));
  };

  const onPaidChange = (paid: PaidChoice) => {
    paidTouched.current = true;
    setState((current) => ({ ...current, paid }));
  };

  const doReject = async () => {
    try {
      await reject.mutateAsync(doc.id);
      toast.success(tr.rejected);
      setRejectOpen(false);
      moveOn(null);
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : tr.failed);
    }
  };

  const problemText = problem ? tr.problems[problem] : null;
  const errorText = book.isError ? (book.error instanceof Error && book.error.message ? book.error.message : tr.failed) : null;

  let body;
  if (finished) {
    body = (
      <div className="space-y-4" data-testid="review-finished">
        <BookedBanner summary={finished} />
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
          {tr.done.noneLeft}
        </p>
        <Button asChild>
          <Link href={INBOX_PATH}>{tr.done.toInbox}</Link>
        </Button>
      </div>
    );
  } else if (alreadyBooked) {
    body = (
      <div className="space-y-3" data-testid="review-already-booked">
        <InfoBanner variant="info">{tr.alreadyBooked}</InfoBanner>
        {doc.linkedEntityType === 'bill' && doc.linkedEntityId ? (
          <RecordLink type="bill" id={doc.linkedEntityId} label={tr.openBill} />
        ) : null}
      </div>
    );
  } else {
    body = (
      <form onSubmit={onFormSubmit} data-review-form className="space-y-5" aria-label={tr.form} noValidate>
        {prefillFailed ? <InfoBanner variant="warning">{tr.prefillFailed}</InfoBanner> : null}

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">{tr.kind.legend}</legend>
          <ToggleGroup
            type="single"
            variant="outline"
            value={choice}
            onValueChange={onKindChange}
            aria-label={tr.kind.legend}
            className="w-full flex-wrap"
          >
            {REVIEW_KINDS.map((kind) => (
              <ToggleGroupItem key={kind} value={kind} className="px-3 text-sm" aria-label={tr.kind[kind]}>
                {tr.kind[kind]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {choice === 'credit_note' ? <p className="text-xs text-muted-foreground">{tr.kind.creditNoteHint}</p> : null}
        </fieldset>

        {choice === 'not_for_books' ? (
          <div className="space-y-3" data-testid="review-not-for-books">
            <p className="text-sm text-muted-foreground">{tr.kind.notForBooksHint}</p>
            <Button type="button" variant="destructive" onClick={() => setRejectOpen(true)} disabled={!canReject || reject.isPending}>
              <Ban className="h-4 w-4" aria-hidden />
              {tr.reject}
            </Button>
          </div>
        ) : (
          <>
            <DuplicateWarning duplicates={duplicates.data} />

            <SupplierSection
              contactId={state.contactId}
              onChange={(contactId) => setState((current) => ({ ...current, contactId }))}
              matchedContactId={prefill?.contactId ?? doc.matchedContactId ?? null}
              matchedName={matchedName}
              vendor={vendor}
              invalid={showProblem && problem === 'noSupplier'}
            />

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="review-number">{tr.details.invoiceNumber}</Label>
                <Input
                  id="review-number"
                  value={state.invoiceNumber}
                  onChange={(event) => setState((current) => ({ ...current, invoiceNumber: event.target.value }))}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="review-currency">{tr.details.currency}</Label>
                <Input
                  id="review-currency"
                  value={currency ?? ''}
                  maxLength={3}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setState((current) => ({ ...current, currency: event.target.value.toUpperCase() }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="review-date">{tr.details.date}</Label>
                <Input
                  id="review-date"
                  type="date"
                  value={state.date}
                  onChange={(event) => setState((current) => ({ ...current, date: event.target.value }))}
                  aria-invalid={showProblem && problem === 'noDate' ? true : undefined}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="review-due">{tr.details.dueDate}</Label>
                <Input
                  id="review-due"
                  type="date"
                  value={state.dueDate}
                  onChange={(event) => setState((current) => ({ ...current, dueDate: event.target.value }))}
                />
              </div>
            </div>

            <LinesEditor
              lines={state.lines}
              onChange={(lines) => setState((current) => ({ ...current, lines }))}
              accounts={accounts}
              taxRates={taxRates}
              documentTotal={prefill?.total ?? null}
              currency={currency}
            />

            <PaidWithList
              kind={state.kind}
              candidates={candidates.data ?? []}
              loading={candidates.isFetching && !candidates.data}
              value={state.paid}
              onChange={onPaidChange}
              currency={currency}
              allowBankLine={canReadBank && can('banking:update')}
              allowCashPrivate={can('banking:create')}
            />

            {showProblem && problemText ? (
              <p className="text-sm text-destructive" role="alert" data-testid="review-problem">
                {problemText}
              </p>
            ) : null}
            {errorText ? (
              <p className="text-sm text-destructive" role="alert" data-testid="review-error">
                {errorText}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-3 border-t pt-4">
              <Button type="submit" disabled={book.isPending || !canBook} data-testid="review-save">
                {book.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
                {book.isPending ? tr.saving : tr.save}
                <Kbd className="ml-2">⏎</Kbd>
              </Button>
              <Button type="button" variant="ghost" onClick={() => setRejectOpen(true)} disabled={!canReject || reject.isPending}>
                {tr.reject}
              </Button>
              <p className="ml-auto text-xs text-muted-foreground">{tr.shortcuts}</p>
            </div>
          </>
        )}
      </form>
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="min-w-0">
        <BackLink />
        <h1 className="truncate text-xl font-semibold" data-testid="review-title">
          {tr.title}: {doc.fileName}
        </h1>
      </div>

      {lastBooked && !finished ? <BookedBanner summary={lastBooked} onDismiss={() => setLastBooked(null)} /> : null}

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="lg:sticky lg:top-4">
          <SourceDocumentViewer fileKey={doc.fileKey} mimeType={doc.mimeType} fileName={doc.fileName} />
        </div>
        <div className="min-w-0">{body}</div>
      </div>

      <ConfirmDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        title={tr.rejectTitle}
        description={tr.rejectDescription.replace('{name}', doc.fileName)}
        confirmLabel={tr.rejectConfirm}
        variant="destructive"
        loading={reject.isPending}
        onConfirm={doReject}
      />
    </div>
  );
}
