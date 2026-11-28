import Foundation
import HTTPTypes
import Observation
import WeldBooksAPI
import WeldCore

/// A refused call, with the server's message when it sent one (Android's
/// `ApiException`). `ErrorTexts.describe` turns it into words.
struct BooksError: Error, Equatable {
    let api: APIError
    let message: String?

    /// Any failure as a `BooksError`: a network failure, a refusal, or anything else.
    static func from(_ error: Error) -> BooksError {
        if let books = error as? BooksError { return books }
        if let missing = error as? CompanyFieldsMissing { return BooksError(api: APIError(status: 422, code: missing.code), message: missing.message) }
        if let notBooked = error as? QuickExpenseNotBooked { return from(notBooked.cause) }
        return BooksError(api: APIError.from(error), message: nil)
    }

    static let unreachable = BooksError(api: APIError(status: nil, code: nil), message: nil)
}

/// The `APIError` of any failure, for `LoadErrorView` and `Toaster.show(_:)`.
func apiError(_ error: Error?) -> APIError? {
    guard let error else { return nil }
    return BooksError.from(error).api
}

/// A refused finalise: the company lacks the invoice fields the server names (`ENTITY_INVOICE_FIELDS_MISSING`).
struct CompanyFieldsMissing: Error, Equatable {
    let fields: [String]
    let message: String?
    var code: String? = nil
}

/// The bill was saved but not approved or paid; it stays a draft. Saving again would create it twice.
struct QuickExpenseNotBooked: Error {
    let billId: String
    let cause: Error
}

/// The sales tax of a draft, as the server would book it.
struct TaxPreview: Hashable, Sendable {
    var warnings: [String]
    var addressIncomplete: Bool
    var subtotal: Decimal
    var taxTotal: Decimal
    var total: Decimal
    var taxBreakdown: [TaxRow]
}

struct NewInvoice: Hashable, Sendable {
    var contactName: String
    var contactEmail: String?
    var issueDate: String
    var dueDate: String
    var notes: String?
    var reference: String?
    var shippingAddress: Address?
    var billingAddress: Address?
    var lines: [LineInputValues]
}

struct NewBill: Hashable, Sendable {
    var contactId: String?
    var contactName: String
    var billNumber: String?
    var currency: String?
    var issueDate: String
    var dueDate: String
    var notes: String?
    var reference: String?
    var sourceDocumentId: String?
    var deliveryAddress: Address?
    var lines: [LineInputValues]
}

struct NewEntity: Hashable, Sendable {
    var name: String
    var jurisdictionCode: String
    var baseCurrency: String
    var isDefault: Bool
    var entityType: String?
    var taxClassification: String?
    var dba: String?
    var vatNumber: String?
    var ein: String?
    var registrationNumber: String?
    var iban: String?
    var bic: String?
    var address: Address?
}

struct NewContact: Hashable, Sendable {
    var identity: ContactIdentityDraft.Payload
    var email: String?
    var phone: String?
    var role: String
    var billingAddress: Address?
}

/// A payment as the record-payment sheet takes it.
struct PaymentValues: Hashable, Sendable {
    var amount: Decimal
    /// `yyyy-MM-dd`.
    var date: String
    var method: String
    var checkNumber: String?
    /// US: `undeposited_funds` or `bank`, for a received check or cash.
    var depositTo: String?
}

/// A quick expense: a bill that is approved and paid straight away.
struct QuickExpenseValues: Hashable, Sendable {
    var amount: Decimal
    /// False only for an entry queued by an older version, typed without tax.
    var amountIncludesTax: Bool = true
    /// The category's label: the line's description when none is typed.
    var category: String
    var description: String?
    var vendorName: String?
    var contactId: String?
    var currency: String?
    var date: String
    var documentId: String?
    var accountId: String?
    var taxRate: Decimal = 0
    var receiptLines: [PrefillLine]?
    var roundingDescription: String
    var paymentMethod: String
    var accrueUseTax: Bool = false
    var taxCode: String?
}

/// A file kept on this phone: bytes to upload, with their name and type.
struct LocalFile: Hashable, Sendable {
    var bytes: Data
    var fileName: String
    var mimeType: String
}

/// A stored receipt, read with the member's own token.
struct StoredFile: Hashable, Sendable {
    var bytes: Data
    var mimeType: String?
}

/// Names the open company on every request (`X-Accounting-Entity-Id`); without it the server uses the workspace default.
struct EntityHeaderMiddleware: ClientMiddleware {
    let entityId: String?

    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        if let entityId, let name = HTTPField.Name(BooksStore.entityHeader) { request.headerFields[name] = entityId }
        return try await next(request, body, baseURL)
    }
}

/// Every WeldBooks call, for the active workspace and company. Maps the
/// generated API types to the app's models here and nowhere else, so a
/// generator rename stays in this file (Android: `BooksRepository.kt`). Each
/// request names the company in `X-Accounting-Entity-Id`. Failures are thrown
/// as `BooksError`, or `CompanyFieldsMissing` for a refused finalise.
@MainActor
@Observable
final class BooksStore {
    nonisolated static let entityHeader = "X-Accounting-Entity-Id"

    /// The company the requests are for; nil until one is resolved (the server then uses the workspace default).
    @ObservationIgnored var entityId: String?

    @ObservationIgnored let env: AppEnvironment

    init(env: AppEnvironment) {
        self.env = env
    }

    private func client() throws -> Client {
        guard let api = env.api else { throw BooksError.unreachable }
        return Client(
            serverURL: api.serverURL,
            transport: api.transport,
            middlewares: api.middlewares + [EntityHeaderMiddleware(entityId: entityId)]
        )
    }

    /// Runs a call; anything thrown that isn't already ours becomes a `BooksError`.
    private func call<T>(_ body: () async throws -> T) async throws -> T {
        do {
            return try await body()
        } catch let error as BooksError {
            throw error
        } catch let error as CompanyFieldsMissing {
            throw error
        } catch {
            throw BooksError.from(error)
        }
    }

