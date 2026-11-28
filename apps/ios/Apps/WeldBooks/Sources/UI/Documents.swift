import Observation
import SwiftUI
import WeldCore
import WeldUI

// The parts the invoice and bill detail screens share (Android `ui/Documents.kt`).

/// The open balance (or the total), the status and how far off the due date is.
struct DocumentSummary: View {
    let balanceDue: Decimal
    let total: Decimal
    let currency: String
    let dueDate: String
    let status: String
    let balanceLabel: String
    let totalLabel: String
    let isInvoice: Bool

    @Environment(Books.self) private var books

    var body: some View {
        let hasBalance = balanceDue > 0
        let due = Days.until(Days.of(dueDate))
        SectionCard {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(hasBalance ? balanceLabel : totalLabel).font(.footnote).foregroundStyle(Color.secondary)
                    Text(books.money(hasBalance ? balanceDue : total, currency: currency)).font(.title2.bold())
                }
                Spacer()
                StatusPill(status)
            }
            if hasBalance, let days = due {
                Text(dueText(days))
                    .font(.footnote)
                    .foregroundStyle(days < 0 ? Tokens.Status.danger : Color.secondary)
                    .padding(.top, Tokens.Spacing.s)
            }
        }
    }

    private func dueText(_ days: Int) -> String {
        if days < 0 {
            return isInvoice ? BooksStrings.invoiceDetailOverdueBy(-days) : BooksStrings.billDetailOverdueBy(-days)
        }
        if days == 0 {
            return isInvoice ? BooksStrings.invoiceDetailDueToday : BooksStrings.billDetailDueToday
        }
        return isInvoice ? BooksStrings.invoiceDetailDueIn(days) : BooksStrings.billDetailDueIn(days)
    }
}

/// A document's lines: "2 × €10.00 · 21% VAT", the line total.
struct DocumentLines: View {
    let lines: [DocumentLine]
    let currency: String
    let title: String
    let isInvoice: Bool

    @Environment(Books.self) private var books

    var body: some View {
        if !lines.isEmpty {
            SectionCard(title: title) {
                ForEach(lines.indices, id: \.self) { index in
                    let line = lines[index]
                    if index > 0 { Divider().padding(.vertical, Tokens.Spacing.s) }
                    Text(line.description).font(.subheadline)
                    HStack(alignment: .firstTextBaseline, spacing: Tokens.Spacing.m) {
                        Text(detail(line))
                            .font(.footnote)
                            .foregroundStyle(Color.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text(books.money(line.lineTotal, currency: currency)).font(.subheadline.weight(.semibold))
                    }
                    .padding(.top, 4)
                }
            }
        }
    }

    private func detail(_ line: DocumentLine) -> String {
        var parts: [String] = []
        if books.isUs && isInvoice {
            if let code = line.taxCode { parts.append(taxCodeLabel(code)) }
        } else {
            if line.taxRate > 0 { parts.append(books.labels.taxRate(Amounts.percent(line.taxRate))) }
            if books.isUs && line.accrueUseTax { parts.append(BooksStrings.salesTaxUseTaxAccrued) }
        }
        let suffix = parts.isEmpty ? "" : "  ·  " + parts.joined(separator: "  ·  ")
        return "\(Amounts.plain(line.quantity)) × \(books.money(line.unitPrice, currency: currency))\(suffix)"
    }
}

/// Subtotal, tax, payments and what is open. A Brazilian document's tax row
/// becomes the taxes added on top and the withholdings taken off.
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
        let hasPayments = amountPaid > 0
        let labels = isInvoice
            ? (BooksStrings.invoiceDetailTotals, BooksStrings.invoiceDetailSubtotal, BooksStrings.invoiceDetailTotal, BooksStrings.invoiceDetailPaid, BooksStrings.invoiceDetailBalanceDue)
            : (BooksStrings.billDetailTotals, BooksStrings.billDetailSubtotal, BooksStrings.billDetailTotal, BooksStrings.billDetailPaid, BooksStrings.billDetailBalanceDue)
        var rows: [(String, String)] = [(labels.1, books.money(subtotal, currency: currency))]
        rows += taxRows
        rows += extraRows
        if hasPayments {
            rows.append((labels.2, books.money(total, currency: currency)))
            rows.append((labels.3, "−" + books.money(amountPaid, currency: currency)))
        }
        let totalRow = hasPayments
            ? (labels.4, books.money(max(balanceDue, 0), currency: currency))
            : (labels.2, books.money(total, currency: currency))
        return SectionCard(title: labels.0) {
            TotalsBlock(rows: rows, total: totalRow)
        }
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

/// Runs a document action, then reloads; a refusal stays on screen until the
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
