import Foundation

// The app's own models. `BooksStore` maps the generated API types to these,
// and nothing else does. Properties are `var` so a screen can change a copy
// (Kotlin's `copy(...)`).

struct Address: Hashable, Sendable {
    var line1: String?
    var line2: String?
    var city: String?
    var state: String?
    var postalCode: String?
    var country: String?
    var county: String?

    var isEmpty: Bool { [line1, line2, city, state, postalCode, country, county].allSatisfy { $0.isNullOrBlank } }
}

/// A company (legal entity) with WeldBooks on.
struct Entity: Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var legalName: String?
    var jurisdictionCode: String
    var baseCurrency: String
    var locale: String?
    var address: Address?
    var entityType: String?
    var taxClassification: String?
    var dba: String?
    /// US: the EIN, when what is stored looks like one (a masked SSN never does).
    var ein: String?
    var vatNumber: String?
    var registrationNumber: String?
    var iban: String?
    var bic: String?
    var fiscalYearStart: Int?
    var isDefault: Bool = false
    var isActive: Bool = true
}

/// One row of a document's tax: per rate (VAT, GST), per component and treatment (BR), or per jurisdiction and line (US).
struct TaxRow: Hashable, Sendable {
    var name: String?
    var rate: Decimal = 0
    var taxableAmount: Decimal = 0
    var taxAmount: Decimal = 0
    var jurisdictionCode: String?
    var jurisdictionName: String?
    var level: String?
    var stateCode: String?
    var exemptAmount: Decimal = 0
    var nonTaxableAmount: Decimal = 0
    var exemptReason: String?
    var kind: String?
    var component: String?
    var treatment: String?
}

struct DocumentLine: Identifiable, Hashable, Sendable {
    var id: String
    var description: String
    var quantity: Decimal
    var unitPrice: Decimal
    var taxRate: Decimal
    var lineTotal: Decimal
    var taxCode: String?
    var accrueUseTax: Bool = false
}

/// An invoice or a credit note.
struct Invoice: Identifiable, Hashable, Sendable {
    var id: String
    var number: String?
    var type: String
    var status: String
    var contactId: String
    var contactName: String?
    var contactEmail: String?
    var issueDate: String
    var dueDate: String
    var currency: String?
    var subtotal: Decimal = 0
    var taxTotal: Decimal = 0
    var total: Decimal = 0
    var amountPaid: Decimal = 0
    var balanceDue: Decimal = 0
    var notes: String?
    var reference: String?
    var billingAddress: Address?
    var shippingAddress: Address?
    var taxBreakdown: [TaxRow] = []
    var taxWarnings: [String] = []
    var lines: [DocumentLine] = []

    var isCreditNote: Bool { type == "credit_note" }

    /// The status as the app shows it: `partial` reads as partly paid, and an open invoice past its due date as overdue.
    func displayStatus(today: Day = Days.today()) -> String {
        Statuses.invoice(status, dueDate: dueDate, balanceDue: balanceDue, today: today)
    }
}

struct Bill: Identifiable, Hashable, Sendable {
    var id: String
    var number: String?
    var status: String
    var approvalStatus: String?
    var contactId: String
    var contactName: String?
    var issueDate: String
    var dueDate: String
    var currency: String?
    var subtotal: Decimal = 0
    var taxTotal: Decimal = 0
    var total: Decimal = 0
    var amountPaid: Decimal = 0
    var balanceDue: Decimal = 0
    var notes: String?
    var reference: String?
    var sourceDocumentId: String?
    var deliveryAddress: Address?
    var taxBreakdown: [TaxRow] = []
    var lines: [DocumentLine] = []

    func displayStatus(today: Day = Days.today()) -> String {
        Statuses.bill(status, approvalStatus: approvalStatus, dueDate: dueDate, balanceDue: balanceDue, today: today)
    }
}

/// What OCR read from a receipt, as a bill form prefill.
struct BillPrefill: Hashable, Sendable {
    var contactName: String?
    var externalReference: String?
    var issueDate: String?
    var dueDate: String?
    var currency: String?
    var items: [PrefillLine]
    var subtotal: Decimal?
    var taxTotal: Decimal?
    var total: Decimal?
    var sourceDocumentId: String
    var matchedContactId: String?
}