    /// The error of a refused call: `CompanyFieldsMissing` when the server names missing company fields.
    nonisolated static func failure(_ status: Int, _ body: Components.Schemas.ErrorBody?) -> Error {
        let missing = body?.details?.missingFields ?? []
        if !missing.isEmpty { return CompanyFieldsMissing(fields: missing, message: body?.message, code: body?.code) }
        return BooksError(api: APIError(status: status, code: body?.code), message: body?.message)
    }

    // MARK: - Entities

    func entities() async throws -> [Entity] {
        try await call {
            switch try await client().listAccountingEntities() {
            case let .ok(ok): return try ok.body.json.data.map(Self.entity)
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func jurisdictions() async throws -> [Jurisdiction] {
        try await call {
            switch try await client().listJurisdictions() {
            case let .ok(ok): return try ok.body.json.data.map(Self.jurisdiction)
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func createEntity(_ values: NewEntity) async throws -> Entity {
        let identifiers: Components.Schemas.EntityTaxIdentifiers? =
            values.vatNumber != nil || values.registrationNumber != nil || values.ein != nil
            ? Components.Schemas.EntityTaxIdentifiers(vatNumber: values.vatNumber, registrationNumber: values.registrationNumber, einOrSsn: values.ein)
            : nil
        let bank: Components.Schemas.EntityBankDetails? =
            values.iban != nil || values.bic != nil ? Components.Schemas.EntityBankDetails(iban: values.iban, bic: values.bic) : nil
        let input = Components.Schemas.EntityInput(
            name: values.name,
            jurisdictionCode: values.jurisdictionCode,
            baseCurrency: values.baseCurrency,
            entityType: values.entityType,
            taxClassification: values.taxClassification,
            dba: values.dba,
            taxIdentifiers: identifiers,
            bankDetails: bank,
            address: values.address.map(Self.postal),
            isDefault: values.isDefault,
            seedDefaults: true
        )
        return try await call {
            switch try await client().createAccountingEntity(body: .json(input)) {
            case let .created(created): return Self.entity(try created.body.json.data)
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    /// The server replaces the bank details as a whole, so the stored ones are read first and the change merged in.
    func updateEntity(id: String, update: EntityUpdateValues) async throws -> Entity {
        try await call {
            var bank: Components.Schemas.EntityBankDetails?
            if update.changesBank {
                var current: Components.Schemas.EntityBankDetails
                switch try await client().getAccountingEntity(path: .init(id: id)) {
                case let .ok(ok): current = try ok.body.json.data.bankDetails?.value1 ?? Components.Schemas.EntityBankDetails()
                case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
                }
                // Untouched keeps the stored value; an emptied field clears it.
                if let iban = update.iban { current.iban = iban.nilIfEmpty }
                if let bic = update.bic { current.bic = bic.nilIfEmpty }
                bank = current
            }
            let identifiers: Components.Schemas.EntityTaxIdentifiers? = update.changesTaxIdentifiers
                ? Components.Schemas.EntityTaxIdentifiers(vatNumber: update.vatNumber, registrationNumber: update.registrationNumber, einOrSsn: update.einOrSsn)
                : nil
            let body = Components.Schemas.EntityUpdate(
                name: update.name,
                taxIdentifiers: identifiers,
                bankDetails: bank,
                address: update.address.map(Self.postal)
            )
            switch try await client().updateAccountingEntity(path: .init(id: id), body: .json(body)) {
            case let .ok(ok): return Self.entity(try ok.body.json.data)
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    // MARK: - Dashboard and reports

    /// The dashboard's figures, plus the approved bills (first page) whose due
    /// date falls in the week: the platform's "Due this week" where the server
    /// has no to-process list.
    func dashboard() async throws -> Dashboard {
        try await call {
            async let figures = dashboardFigures()
            async let approved = try? bills(page: 1, pageSize: 50, search: nil, status: "approved")
            let data = try await figures
            let approvedBills = await approved?.items ?? []
            let accounts = data.bankAccounts
            // The ledger balance when the server has it; else the bank accounts in the base currency.
            let cash: Decimal
            if let balance = data.cashBalance {
                cash = Amounts.of(balance)
            } else {
                cash = accounts
                    .filter { $0.currency == nil || $0.currency == data.currency }
                    .reduce(Decimal(0)) { $0 + Amounts.of($1.currentBalance) }
            }
            let invoicesDue = (data.upcomingDue ?? []).map { row in
                DueItem(
                    kind: "invoice", id: row.id, number: row.invoiceNumber, contactName: row.contactName,
                    dueDate: row.dueDate, amount: Amounts.of(row.balanceDue), currency: data.currency
                )
            }
            let billsDue = approvedBills.filter { $0.balanceDue > 0 }.map { bill in
                DueItem(
                    kind: "bill", id: bill.id, number: bill.number, contactName: bill.contactName,
                    dueDate: bill.dueDate, amount: bill.balanceDue, currency: bill.currency
                )
            }
            return Dashboard(
                currency: data.currency,
                outstanding: Amounts.of(data.receivables.outstanding),
                outstandingCount: data.receivables.outstandingCount,
                overdue: Amounts.of(data.receivables.overdue),
                overdueCount: data.receivables.overdueCount,
                payables: Amounts.of(data.payables.outstanding),
                payablesCount: data.payables.outstandingCount,
                profitMonth: Amounts.of(data.profit.month),
                cashBalance: cash,
                bankAccountCount: accounts.count,
                pendingDocuments: data.pendingDocuments,
                dueThisWeek: DashboardSeries.dueThisWeek(invoicesDue + billsDue),
                recentPayments: (data.recentPayments ?? []).map { row in
                    RecentPayment(
                        id: row.id, type: row._type, date: row.date, amount: Amounts.of(row.amount), currency: row.currency,
                        method: row.paymentMethod, reference: row.reference, invoiceId: row.invoiceId, billId: row.billId
                    )
                },
                trend: (data.monthlyTrend ?? []).map { row in
                    TrendMonth(
                        month: row.month,
                        revenue: row.revenue.map { Amounts.of($0) },
                        expenses: row.expenses.map { Amounts.of($0) },
                        profit: row.profit.map { Amounts.of($0) }
                    )
                }
            )
        }
    }

    private func dashboardFigures() async throws -> Components.Schemas.Dashboard {
        switch try await client().getAccountingDashboard() {
        case let .ok(ok): return try ok.body.json.data
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    func profitLoss(from: String, to: String) async throws -> ProfitLoss {
        try await call {
            switch try await client().getProfitLoss(query: .init(from: from, to: to)) {
            case let .ok(ok):
                let data = try ok.body.json.data
                return ProfitLoss(revenue: Amounts.of(data.totalRevenue), expenses: Amounts.of(data.totalExpenses), netProfit: Amounts.of(data.netProfit))
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func balanceSheet() async throws -> BalanceSheet {
        try await call {
            switch try await client().getBalanceSheet() {
            case let .ok(ok):
                let data = try ok.body.json.data
                func rows(_ list: [Components.Schemas.BalanceSheetRow]) -> [BalanceRow] {
                    list.map { BalanceRow(code: $0.accountCode, name: $0.accountName, balance: Amounts.of($0.balance)) }
                }
                return BalanceSheet(
                    assets: rows(data.assets),
                    liabilities: rows(data.liabilities),
                    equity: rows(data.equity),
                    totalAssets: Amounts.of(data.totalAssets),
                    totalLiabilities: Amounts.of(data.totalLiabilities),
                    totalEquity: Amounts.of(data.totalEquity),
                    totalLiabilitiesAndEquity: Amounts.of(data.totalLiabilitiesAndEquity)
                )
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    // MARK: - VAT returns

    func vatReturns() async throws -> [VatReturn] {
        try await call {
            switch try await client().listVatReturns() {
            case let .ok(ok): return try ok.body.json.data.map(Self.vatReturn)
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func vatReturn(id: String) async throws -> VatReturn {
        try await call {
            switch try await client().getVatReturn(path: .init(id: id)) {
            case let .ok(ok): return Self.vatReturn(try ok.body.json.data)
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func fileVatReturn(id: String) async throws {
        try await call {
            switch try await client().fileVatReturn(path: .init(id: id)) {
            case .ok: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    // MARK: - Invoices

    func invoices(page: Int, pageSize: Int, search: String?, status: String?) async throws -> Page<Invoice> {
        try await call {
            switch try await client().listInvoices(query: .init(page: page, pageSize: pageSize, search: search, status: status)) {
            case let .ok(ok):
                let result = try ok.body.json
                return Page(items: result.data.map(Self.invoice), totalCount: result.pagination.totalCount, hasMore: result.pagination.hasMore)
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func invoice(id: String) async throws -> Invoice {
        try await call {
            switch try await client().getInvoice(path: .init(id: id)) {
            case let .ok(ok): return Self.invoice(try ok.body.json.data)
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    /// Creates the draft (and its contact when the name is new); returns its id.
    func createInvoice(_ values: NewInvoice) async throws -> String {
        try await call {
            let contactId = try await resolveContactId(name: values.contactName, email: values.contactEmail)
            let input = Components.Schemas.InvoiceInput(
                contactId: contactId,
                contactName: values.contactName,
                contactEmail: values.contactEmail,
                issueDate: values.issueDate,
                dueDate: values.dueDate,
                notes: values.notes,
                reference: values.reference,
                billingAddress: values.billingAddress.map(Self.postal),
                shippingAddress: values.shippingAddress.map(Self.postal),
                items: values.lines.map(Self.line)
            )
            switch try await client().createInvoice(body: .json(input)) {
            case let .created(created): return try created.body.json.data.id
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    /// Book a draft; refused with `CompanyFieldsMissing` while the company lacks invoice fields.
    func finalizeInvoice(id: String) async throws {
        try await call {
            switch try await client().finalizeInvoice(path: .init(id: id)) {
            case .ok: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func sendInvoice(id: String) async throws {
        try await call {
            switch try await client().sendInvoice(path: .init(id: id)) {
            case .ok: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func cancelInvoice(id: String) async throws {
        try await call {
            switch try await client().setInvoiceStatus(path: .init(id: id), body: .json(.init(status: .cancelled))) {
            case .ok: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func recordInvoicePayment(id: String, payment: PaymentValues) async throws {
        let input = Components.Schemas.InvoicePaymentInput(
            amount: Amounts.plain(Amounts.cents(payment.amount)),
            date: payment.date,
            paymentMethod: payment.method,
            checkNumber: payment.checkNumber,
            depositTo: payment.depositTo.flatMap { Components.Schemas.InvoicePaymentInput.DepositToPayload(rawValue: $0) }
        )
        try await call {
            switch try await client().recordInvoicePayment(path: .init(id: id), body: .json(input)) {
            case .created: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    /// A new draft copied from the invoice; returns its id.
    func duplicateInvoice(id: String) async throws -> String {
        try await call {
            switch try await client().duplicateInvoice(path: .init(id: id)) {
            case let .created(created): return try created.body.json.data.id
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    /// A draft credit note reversing the invoice; returns its id.
    func createCreditNote(id: String) async throws -> String {
        try await call {
            switch try await client().createCreditNote(path: .init(id: id)) {
            case let .created(created): return try created.body.json.data.id
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func deleteInvoice(id: String) async throws {
        try await call {
            switch try await client().deleteInvoice(path: .init(id: id)) {
            case .ok: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    /// The printable invoice: HTML from `GET /api/invoices/:id/pdf`.
    func invoiceDocument(id: String) async throws -> String {
        let data = try await rawSend(method: "GET", path: "api/invoices/\(Self.segment(id))/pdf", accept: "text/html")
        return String(decoding: data, as: UTF8.self)
    }

    /// The sales tax of a US draft invoice; nothing is saved.
    func previewSalesTax(contactName: String, issueDate: String, shipTo: Address?, billTo: Address?, lines: [LineInputValues]) async throws -> TaxPreview {
        let contactId = await findContactId(name: contactName)
        let input = Components.Schemas.SalesTaxInput(
            kind: .invoice,
            contactId: contactId,
            issueDate: issueDate,
            billingAddress: billTo.map(Self.postal),
            shippingAddress: shipTo.map(Self.postal),
            items: lines.enumerated().map { index, line in
                Components.Schemas.SalesTaxLine(
                    id: "line_\(index)",
                    description: line.description,
                    quantity: line.quantity,
                    unitPrice: line.unitPrice,
                    taxRate: line.taxRate,
                    taxCode: line.taxCode,
                    accrueUseTax: line.accrueUseTax ? true : nil
                )
            }
        )
        return try await call {
            switch try await client().calculateSalesTax(body: .json(input)) {
            case let .ok(ok):
                let data = try ok.body.json.data
                let rows: [Components.Schemas.TaxBreakdownRow] = data.taxBreakdown ?? []
                return TaxPreview(
                    warnings: data.warnings,
                    addressIncomplete: data.addressIncomplete,
                    subtotal: Amounts.of(data.subtotal),
                    taxTotal: Amounts.of(data.taxTotal),
                    total: Amounts.of(data.total),
                    taxBreakdown: rows.map(Self.taxRow)
                )
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    // MARK: - Bills

    func bills(page: Int, pageSize: Int, search: String?, status: String?) async throws -> Page<Bill> {
        try await call {
            switch try await client().listBills(query: .init(page: page, pageSize: pageSize, search: search, status: status)) {
            case let .ok(ok):
                let result = try ok.body.json
                return Page(items: result.data.map(Self.bill), totalCount: result.pagination.totalCount, hasMore: result.pagination.hasMore)
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func bill(id: String) async throws -> Bill {
        try await call {
            switch try await client().getBill(path: .init(id: id)) {
            case let .ok(ok): return Self.bill(try ok.body.json.data)
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    /// Creates the draft bill (and its contact when the name is new); returns its id.
    func createBill(_ values: NewBill) async throws -> String {
        try await call {
            let contactId: String
            if let known = values.contactId {
                contactId = known
            } else {
                contactId = try await resolveContactId(name: values.contactName, email: nil)
            }
            let input = Components.Schemas.BillInput(
                contactId: contactId,
                contactName: values.contactName,
                billNumber: values.billNumber,
                issueDate: values.issueDate,
                dueDate: values.dueDate,
                currency: values.currency,
                notes: values.notes,
                reference: values.reference,
                externalReference: values.reference,
                sourceDocumentId: values.sourceDocumentId,
                deliveryAddress: values.deliveryAddress.map(Self.postal),
                items: values.lines.map(Self.line)
            )
            switch try await client().createBill(body: .json(input)) {
            case let .created(created): return try created.body.json.data.id
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func approveBill(id: String) async throws -> Bill {
        try await call {
            switch try await client().approveBill(path: .init(id: id)) {
            case let .ok(ok): return Self.bill(try ok.body.json.data)
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func rejectBill(id: String, reason: String) async throws {
        try await call {
            switch try await client().rejectBill(path: .init(id: id), body: .json(.init(reason: reason))) {
            case .ok: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func deleteBill(id: String) async throws {
        try await call {
            switch try await client().deleteBill(path: .init(id: id)) {
            case .noContent: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    /// Bills are settled by an outgoing payment.
    func recordBillPayment(id: String, payment: PaymentValues) async throws {
        let bill = try await self.bill(id: id)
        let input = Components.Schemas.PaymentInput(
            _type: .sent,
            amount: Amounts.plain(Amounts.cents(payment.amount)),
            date: payment.date,
            billId: id,
            contactId: bill.contactId,
            paymentMethod: payment.method,
            checkNumber: payment.checkNumber
        )
        try await call {
            switch try await client().createPayment(body: .json(input)) {
            case .created: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    /// A quick expense is a bill that is approved and paid straight away, so the
    /// cost is in the books at once. Once the bill exists, a failed approval or
    /// payment is a `QuickExpenseNotBooked`, never a plain failure.
    func createQuickExpense(_ values: QuickExpenseValues) async throws -> String {
        let description = values.description?.nilIfBlank ?? values.category
        var lines: [LineInputValues]
        if values.amountIncludesTax {
            lines = QuickExpense.lines(
                total: values.amount,
                rate: values.taxRate,
                description: description,
                roundingDescription: values.roundingDescription,
                accountId: values.accountId,
                receiptLines: values.receiptLines
            )
        } else {
            lines = [LineInputValues(
                description: description, quantity: "1", unitPrice: Amounts.plain(values.amount),
                taxRate: Amounts.plain(values.taxRate), taxCode: nil, accrueUseTax: false, accountId: values.accountId, sortOrder: 0
            )]
        }
        if values.accrueUseTax, !lines.isEmpty {
            lines[0].accrueUseTax = true
            lines[0].taxCode = values.taxCode
        }
        let billId = try await createBill(NewBill(
            contactId: values.contactId,
            contactName: values.vendorName?.nilIfBlank ?? "Quick Expense",
            billNumber: nil,
            currency: values.currency,
            issueDate: values.date,
            dueDate: values.date,
            notes: values.description,
            reference: nil,
            sourceDocumentId: values.documentId,
            deliveryAddress: nil,
            lines: lines
        ))
        if !values.amountIncludesTax { return billId }
        do {
            let approved = try await approveBill(id: billId)
            let bill = try await self.bill(id: billId)
            let amount = approved.total > 0 ? approved.total : bill.total
            try await recordBillPayment(id: billId, payment: PaymentValues(amount: amount, date: values.date, method: values.paymentMethod))
        } catch let error as BooksError {
            throw QuickExpenseNotBooked(billId: billId, cause: error)
        }
        return billId
    }

    // MARK: - Documents

    /// Store a receipt (upload, then register it as a document) and return the document's id.
    func uploadReceipt(_ file: LocalFile) async throws -> String {
        let fileKey = try await upload(file)
        let input = Components.Schemas.DocumentInput(
            _type: .receipt,
            fileName: file.fileName,
            originalFileName: file.fileName,
            fileKey: fileKey,
            mimeType: file.mimeType,
            source: .scan
        )
        return try await call {
            switch try await client().createAccountingDocument(body: .json(input)) {
            case let .created(created): return try created.body.json.data.id
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    /// Read a document with OCR. A 402 means there are no AI credits.
    func processDocument(id: String) async throws {
        try await call {
            switch try await client().processAccountingDocument(path: .init(id: id)) {
            case .ok: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func billFromDocument(id: String) async throws -> BillPrefill {
        try await call {
            switch try await client().billFromDocument(path: .init(id: id)) {
            case let .ok(ok):
                let data = try ok.body.json.data
                return BillPrefill(
                    contactName: data.contactName?.nilIfBlank,
                    externalReference: data.externalReference?.nilIfBlank,
                    issueDate: data.issueDate?.take(10).nilIfBlank,
                    dueDate: data.dueDate?.take(10).nilIfBlank,
                    currency: data.currency?.nilIfBlank,
                    items: data.items.map {
                        PrefillLine(description: $0.description, quantity: $0.quantity, unitPrice: $0.unitPrice, taxRate: $0.taxRate?.nilIfBlank, sortOrder: $0.sortOrder ?? 0)
                    },
                    subtotal: data.subtotal.map { Amounts.of($0) },
                    taxTotal: data.taxTotal.map { Amounts.of($0) },
                    total: data.total.map { Amounts.of($0) },
                    sourceDocumentId: data.sourceDocumentId,
                    matchedContactId: data.matchedContactId
                )
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    /// The image a bill was booked from; nil without a stored image (a PDF isn't shown).
    func storedReceipt(documentId: String) async throws -> StoredFile? {
        let document: Components.Schemas.AccountingDocument = try await call {
            switch try await client().getAccountingDocument(path: .init(id: documentId)) {
            case let .ok(ok): return try ok.body.json.data
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
        let mime = document.mimeType
        if let mime, !mime.hasPrefix("image/") { return nil }
        let key = document.fileKey.split(separator: "/", omittingEmptySubsequences: false).map { Self.segment(String($0)) }.joined(separator: "/")
        let data = try await rawSend(method: "GET", path: "api/storage/private/\(key)", accept: "*/*")
        return StoredFile(bytes: data, mimeType: mime)
    }

    /// The storage broker's three steps: a ticket, the bytes, the confirmation. Returns the file key.
    private func upload(_ file: LocalFile) async throws -> String {
        let ticketBody = try JSONSerialization.data(withJSONObject: [
            "fileName": file.fileName,
            "contentType": file.mimeType,
            "fileSize": file.bytes.count,
            "folder": "accounting-documents",
            "entityType": "accounting-document",
        ] as [String: Any])
        let ticketData = try await rawSend(method: "POST", path: "api/storage/generate-upload-url", body: ticketBody)
        guard let ticket = try? JSONDecoder().decode(UploadTicket.self, from: ticketData),
              let uploadURLText = ticket.uploadUrl, let uploadURL = URL(string: uploadURLText),
              let uploadToken = ticket.uploadToken, let fileKey = ticket.fileKey
        else { throw BooksError(api: APIError(status: 0, code: nil), message: nil) }

        // The token in the URL is the credential; the upload takes no session header.
        var put = URLRequest(url: uploadURL)
        put.httpMethod = "PUT"
        put.setValue(file.mimeType, forHTTPHeaderField: "Content-Type")
        let status: Int
        do {
            let (_, response) = try await URLSession.shared.upload(for: put, from: file.bytes)
            status = (response as? HTTPURLResponse)?.statusCode ?? 0
        } catch {
            throw BooksError.unreachable
        }
        guard (200..<300).contains(status) else { throw BooksError(api: APIError(status: status, code: nil), message: nil) }

        let confirm = try JSONSerialization.data(withJSONObject: ["uploadToken": uploadToken, "fileKey": fileKey])
        _ = try await rawSend(method: "POST", path: "api/storage/confirm-upload", body: confirm)
        return fileKey
    }

    // MARK: - Contacts

    func contacts(search: String?, role: String?) async throws -> [Contact] {
        try await call {
            switch try await client().listAccountingContacts(query: .init(page: 1, pageSize: 100, search: search, role: role)) {
            case let .ok(ok): return try ok.body.json.data.map(Self.contact)
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func contact(id: String) async throws -> Contact {
        try await call {
            switch try await client().getAccountingContact(path: .init(id: id)) {
            case let .ok(ok): return Self.contact(try ok.body.json.data)
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func contactBalance(id: String) async throws -> ContactBalance {
        try await call {
            switch try await client().getContactBalance(path: .init(id: id)) {
            case let .ok(ok):
                let data = try ok.body.json.data
                return ContactBalance(receivable: Amounts.of(data.receivable.totalOutstanding), payable: Amounts.of(data.payable.totalOutstanding))
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func contactInvoices(id: String) async throws -> [Invoice] {
        try await call {
            switch try await client().listContactInvoices(path: .init(id: id)) {
            case let .ok(ok): return try ok.body.json.data.map(Self.invoice)
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func contactBills(id: String) async throws -> [Bill] {
        try await call {
            switch try await client().listContactBills(path: .init(id: id)) {
            case let .ok(ok): return try ok.body.json.data.map(Self.bill)
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    /// Creates the contact; returns its id.
    func createContact(_ values: NewContact) async throws -> String {
        let identity = values.identity
        let input = Components.Schemas.ContactInput(
            kind: Components.Schemas.ContactInput.KindPayload(rawValue: identity.kind),
            fullName: identity.fullName,
            companyName: identity.companyName,
            firstName: identity.firstName,
            lastName: identity.lastName,
            email: values.email,
            phone: values.phone,
            vatNumber: identity.vatNumber,
            role: Components.Schemas.ContactInput.RolePayload(rawValue: values.role),
            billingAddress: values.billingAddress.map(Self.postal)
        )
        return try await call {
            switch try await client().createAccountingContact(body: .json(input)) {
            case let .created(created): return try created.body.json.data.id
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func deleteContact(id: String) async throws {
        try await call {
            switch try await client().deleteAccountingContact(path: .init(id: id)) {
            case .noContent: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    /// The contact whose name is `name` (ignoring case), or nil. Never creates one, never throws.
    func findContactId(name: String) async -> String? {
        let wanted = name.trimmed
        if wanted.isEmpty { return nil }
        guard let api = try? self.client(),
              let output = try? await api.listAccountingContacts(query: .init(page: 1, pageSize: 25, search: wanted)),
              case let .ok(ok) = output,
              let list = try? ok.body.json.data
        else { return nil }
        return list.first { $0.name.caseInsensitiveCompare(wanted) == .orderedSame }?.id
    }

    /// Invoices and bills need a contact id; the forms take a name, so find the contact or create it.
    private func resolveContactId(name: String, email: String?) async throws -> String {
        if let found = await findContactId(name: name) { return found }
        let input = Components.Schemas.ContactInput(fullName: name.trimmed, email: email?.nilIfBlank)
        switch try await client().createAccountingContact(body: .json(input)) {
        case let .created(created): return try created.body.json.data.id
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    // MARK: - Ledger

    func accounts() async throws -> [GlAccount] {
        try await call {
            switch try await client().listGlAccounts(query: .init()) {
            case let .ok(ok):
                return try ok.body.json.data.map {
                    GlAccount(id: $0.id, code: $0.code, name: $0.name, type: $0._type, isActive: $0.isActive != false)
                }
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    // MARK: - Banking

    func bankAccounts() async throws -> [BankAccount] {
        try await call {
            switch try await client().listBankAccounts() {
            case let .ok(ok): return try ok.body.json.data.map(Self.bankAccount)
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    /// The account and its latest 50 statement lines.
    func bankAccount(id: String) async throws -> (account: BankAccount, transactions: [BankTransaction]) {
        try await call {
            async let account = fetchBankAccount(id: id)
            async let lines = transactions(bankAccountId: id, status: nil, page: 1, pageSize: 50)
            return (account: try await account, transactions: try await lines.data.map(Self.transaction))
        }
    }

    private func fetchBankAccount(id: String) async throws -> BankAccount {
        switch try await client().getBankAccount(path: .init(id: id)) {
        case let .ok(ok): return Self.bankAccount(try ok.body.json.data)
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func transactions(bankAccountId: String?, status: String?, page: Int, pageSize: Int) async throws -> Components.Schemas.BankTransactionList {
        switch try await client().listBankTransactions(query: .init(bankAccountId: bankAccountId, status: status, page: page, pageSize: pageSize)) {
        case let .ok(ok): return try ok.body.json
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    func reconciliationStats() async throws -> ReconciliationStats {
        try await call {
            async let open = transactions(bankAccountId: nil, status: "unreconciled", page: 1, pageSize: 100)
            async let done = transactions(bankAccountId: nil, status: "reconciled", page: 1, pageSize: 1)
            let unmatched = try await open
            let matched = try await done
            return ReconciliationStats(
                unmatched: unmatched.pagination.totalCount,
                matched: matched.pagination.totalCount,
                pendingAmount: unmatched.data.reduce(Decimal(0)) { $0 + Amounts.of($1.amount).magnitude }
            )
        }
    }

    /// Open bank lines with the invoices and bills they may pay. A line's
    /// suggestions that fail to load degrade to none; payments, deposits and
    /// rules are left out, as a line can only be matched to an invoice or bill here.
    func unmatchedTransactions(limit: Int) async throws -> [UnmatchedTransaction] {
        try await call {
            let lines = try await transactions(bankAccountId: nil, status: "unreconciled", page: 1, pageSize: limit).data.map(Self.transaction)
            let apiClient = try self.client()
            let found = await withTaskGroup(of: (Int, [MatchSuggestion]).self) { group -> [Int: [MatchSuggestion]] in
                for (index, line) in lines.enumerated() {
                    group.addTask { (index, await Self.suggestions(apiClient, transactionId: line.id)) }
                }
                var result: [Int: [MatchSuggestion]] = [:]
                for await (index, suggestions) in group { result[index] = suggestions }
                return result
            }
            return lines.enumerated().map { index, line in UnmatchedTransaction(transaction: line, suggestions: found[index] ?? []) }
        }
    }

    private nonisolated static func suggestions(_ client: Client, transactionId: String) async -> [MatchSuggestion] {
        guard let output = try? await client.listMatchSuggestions(path: .init(id: transactionId)),
              case let .ok(ok) = output,
              let list = try? ok.body.json.data
        else { return [] }
        return list
            .filter { $0._type == "invoice" || $0._type == "bill" }
            .map { MatchSuggestion(id: $0.id, type: $0._type, number: $0.number, contactName: $0.contactName, amount: Amounts.of($0.amount), confidence: $0.confidence) }
    }

    func reconcile(transactionId: String, suggestion: MatchSuggestion) async throws {
        let input = suggestion.type == "invoice"
            ? Components.Schemas.ReconcileInput(_type: .invoice, entityId: suggestion.id)
            : Components.Schemas.ReconcileInput(_type: .bill, entityId: suggestion.id)
        try await call {
            switch try await client().reconcileTransaction(path: .init(id: transactionId), body: .json(input)) {
            case .ok: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    // MARK: - Raw calls

    /// A path segment, percent-encoded (`/` included).
    nonisolated static func segment(_ text: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return text.addingPercentEncoding(withAllowedCharacters: allowed) ?? text
    }

    /// The calls the contract doesn't describe (the printable invoice, the
    /// storage broker), with the same headers as the generated client: the
    /// bearer token, `X-Weld-App`, `X-Weld-Workspace`, the company; a 401
    /// refreshes the token once.
    private func rawSend(method: String, path: String, body: Data? = nil, accept: String = "application/json") async throws -> Data {
        let base = env.serverURL.absoluteString.hasSuffix("/") ? env.serverURL.absoluteString : env.serverURL.absoluteString + "/"
        guard let root = URL(string: base), let url = URL(string: path, relativeTo: root) else {
            throw BooksError(api: APIError(status: 0, code: nil), message: nil)
        }
        let workspace = env.session?.activeWorkspaceID
        let entity = entityId
        func request(_ token: String?) -> URLRequest {
            var request = URLRequest(url: url)
            request.httpMethod = method
            request.setValue(accept, forHTTPHeaderField: "Accept")
            request.setValue(env.app.code, forHTTPHeaderField: "X-Weld-App")
            if let workspace { request.setValue(workspace, forHTTPHeaderField: "X-Weld-Workspace") }
            if let entity { request.setValue(entity, forHTTPHeaderField: Self.entityHeader) }
            if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            if let body {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = body
            }
            return request
        }
        let token = await env.session?.token()
        var (data, status) = try await perform(request(token))
        if status == 401, token != nil, let fresh = await env.session?.refreshedToken() {
            (data, status) = try await perform(request(fresh))
        }
        guard (200..<300).contains(status) else {
            let error = try? JSONDecoder().decode(Components.Schemas.ErrorResponse.self, from: data)
            throw Self.failure(status, error?.error)
        }
        return data
    }

    private func perform(_ request: URLRequest) async throws -> (Data, Int) {
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
        } catch {
            throw BooksError.unreachable
        }
    }

    // MARK: - Mapping

    nonisolated static func postal(_ address: Address) -> Components.Schemas.PostalAddress {
        Components.Schemas.PostalAddress(
            line1: address.line1, line2: address.line2, city: address.city, state: address.state,
            postalCode: address.postalCode, country: address.country, county: address.county
        )
    }

    nonisolated static func address(_ postal: Components.Schemas.PostalAddress?) -> Address? {
        guard let postal else { return nil }
        let address = Address(
            line1: postal.line1, line2: postal.line2, city: postal.city, state: postal.state,
            postalCode: postal.postalCode, country: postal.country, county: postal.county
        )
        return address.isEmpty ? nil : address
    }

    nonisolated static func line(_ values: LineInputValues) -> Components.Schemas.LineInput {
        Components.Schemas.LineInput(
            description: values.description,
            quantity: values.quantity,
            unitPrice: values.unitPrice,
            taxRate: values.taxRate,
            taxCode: values.taxCode,
            accrueUseTax: values.accrueUseTax ? true : nil,
            accountId: values.accountId,
            sortOrder: values.sortOrder
        )
    }

    nonisolated static func entity(_ row: Components.Schemas.AccountingEntity) -> Entity {
        let ids = row.taxIdentifiers?.value1
        let bank = row.bankDetails?.value1
        let ein = ids?.einOrSsn?.trimmed
        return Entity(
            id: row.id,
            name: row.name,
            legalName: row.legalName,
            jurisdictionCode: row.jurisdictionCode,
            baseCurrency: row.baseCurrency,
            locale: row.locale,
            address: address(row.address?.value1),
            entityType: row.entityType,
            taxClassification: row.taxClassification,
            dba: row.dba,
            ein: ein.flatMap { $0.fullyMatches("\\d{2}-\\d{7}") ? $0 : nil },
            vatNumber: ids?.vatNumber?.trimmed.nilIfEmpty,
            registrationNumber: ids?.registrationNumber?.trimmed.nilIfEmpty,
            iban: bank?.iban?.trimmed.nilIfEmpty,
            bic: bank?.bic?.trimmed.nilIfEmpty,
            fiscalYearStart: row.fiscalYearStart,
            isDefault: row.isDefault == true,
            isActive: row.isActive != false
        )
    }

    nonisolated static func jurisdiction(_ row: Components.Schemas.Jurisdiction) -> Jurisdiction {
        let f = row.features
        let t = row.terminology
        return Jurisdiction(
            code: row.code.uppercased(),
            name: row.name,
            defaultLocale: row.defaultLocale,
            defaultCurrency: row.defaultCurrency,
            features: Features(
                vatReturn: f.vatReturn, icp: f.icp, xafExport: f.xafExport, smallBusinessScheme: f.smallBusinessScheme,
                gstReturn: f.gstReturn, salesTax: f.salesTax, form1099: f.form1099, brTaxReturn: f.brTaxReturn,
                fiscalDocuments: f.fiscalDocuments, spedEcd: f.spedEcd
            ),
            terminology: Terminology(tax: t.tax, taxId: t.taxId, registrationId: t.registrationId, supplier: t.supplier, creditNote: t.creditNote),
            invoiceRequiredFields: row.invoiceRequiredFields,
            entityTypes: row.entityTypes?.map { type in
                UsEntityType(
                    type: type._type,
                    label: type.label,
                    defaultClassification: type.defaultClassification,
                    classifications: type.classifications.map { UsClassification(value: $0.value, form: $0.form, formLabel: $0.formLabel) }
                )
            }
        )
    }

    nonisolated static func taxRow(_ row: Components.Schemas.TaxBreakdownRow) -> TaxRow {
        TaxRow(
            name: row.taxRateName,
            rate: Amounts.of(row.taxRate),
            taxableAmount: Amounts.of(row.taxableAmount),
            taxAmount: Amounts.of(row.taxAmount),
            jurisdictionCode: row.jurisdictionCode,
            jurisdictionName: row.jurisdictionName,
            level: row.jurisdictionLevel,
            stateCode: row.stateCode,
            exemptAmount: Amounts.of(row.exemptAmount),
            nonTaxableAmount: Amounts.of(row.nonTaxableAmount),
            exemptReason: row.exemptReason?.nilIfBlank,
            kind: row.kind,
            component: row.component,
            treatment: row.treatment
        )
    }

    nonisolated static func documentLine(_ row: Components.Schemas.DocumentItem) -> DocumentLine {
        DocumentLine(
            id: row.id,
            description: row.description,
            quantity: Amounts.of(row.quantity ?? "1"),
            unitPrice: Amounts.of(row.unitPrice),
            taxRate: Amounts.of(row.taxRate),
            lineTotal: Amounts.of(row.lineTotal),
            taxCode: row.taxCode,
            accrueUseTax: row.accrueUseTax == true
        )
    }

    nonisolated static func invoice(_ row: Components.Schemas.Invoice) -> Invoice {
        let breakdown: [Components.Schemas.TaxBreakdownRow] = row.taxBreakdown ?? []
        let warnings: [String] = row.taxWarnings ?? []
        let items: [Components.Schemas.DocumentItem] = row.items ?? []
        return Invoice(
            id: row.id,
            number: row.invoiceNumber?.nilIfBlank,
            type: row._type,
            status: row.status,
            contactId: row.contactId,
            contactName: row.contactName?.nilIfBlank,
            contactEmail: row.contactEmail?.nilIfBlank,
            issueDate: row.issueDate,
            dueDate: row.dueDate,
            currency: row.currency?.nilIfBlank,
            subtotal: Amounts.of(row.subtotal),
            taxTotal: Amounts.of(row.taxTotal),
            total: Amounts.of(row.total),
            amountPaid: Amounts.of(row.amountPaid),
            balanceDue: Amounts.of(row.balanceDue),
            notes: row.notes?.nilIfBlank,
            reference: row.reference?.nilIfBlank,
            billingAddress: address(row.billingAddress?.value1),
            shippingAddress: address(row.shippingAddress?.value1),
            taxBreakdown: breakdown.map(taxRow),
            taxWarnings: warnings.filter { !$0.isBlank },
            lines: items.map(documentLine)
        )
    }

    nonisolated static func bill(_ row: Components.Schemas.Bill) -> Bill {
        let breakdown: [Components.Schemas.TaxBreakdownRow] = row.taxBreakdown ?? []
        let items: [Components.Schemas.DocumentItem] = row.items ?? []
        return Bill(
            id: row.id,
            number: row.billNumber?.nilIfBlank,
            status: row.status,
            approvalStatus: row.approvalStatus,
            contactId: row.contactId,
            contactName: row.contactName?.nilIfBlank,
            issueDate: row.issueDate,
            dueDate: row.dueDate,
            currency: row.currency?.nilIfBlank,
            subtotal: Amounts.of(row.subtotal),
            taxTotal: Amounts.of(row.taxTotal),
            total: Amounts.of(row.total),
            amountPaid: Amounts.of(row.amountPaid),
            balanceDue: Amounts.of(row.balanceDue),
            notes: row.notes?.nilIfBlank,
            reference: (row.reference ?? row.externalReference)?.nilIfBlank,
            sourceDocumentId: row.sourceDocumentId,
            deliveryAddress: address(row.deliveryAddress?.value1),
            taxBreakdown: breakdown.map(taxRow),
            lines: items.map(documentLine)
        )
    }

    nonisolated static func contact(_ row: Components.Schemas.AccountingContact) -> Contact {
        let kind = row.kind.flatMap { $0 == "company" || $0 == "person" ? $0 : nil }
        let person = row.contactPerson?.value1
        let keptPerson = kind == "company" && !(person?.personId.isEmpty ?? true) ? person : nil
        return Contact(
            id: row.id,
            name: row.name,
            kind: kind,
            role: row.role,
            email: row.email?.nilIfBlank,
            phone: row.phone?.nilIfBlank,
            vatNumber: row.vatNumber?.nilIfBlank,
            contactPerson: keptPerson.map { ContactPerson(name: $0.name, email: $0.email?.nilIfBlank, phone: $0.phone?.nilIfBlank) },
            billingAddress: address(row.billingAddress?.value1),
            shippingAddress: address(row.shippingAddress?.value1),
            is1099Vendor: row.is1099Vendor == true,
            tinType: row.tinType.flatMap { ["ein", "ssn", "itin"].contains($0) ? $0 : nil },
            tinLast4: row.tinLast4.flatMap { $0.fullyMatches("\\d{4}") ? $0 : nil }
        )
    }

    nonisolated static func bankAccount(_ row: Components.Schemas.BankAccount) -> BankAccount {
        BankAccount(
            id: row.id,
            name: row.name,
            iban: row.iban?.nilIfBlank,
            bankName: row.bankName?.nilIfBlank,
            accountType: row.accountType,
            routingNumber: row.routingNumber?.nilIfBlank,
            accountNumberLast4: row.accountNumberLast4,
            currency: row.currency?.nilIfBlank,
            balance: Amounts.of(row.currentBalance),
            lastImportDate: row.lastImportDate
        )
    }

    nonisolated static func transaction(_ row: Components.Schemas.BankTransaction) -> BankTransaction {
        BankTransaction(
            id: row.id,
            bankAccountId: row.bankAccountId,
            date: row.date,
            description: row.description?.nilIfBlank,
            amount: Amounts.of(row.amount),
            status: row.status,
            counterpartyName: row.counterpartyName?.nilIfBlank,
            reference: row.reference?.nilIfBlank
        )
    }

    nonisolated static func vatReturn(_ row: Components.Schemas.VatReturn) -> VatReturn {
        let boxes = row.rubrieken?.value1
        var values: [String: Decimal] = [:]
        if let value = boxes?.r1a { values["r1a"] = Amounts.of(value) }
        if let value = boxes?.r1b { values["r1b"] = Amounts.of(value) }
        if let value = boxes?.r2a { values["r2a"] = Amounts.of(value) }
        if let value = boxes?.r3a { values["r3a"] = Amounts.of(value) }
        if let value = boxes?.r3b { values["r3b"] = Amounts.of(value) }
        if let value = boxes?.r4a { values["r4a"] = Amounts.of(value) }
        if let value = boxes?.r4b { values["r4b"] = Amounts.of(value) }
        let sales = Amounts.of(boxes?.r5a)
        let purchase = Amounts.of(boxes?.r5b)
        let start = row.periodStart.take(10)
        return VatReturn(
            id: row.id,
            period: row.periodLabel?.nilIfBlank ?? start.take(7),
            year: Int(start.take(4)) ?? 0,
            status: Statuses.vatReturn(row.status),
            salesTax: sales,
            purchaseTax: purchase,
            netAmount: boxes?.r5c.map { Amounts.of($0) } ?? (sales - purchase),
            periodStart: row.periodStart,
            periodEnd: row.periodEnd,
            filedAt: row.filedAt,
            boxes: values
        )
    }
}

/// `POST /api/storage/generate-upload-url`, top level.
private struct UploadTicket: Decodable {
    let uploadUrl: String?
    let uploadToken: String?
    let fileKey: String?
}
