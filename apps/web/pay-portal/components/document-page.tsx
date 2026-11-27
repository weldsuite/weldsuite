import { useState } from 'react'
import { buttonVariants } from '@weldsuite/ui/components/button'
import { cn } from '@weldsuite/ui/lib/utils'
import type { AcceptResult, DocumentLine, Locale, PublicDocument } from '@/lib/contract'
import type { PortalActions } from '@/lib/actions'
import { bannerFor, canAccept, canPay, showTransferDetails } from '@/lib/document-state'
import { addressLines, formatDate, formatDateTime, formatMoney, formatNumber, isPositive, safeImageUrl } from '@/lib/format'
import { dictionaries, type Dictionary } from '@/lib/i18n'
import { AcceptQuoteForm } from './accept-quote-form'
import { PayButton } from './pay-button'
import { bannerText, StatusBanner } from './status-banner'

interface DocumentPageProps {
  document: PublicDocument
  /** The language of the page: the document's own, else the browser's. */
  locale: Locale
  /** Where the PDF is served (this portal streams it from the backend). */
  pdfHref: string
  actions: PortalActions
}

/** The document the customer was sent: sender, parties, lines, totals, and what they can do with it. */
export function DocumentPage({ document, locale, pdfHref, actions }: DocumentPageProps) {
  const t = dictionaries[locale]
  const [accepted, setAccepted] = useState<AcceptResult | null>(
    document.quote?.acceptedAt && document.quote.acceptedBy ? { acceptedAt: document.quote.acceptedAt, acceptedBy: document.quote.acceptedBy } : null,
  )
  const money = (amount: string) => formatMoney(amount, document.currency, locale)
  const banner = accepted ? 'accepted' : bannerFor(document)
  const bannerCopy = banner ? bannerText(t, banner, document, locale) : null
  const isQuote = document.kind === 'quote'
  const dateLabel = isQuote ? t.validUntil : t.dueDate
  const dateValue = isQuote ? document.validUntil : document.dueDate
  const vatMixed = new Set(document.lines.map((line) => line.taxRate)).size > 1
  const showPay = canPay(document)
  const showAccept = !accepted && canAccept(document)

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10 print:max-w-none print:p-0">
      <article className="document grid gap-6 rounded-xl border bg-card p-4 text-card-foreground shadow-xs sm:gap-8 sm:p-8" aria-labelledby="document-title">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-1">
            <p className="text-sm text-muted-foreground">{t.kind[document.kind]}</p>
            <h1 id="document-title" className="text-2xl font-semibold tracking-tight">
              {document.number}
            </h1>
          </div>
          {safeImageUrl(document.seller.logoUrl) ? (
            <img
              src={safeImageUrl(document.seller.logoUrl) ?? undefined}
              alt={document.seller.name}
              className="max-h-16 max-w-48 object-contain"
              referrerPolicy="no-referrer"
              decoding="async"
            />
          ) : (
            <p className="text-lg font-semibold">{document.seller.name}</p>
          )}
        </header>

        {bannerCopy && banner ? <StatusBanner kind={banner} title={bannerCopy.title} body={bannerCopy.body} /> : null}

        <div className="flex flex-wrap items-start gap-3 print:hidden">
          <a
            href={pdfHref}
            download
            className={cn(buttonVariants({ variant: showPay ? 'outline' : 'default', size: 'lg' }), 'w-full sm:w-auto')}
          >
            {t.actions.downloadPdf}
          </a>
          {showPay ? (
            <div className="grid w-full gap-2 sm:w-auto">
              <PayButton t={t} label={t.actions.payNow(money(document.totals.balanceDue))} pay={actions.pay} navigate={actions.navigate} />
              {document.payment.methods.length > 0 ? <p className="text-xs text-muted-foreground">{t.pay.methods}</p> : null}
            </div>
          ) : null}
        </div>

        <section className="grid gap-6 sm:grid-cols-2" aria-label={t.kind[document.kind]}>
          <Party heading={t.from} name={document.seller.name} lines={addressLines(document.seller.address)}>
            {document.seller.email ? <Row label={t.details.email} value={document.seller.email} /> : null}
            {document.seller.phone ? <Row label={t.details.phone} value={document.seller.phone} /> : null}
            {document.seller.vatNumber ? <Row label={t.details.vatNumber} value={document.seller.vatNumber} /> : null}
            {document.seller.registrationNumber ? <Row label={t.details.registrationNumber} value={document.seller.registrationNumber} /> : null}
          </Party>
          <Party heading={isQuote ? t.quoteFor : t.billTo} name={document.buyer.name} lines={addressLines(document.buyer.address)}>
            <Row label={t.issueDate} value={formatDate(document.issueDate, locale)} />
            {dateValue ? <Row label={dateLabel} value={formatDate(dateValue, locale)} /> : null}
          </Party>
        </section>

        <table className="lines w-full text-sm">
          <caption className="sr-only">{t.lines.caption}</caption>
          <thead>
            <tr>
              <th scope="col" className="text-left">
                {t.lines.description}
              </th>
              <th scope="col" className="text-right">
                {t.lines.quantity}
              </th>
              <th scope="col" className="text-right">
                {t.lines.unitPrice}
              </th>
              {vatMixed ? (
                <th scope="col" className="text-right">
                  {t.lines.vat}
                </th>
              ) : null}
              <th scope="col" className="text-right">
                {t.lines.total}
              </th>
            </tr>
          </thead>
          <tbody>
            {document.lines.map((line, index) => (
              <LineRow key={index} line={line} t={t} locale={locale} money={money} showVat={vatMixed} />
            ))}
          </tbody>
        </table>

        <dl className="totals ml-auto grid w-full max-w-sm gap-1.5 text-sm">
          <TotalRow label={t.totals.subtotal} value={money(document.totals.subtotal)} />
          {document.totals.taxes.map((tax) => (
            <TotalRow key={tax.rate} label={t.totals.vatAt(formatNumber(tax.rate, locale))} value={money(tax.amount)} />
          ))}
          <TotalRow label={t.totals.total} value={money(document.totals.total)} strong />
          {!isQuote && isPositive(document.totals.paid) ? <TotalRow label={t.totals.paid} value={money(document.totals.paid)} /> : null}
          {!isQuote ? <TotalRow label={t.totals.balanceDue} value={money(document.totals.balanceDue)} strong /> : null}
        </dl>

        {showAccept ? <AcceptQuoteForm t={t} accept={actions.accept} onAccepted={setAccepted} /> : null}
        {accepted ? (
          <section aria-labelledby="accepted-title" className="grid gap-1 rounded-lg border border-emerald-600/40 bg-emerald-50 p-4 text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100">
            <h2 id="accepted-title" className="font-semibold">
              {t.accept.doneTitle}
            </h2>
            <p>{t.accept.doneBody(accepted.acceptedBy, formatDateTime(accepted.acceptedAt, locale))}</p>
            <p className="text-sm">{t.accept.thanks}</p>
          </section>
        ) : null}

        {document.notes ? <TextBlock heading={t.notes} text={document.notes} /> : null}
        {document.paymentTerms ? <TextBlock heading={t.paymentTerms} text={document.paymentTerms} /> : null}

        {showTransferDetails(document) ? (
          <section className="grid gap-1 text-sm" aria-labelledby="transfer-title">
            <h2 id="transfer-title" className="font-semibold">
              {t.details.title}
            </h2>
            <dl className="grid gap-1">
              <Row label={t.details.iban} value={document.seller.iban ?? ''} />
              {document.seller.bic ? <Row label={t.details.bic} value={document.seller.bic} /> : null}
              <Row label={t.details.reference} value={document.number} />
            </dl>
          </section>
        ) : null}
      </article>
    </main>
  )
}