struct PrefillLine: Hashable, Sendable {
    var description: String
    var quantity: String
    var unitPrice: String
    var taxRate: String?
    var sortOrder: Int
}

struct GlAccount: Identifiable, Hashable, Sendable {
    var id: String
    var code: String
    var name: String
    var type: String
    var isActive: Bool
}

struct BankAccount: Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var iban: String?
    var bankName: String?
    var accountType: String?
    var routingNumber: String?
    var accountNumberLast4: String?
    var currency: String?
    var balance: Decimal
    var lastImportDate: String?
}

struct BankTransaction: Identifiable, Hashable, Sendable {
    var id: String
    var bankAccountId: String
    var date: String
    var description: String?
    var amount: Decimal
    var status: String
    var counterpartyName: String?
    /// The bank's reference (payment reference, end-to-end id), as the platform's Reference column.
    var reference: String? = nil
}

struct MatchSuggestion: Identifiable, Hashable, Sendable {
    var id: String
    var type: String
    var number: String?
    var contactName: String?
    var amount: Decimal
    var confidence: Double
}

struct UnmatchedTransaction: Identifiable, Hashable, Sendable {
    var transaction: BankTransaction
    var suggestions: [MatchSuggestion]

    var id: String { transaction.id }
}

struct ReconciliationStats: Hashable, Sendable {
    var unmatched: Int
    var matched: Int
    var pendingAmount: Decimal
}

struct ContactPerson: Hashable, Sendable {
    var name: String
    var email: String?
    var phone: String?
}

struct Contact: Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    /// `company`, `person`, or nil for an older contact.
    var kind: String?
    /// `customer`, `supplier`, `both` or `none`.
    var role: String
    var email: String?
    var phone: String?
    var vatNumber: String?
    var contactPerson: ContactPerson?
    var billingAddress: Address?
    var shippingAddress: Address?
    var is1099Vendor: Bool
    var tinType: String?
    var tinLast4: String?

    var city: String? { billingAddress?.city }
}

struct ContactBalance: Hashable, Sendable {
    var receivable: Decimal
    var payable: Decimal
}

/// An invoice to be paid or a bill to pay, on the dashboard's "Due this week".
struct DueItem: Hashable, Sendable, Identifiable {
    var kind: String
    var id: String
    var number: String?
    var contactName: String?
    var dueDate: String
    var amount: Decimal
    var currency: String?

    /// An invoice and a bill never share a row.
    var rowId: String { "\(kind):\(id)" }
}

/// A payment on the dashboard: `received` on an invoice, `sent` on a bill.
struct RecentPayment: Hashable, Sendable, Identifiable {
    var id: String
    var type: String?
    var date: String
    var amount: Decimal
    var currency: String?
    var method: String?
    var reference: String?
    var invoiceId: String?
    var billId: String?
}

/// One month of the ledger: revenue, expenses and net profit; nil when nothing is known.
struct TrendMonth: Hashable, Sendable {
    var month: String
    var revenue: Decimal?
    var expenses: Decimal?
    var profit: Decimal?
}

struct Dashboard: Hashable, Sendable {
    var currency: String
    var outstanding: Decimal
    var outstandingCount: Int
    var overdue: Decimal
    var overdueCount: Int
    var payables: Decimal
    var payablesCount: Int
    var profitMonth: Decimal
    /// The ledger balance of the money accounts, or the bank accounts' sum on an older server.
    var cashBalance: Decimal = 0
    var bankAccountCount: Int = 0
    var pendingDocuments: Int = 0
    /// Invoices and bills due within the week, soonest first.
    var dueThisWeek: [DueItem] = []
    var recentPayments: [RecentPayment] = []
    /// The last 24 months, oldest first.
    var trend: [TrendMonth] = []
}

/// This year's running total of a metric against last year's, month by month (the platform's `yearToDateSeries`).
struct YearToDate: Hashable, Sendable {
    struct Point: Hashable, Sendable {
        /// This year's running total; nil after this month.
        var value: Decimal?
        var lastYear: Decimal?
    }

    var year: Int
    /// `YYYY-MM` of the last month with figures; nil without a trend.
    var throughMonth: String?
    /// Twelve points, January to December.
    var points: [Point]
    var total: Decimal
    var lastYearTotal: Decimal
}

