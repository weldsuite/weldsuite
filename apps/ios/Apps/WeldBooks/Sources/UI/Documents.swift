import Observation
import SwiftUI
import WeldCore
import WeldUI

// The parts the invoice and bill detail screens share (Android `ui/Documents.kt`),
// laid out as the platform's invoice and bill panels: property rows, the line
// items, the totals.

/// "Overdue by 3 days", "Due today", "Due in 5 days" (and whether it is late); nil when nothing is open or there is no due date.
func dueNote(balanceDue: Decimal, dueDate: String, isInvoice: Bool) -> (text: String, late: Bool)? {
    guard balanceDue > 0, let days = Days.until(Days.of(dueDate)) else { return nil }
    if days < 0 {
        return (isInvoice ? BooksStrings.invoiceDetailOverdueBy(-days) : BooksStrings.billDetailOverdueBy(-days), true)
    }
    if days == 0 {
        return (isInvoice ? BooksStrings.invoiceDetailDueToday : BooksStrings.billDetailDueToday, false)
    }
    return (isInvoice ? BooksStrings.invoiceDetailDueIn(days) : BooksStrings.billDetailDueIn(days), false)
}

/// The figures at the top of an invoice's or bill's details, as the platform's
/// panel lists them: total, paid, balance due and the status chip.
struct DocumentFigures: View {
    let total: Decimal
    let amountPaid: Decimal
    let balanceDue: Decimal
    let currency: String
    let status: String
    let isInvoice: Bool

    @Environment(Books.self) private var books

    var body: some View {
        PropertyRow("banknote", isInvoice ? BooksStrings.invoiceDetailTotal : BooksStrings.billDetailTotal, books.money(total, currency: currency))
        PropertyRow("wallet.pass", isInvoice ? BooksStrings.invoiceDetailPaid : BooksStrings.billDetailPaid, books.money(amountPaid, currency: currency))
        PropertyRow(
            "scalemass",
            isInvoice ? BooksStrings.invoiceDetailBalanceDue : BooksStrings.billDetailBalanceDue,
            books.money(max(balanceDue, 0), currency: currency)
        )
        .tagged("balance-due")
        PropertyRow("smallcircle.filled.circle", BooksStrings.documentStatus) {
            StatusPill(status)
        }
    }
}

/// The due date, with how far off it is under it (red once it has passed).
struct DueDateRow: View {
    let label: String
    let dueDate: String
    let balanceDue: Decimal
    let isInvoice: Bool

    @Environment(Books.self) private var books

    var body: some View {
        PropertyRow("calendar.badge.clock", label) {
            VStack(alignment: .leading, spacing: 2) {
                Text(books.date(dueDate)).font(.inter(.subheadline)).monospacedDigit()
                if let note = dueNote(balanceDue: balanceDue, dueDate: dueDate, isInvoice: isInvoice) {
                    Text(note.text)
                        .font(.inter(.caption))
                        .foregroundStyle(note.late ? Tokens.Status.danger : Tokens.Palette.mutedForeground)
                }
            }
        }
    }
}

/// A document's lines, as the platform's line items: the description, "2 × €10.00 · 21% VAT" under it, the line total.
struct DocumentLines: View {
    let lines: [DocumentLine]
    let currency: String
    let title: String
    let isInvoice: Bool

    @Environment(Books.self) private var books

    var body: some View {
        if !lines.isEmpty {
            PanelSection(title: title) {
                ForEach(lines.indices, id: \.self) { index in
                    let line = lines[index]
                    Hairline()
                    HStack(alignment: .firstTextBaseline, spacing: Tokens.Spacing.m) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(line.description).font(.inter(.subheadline))
                            Text(detail(line))
                                .font(.inter(.caption))
                                .monospacedDigit()
                                .foregroundStyle(Tokens.Palette.mutedForeground)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Text(books.money(line.lineTotal, currency: currency))
                            .font(.inter(.subheadline, weight: .medium))
                            .monospacedDigit()
                    }
                    .padding(.vertical, Tokens.Spacing.m)
                    .accessibilityElement(children: .combine)
                }
                Hairline()
            }
        }
    }

    private func detail(_ line: DocumentLine) -> String {
        var parts = ["\(Amounts.plain(line.quantity)) × \(books.money(line.unitPrice, currency: currency))"]
        if books.isUs && isInvoice {
            if let code = line.taxCode { parts.append(taxCodeLabel(code)) }
        } else {
            if line.taxRate > 0 { parts.append(books.labels.taxRate(Amounts.percent(line.taxRate))) }
            if books.isUs && line.accrueUseTax { parts.append(BooksStrings.salesTaxUseTaxAccrued) }
        }
        return parts.joined(separator: " · ")
    }
}