function Party({ heading, name, lines, children }: { heading: string; name: string; lines: string[]; children?: React.ReactNode }) {
  return (
    <div className="grid content-start gap-1 text-sm">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{heading}</h2>
      <p className="font-semibold">{name}</p>
      {lines.map((line, index) => (
        <p key={index}>{line}</p>
      ))}
      <dl className="mt-1 grid gap-0.5">{children}</dl>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  )
}

function TotalRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-4', strong && 'border-t pt-1.5 text-base font-semibold')}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}

function TextBlock({ heading, text }: { heading: string; text: string }) {
  return (
    <section className="grid gap-1 text-sm">
      <h2 className="font-semibold">{heading}</h2>
      <p className="whitespace-pre-line text-muted-foreground">{text}</p>
    </section>
  )
}

function LineRow({
  line,
  t,
  locale,
  money,
  showVat,
}: {
  line: DocumentLine
  t: Dictionary
  locale: Locale
  money: (amount: string) => string
  showVat: boolean
}) {
  return (
    <tr>
      <th scope="row" className="text-left font-normal" data-label={t.lines.description}>
        {line.description}
      </th>
      <td className="text-right tabular-nums" data-label={t.lines.quantity}>
        {formatNumber(line.quantity, locale)}
      </td>
      <td className="text-right tabular-nums" data-label={t.lines.unitPrice}>
        {money(line.unitPrice)}
      </td>
      {showVat ? (
        <td className="text-right tabular-nums" data-label={t.lines.vat}>
          {formatNumber(line.taxRate, locale)}%
        </td>
      ) : null}
      <td className="text-right tabular-nums" data-label={t.lines.total}>
        {money(line.total)}
      </td>
    </tr>
  )
}