enum DashboardSeries {
    /// Revenue, expenses or net profit of a month.
    static func value(_ month: TrendMonth, metric: String) -> Decimal? {
        switch metric {
        case "expenses": return month.expenses
        case "profit": return month.profit
        default: return month.revenue
        }
    }

    /// An older server returns only revenue: expenses and profit are then unknown.
    static func hasTrend(_ months: [TrendMonth]) -> Bool {
        !months.isEmpty && months.allSatisfy { $0.expenses != nil }
    }

    static func yearToDate(_ months: [TrendMonth], metric: String, today: Day = Days.today()) -> YearToDate {
        let current = months.last?.month
        let year = current.flatMap { Int($0.take(4)) } ?? today.year
        var byMonth: [String: Decimal] = [:]
        for month in months {
            if let amount = Self.value(month, metric: metric) { byMonth[month.month] = amount }
        }
        func key(_ y: Int, _ m: Int) -> String { String(format: "%04ld-%02ld", y, m) }
        var running: Decimal? = 0
        var lastYearRunning: Decimal? = 0
        var total: Decimal = 0
        var lastYearTotal: Decimal = 0
        var points: [YearToDate.Point] = []
        for m in 1...12 {
            let month = key(year, m)
            let inRange = current.map { month <= $0 } ?? false
            if inRange, let sum = running, let value = byMonth[month] {
                running = sum + value
            } else {
                running = nil
            }
            if let sum = lastYearRunning, let value = byMonth[key(year - 1, m)] {
                lastYearRunning = sum + value
            } else {
                lastYearRunning = nil
            }
            if month == current {
                total = running ?? 0
                lastYearTotal = lastYearRunning ?? 0
            }
            points.append(YearToDate.Point(value: inRange ? running : nil, lastYear: lastYearRunning))
        }
        return YearToDate(year: year, throughMonth: current, points: points, total: total, lastYearTotal: lastYearTotal)
    }

    /// Invoices and bills due by the end of the week (overdue ones too), soonest first, at most `limit`.
    static func dueThisWeek(_ items: [DueItem], today: Day = Days.today(), limit: Int = 10) -> [DueItem] {
        let end = today.adding(days: 7).iso
        return Array(
            items
                .filter { !$0.dueDate.take(10).isEmpty && $0.dueDate.take(10) <= end }
                .sorted { $0.dueDate.take(10) < $1.dueDate.take(10) }
                .prefix(limit)
        )
    }
}

struct ProfitLoss: Hashable, Sendable {
    var revenue: Decimal
    var expenses: Decimal
    var netProfit: Decimal

    /// Percent of revenue, 0 without revenue.
    var margin: Decimal {
        guard revenue > 0 else { return 0 }
        return Amounts.round(netProfit * 100 / revenue, scale: 1)
    }
}

struct BalanceRow: Hashable, Sendable {
    var code: String
    var name: String
    var balance: Decimal
}

struct BalanceSheet: Hashable, Sendable {
    var assets: [BalanceRow]
    var liabilities: [BalanceRow]
    var equity: [BalanceRow]
    var totalAssets: Decimal
    var totalLiabilities: Decimal
    var totalEquity: Decimal
    var totalLiabilitiesAndEquity: Decimal

    /// Sub-cent differences are rounding; anything more is a books problem worth showing.
    var isBalanced: Bool { (totalAssets - totalLiabilitiesAndEquity).magnitude < Decimal(1) / 100 }
}

struct VatReturn: Identifiable, Hashable, Sendable {
    var id: String
    var period: String
    var year: Int
    var status: String
    var salesTax: Decimal
    var purchaseTax: Decimal
    var netAmount: Decimal
    var periodStart: String?
    var periodEnd: String?
    var filedAt: String?
    /// Boxes worth showing on a phone, by key (`r1a`), as numbers.
    var boxes: [String: Decimal]

    /// Calculated or reviewed, not sent yet: it can be filed.
    var isFileable: Bool { ["draft", "calculated", "reviewed"].contains(status) }

    var isFiled: Bool { ["filed", "submitted", "accepted"].contains(status) }
}

/// A page of a list, as the list screens keep it.
struct Page<T> {
    var items: [T]
    var totalCount: Int
    var hasMore: Bool
}

extension Page: Sendable where T: Sendable {}