/// Subtotal, tax and the total, then what has been paid (green) and what is
/// still due, as the platform's totals. A Brazilian document's tax row becomes
/// the taxes added on top and the withholdings taken off.
struct DocumentTotals: View {
    let subtotal: Decimal
    let taxTotal: Decimal
    let total: Decimal
    let amountPaid: Decimal
    let balanceDue: Decimal
    let currency: String
    let taxLabel: String
    let taxBreakdown: [TaxRow]
    let isInvoice: Bool
    var extraRows: [(String, String)] = []

    @Environment(Books.self) private var books

    var body: some View {
        let labels = isInvoice
            ? (BooksStrings.invoiceDetailSubtotal, BooksStrings.invoiceDetailTotal, BooksStrings.invoiceDetailPaid, BooksStrings.invoiceDetailBalanceDue)
            : (BooksStrings.billDetailSubtotal, BooksStrings.billDetailTotal, BooksStrings.billDetailPaid, BooksStrings.billDetailBalanceDue)
        var rows: [(String, String)] = [(labels.0, books.money(subtotal, currency: currency))]
        rows += taxRows
        rows += extraRows
        var after: [(String, String, Color?)] = []
        if amountPaid > 0 { after.append((labels.2, "−" + books.money(amountPaid, currency: currency), Tones.paid)) }
        if balanceDue > 0 { after.append((labels.3, books.money(balanceDue, currency: currency), nil)) }
        return TotalsBlock(rows: rows, total: (labels.1, books.money(total, currency: currency)), after: after)
            .padding(.horizontal, Tokens.Spacing.l)
            .padding(.vertical, Tokens.Spacing.m)
            .tagged("document-totals")
    }

    private var taxRows: [(String, String)] {
        guard TaxBreakdown.hasTreatments(taxBreakdown) else { return [(taxLabel, books.money(taxTotal, currency: currency))] }
        let (added, withheld) = TaxBreakdown.treatmentTotals(taxBreakdown)
        var rows: [(String, String)] = []
        if added > 0 { rows.append((BooksStrings.taxTreatmentAddedRow, books.money(added, currency: currency))) }
        if withheld > 0 { rows.append((BooksStrings.taxTreatmentWithheldRow, "−" + books.money(withheld, currency: currency))) }
        return rows
    }
}

// Runs a document action, then reloads; a refusal stays on screen until the
/// next attempt (Android `Mutations`). Keep it in `@State private var mutations = Mutations()`.
@MainActor
@Observable
final class Mutations {
    private(set) var busy = false
    private(set) var error: String?
    /// The company fields the server says are missing, when that is why an action was refused.
    private(set) var missingFields: [String] = []

    init() {}

    /// Run `action`; on success show `success` and `reload`, else show (and keep) why it failed.
    func run(_ toaster: Toaster, success: String, reload: @escaping () async -> Void, action: @escaping () async throws -> Void) {
        busy = true
        error = nil
        missingFields = []
        Task {
            do {
                try await action()
                toaster.show(success)
                await reload()
            } catch {
                let message = ErrorTexts.describe(error, fallback: BooksStrings.commonActionFailed)
                self.error = message
                self.missingFields = (error as? CompanyFieldsMissing)?.fields ?? []
                toaster.show(message)
            }
            self.busy = false
        }
    }

    /// Delete, then leave the screen.
    func remove(_ toaster: Toaster, success: String, failMessage: String, leave: @escaping () -> Void, action: @escaping () async throws -> Void) {
        busy = true
        Task {
            do {
                try await action()
                toaster.show(success)
                leave()
            } catch {
                toaster.show(ErrorTexts.describe(error, fallback: failMessage))
            }
            self.busy = false
        }
    }

    func clear() {
        error = nil
        missingFields = []
    }
}

/// The invoice fields a company lacks, in words: "BTW-nummer, KvK-nummer and IBAN".
func invoiceFieldNames(_ fields: [String], labels: Labels) -> String {
    CompanyForm.listFields(fields, name: { field in
        switch field {
        case "vatNumber": return labels.taxId
        case "registrationNumber": return labels.registrationId
        case "iban": return BooksStrings.companyFieldNamesIban
        case "bic": return BooksStrings.companyFieldNamesBic
        default: return BooksStrings.companyFieldNamesAddress
        }
    }, and: BooksStrings.companyListAnd)
}
