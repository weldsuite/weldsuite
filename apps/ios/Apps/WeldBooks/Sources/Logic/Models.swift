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

struct Dashboard: Hashable, Sendable {
    var currency: String
    var outstanding: Decimal
    var outstandingCount: Int
    var overdue: Decimal
    var overdueCount: Int
    var payables: Decimal
    var payablesCount: Int
    var profitMonth: Decimal
    var recentInvoices: [Invoice]
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
