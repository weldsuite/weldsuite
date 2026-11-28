import Foundation

/// The statuses as the app shows them.
enum Statuses {
    /// An invoice's status: `partial` reads as partly paid, and a booked invoice
    /// with an open balance past its due date as overdue (the server derives
    /// overdue, it rarely stores it).
    static func invoice(_ status: String, dueDate: String?, balanceDue: Decimal, today: Day = Days.today()) -> String {
        let base = status == "partial" ? "partially_paid" : status
        let open = ["finalized", "sent", "viewed", "partially_paid"].contains(base)
        return open && Days.isOverdue(dueDate, balanceDue: balanceDue, today: today) ? "overdue" : base
    }

    /// A bill's: a rejected one is cancelled on the server, a partly paid one `partial`.
    static func bill(_ status: String, approvalStatus: String?, dueDate: String?, balanceDue: Decimal, today: Day = Days.today()) -> String {
        let base: String
        if approvalStatus == "rejected" || (status == "cancelled" && approvalStatus != "approved") {
            base = "rejected"
        } else if status == "partial" {
            base = "partially_paid"
        } else {
            base = status
        }
        let open = base == "approved" || base == "partially_paid"
        return open && Days.isOverdue(dueDate, balanceDue: balanceDue, today: today) ? "overdue" : base
    }

    /// A VAT return's: the server calls a filed return `filed`; the app calls it submitted.
    static func vatReturn(_ status: String) -> String { status == "filed" ? "submitted" : status }

    /// Colour family of a status: `success`, `warning`, `danger`, `neutral` or `brand`.
    static func tone(_ status: String) -> String {
        switch status {
        case "paid", "accepted": return "success"
        case "partially_paid", "pending": return "warning"
        case "overdue", "uncollectible", "rejected": return "danger"
        case "draft", "cancelled", "calculated", "reviewed": return "neutral"
        default: return "brand"
        }
    }

    static func billAwaitsApproval(_ bill: Bill) -> Bool {
        (bill.status == "draft" || bill.status == "pending") && bill.approvalStatus != "rejected"
    }

    static func billIsPayable(_ bill: Bill) -> Bool {
        bill.balanceDue > 0 && ["approved", "partial", "partially_paid", "overdue"].contains(bill.status)
    }

    static func invoiceIsSettled(_ status: String) -> Bool { ["paid", "cancelled", "uncollectible"].contains(status) }
}

/// How a line is taxed: a VAT/GST rate, a US product tax code (the server works out the tax), or US vendor tax paid as cost.
enum TaxMode: Hashable, Sendable {
    case rate, code, cost

    static func of(isUs: Bool, isInvoice: Bool) -> TaxMode {
        if !isUs { return .rate }
        return isInvoice ? .code : .cost
    }
}

/// A line of the invoice and bill forms, as typed.
struct LineDraft: Identifiable, Hashable, Sendable {
    var key: String
    var description: String = ""
    var quantity: String = "1"
    var unitPrice: String = ""
    var taxRate: String = "0"
    var taxCode: String = UsRules.defaultTaxCode
    var accrueUseTax: Bool = false

    var id: String { key }
}

/// A line as the API takes it: every number a decimal string.
struct LineInputValues: Hashable, Sendable {
    var description: String
    var quantity: String
    var unitPrice: String
    var taxRate: String?
    var taxCode: String?
    var accrueUseTax: Bool
    var accountId: String? = nil
    var sortOrder: Int
}

struct Totals: Hashable, Sendable {
    var subtotal: Decimal
    var taxTotal: Decimal
    var total: Decimal
}


enum LineItems {
    static func empty(taxRate: String) -> LineDraft {
        LineDraft(key: "li_\(UUID().uuidString)", taxRate: taxRate)
    }

    static func lineTotal(_ line: LineDraft, decimalPoint: Bool = false) -> Decimal {
        Amounts.parse(line.quantity.orIfBlank("0"), decimalPoint: decimalPoint) * Amounts.parse(line.unitPrice.orIfBlank("0"), decimalPoint: decimalPoint)
    }

    /// In `.code` mode the server calculates the tax, so it is 0 here.
    static func totals(_ lines: [LineDraft], mode: TaxMode, decimalPoint: Bool = false) -> Totals {
        var subtotal: Decimal = 0
        var tax: Decimal = 0
        for line in lines {
            let total = lineTotal(line, decimalPoint: decimalPoint)
            subtotal += total
            if mode != .code {
                tax += total * Amounts.parse(line.taxRate.orIfBlank("0"), decimalPoint: decimalPoint) / 100
            }
        }
        return Totals(subtotal: subtotal, taxTotal: tax, total: subtotal + tax)
    }

    /// Lines with a description and a price above zero.
    static func valid(_ lines: [LineDraft], decimalPoint: Bool = false) -> [LineDraft] {
        lines.filter { !$0.description.isBlank && Amounts.parse($0.unitPrice.orIfBlank("0"), decimalPoint: decimalPoint) > 0 }
    }

    static func inputs(_ lines: [LineDraft], mode: TaxMode, decimalPoint: Bool = false) -> [LineInputValues] {
        valid(lines, decimalPoint: decimalPoint).enumerated().map { (index, line) -> LineInputValues in
            var input = LineInputValues(
                description: line.description.trimmed,
                quantity: Amounts.plain(Amounts.parse(line.quantity.orIfBlank("1"), decimalPoint: decimalPoint)),
                unitPrice: Amounts.plain(Amounts.parse(line.unitPrice, decimalPoint: decimalPoint)),
                taxRate: nil,
                taxCode: nil,
                accrueUseTax: false,
                sortOrder: index
            )
            switch mode {
            case .rate:
                input.taxRate = Amounts.plain(Amounts.parse(line.taxRate.orIfBlank("0"), decimalPoint: decimalPoint))
            case .code:
                input.taxCode = line.taxCode.orIfBlank(UsRules.defaultTaxCode)
            case .cost:
                input.taxRate = Amounts.plain(Amounts.parse(line.taxRate.orIfBlank("0"), decimalPoint: decimalPoint))
                input.accrueUseTax = line.accrueUseTax
                input.taxCode = line.accrueUseTax ? line.taxCode.orIfBlank(UsRules.defaultTaxCode) : nil
            }
            return input
        }
    }

    /// Lines from a read receipt; one empty line when it had none.
    static func fromPrefill(_ prefill: BillPrefill, defaultTaxRate: String) -> [LineDraft] {
        if prefill.items.isEmpty { return [empty(taxRate: defaultTaxRate)] }
        return prefill.items.enumerated().map { (index, item) -> LineDraft in
            var line = empty(taxRate: defaultTaxRate)
            line.key = "ocr_\(index)_\(item.sortOrder)"
            line.description = item.description
            line.quantity = item.quantity.orIfBlank("1")
            line.unitPrice = item.unitPrice == "0" ? "" : item.unitPrice
            line.taxRate = item.taxRate ?? defaultTaxRate
            return line
        }
    }
}

/// A receipt shows what was paid, VAT included; books prices bill lines excluding it and rounds each line's tax to the cent.
enum QuickExpense {
    /// Gaps above this are an OCR misread, not rounding.
    private static let maxRoundingCents = 5

    private static func cents(_ amount: Decimal) -> Int { Amounts.int(Amounts.round(amount * 100, scale: 0)) }

    private static func taxCents(_ netCents: Int, _ rate: Decimal) -> Int {
        Amounts.int(Amounts.round(Decimal(netCents) * rate / 100, scale: 0))
    }

    private static func fromCents(_ cents: Int) -> Decimal { Decimal(cents) / 100 }

    struct Split: Hashable, Sendable {
        var net: Decimal
        var tax: Decimal
        var rounding: Decimal
    }

    /// The net price of `total` (VAT included) at `rate`, and the cent left over.
    static func split(_ total: Decimal, rate: Decimal) -> Split {
        let totalCents = cents(total)
        if rate <= 0 { return Split(net: fromCents(totalCents), tax: 0, rounding: 0) }
        let guess = Amounts.int(Amounts.round(Decimal(totalCents) / (1 + rate / 100), scale: 0))
        var best = guess
        var bestGap = Int.max
        for net in (guess - 2)...(guess + 2) {
            let gap = abs(totalCents - (net + taxCents(net, rate)))
            if gap < bestGap {
                best = net
                bestGap = gap
            }
        }
        let tax = taxCents(best, rate)
        return Split(net: fromCents(best), tax: fromCents(tax), rounding: fromCents(totalCents - best - tax))
    }

    /// The distinct rates on a receipt's lines, lowest first.
    static func rates(_ prefill: BillPrefill) -> [Decimal] {
        var result: [Decimal] = []
        for item in prefill.items {
            guard let rate = item.taxRate, !rate.isBlank else { continue }
            let value = Amounts.parse(rate)
            if !result.contains(value) { result.append(value) }
        }
        return result.sorted()
    }

    /// What the lines add up to, VAT included and rounded per line.
    static func linesTotal(_ items: [PrefillLine]) -> Decimal {
        var total = 0
        for item in items {
            let net = cents(Amounts.parse(item.quantity.orIfBlank("1")) * Amounts.parse(item.unitPrice.orIfBlank("0")))
            total += net + taxCents(net, Amounts.parse(item.taxRate ?? "0"))
        }
        return fromCents(total)
    }

    /// The receipt's own total, else what its lines add up to, else its subtotal.
    static func totalFromPrefill(_ prefill: BillPrefill) -> Decimal? {
        if let total = prefill.total, total > 0 { return total }
        let lines = linesTotal(prefill.items)
        if lines > 0 { return lines }
        if let subtotal = prefill.subtotal, subtotal > 0 { return subtotal }
        return nil
    }

    /// The rate that carries most of the receipt's net amount.
    static func mainRate(_ prefill: BillPrefill) -> String? {
        var order: [String] = []
        var byRate: [String: Decimal] = [:]
        for item in prefill.items {
            guard let rate = item.taxRate, !rate.isBlank else { continue }
            let net = Amounts.parse(item.quantity.orIfBlank("1")) * Amounts.parse(item.unitPrice.orIfBlank("0"))
            if byRate[rate] == nil { order.append(rate) }
            byRate[rate] = (byRate[rate] ?? 0) + net
        }
        var best: String?
        var bestNet: Decimal = 0
        for rate in order {
            let net = byRate[rate] ?? 0
            if best == nil || net > bestNet {
                best = rate
                bestNet = net
            }
        }
        return best
    }

    private static func roundingLine(_ gapCents: Int, _ description: String) -> [LineInputValues] {
        if gapCents == 0 || abs(gapCents) > maxRoundingCents { return [] }
        return [LineInputValues(
            description: description, quantity: "1", unitPrice: Amounts.plain(fromCents(gapCents)),
            taxRate: "0", taxCode: nil, accrueUseTax: false, accountId: nil, sortOrder: 0
        )]
    }

    private static func numbered(_ lines: [LineInputValues]) -> [LineInputValues] {
        lines.enumerated().map { (index, line) -> LineInputValues in
            var copy = line
            copy.sortOrder = index
            return copy
        }
    }

    /// The bill lines of a quick expense, adding up to `total`: the receipt's
    /// own lines when they carry several rates and add up to it, else one line
    /// at `rate`; any cent left over is an untaxed rounding line.
    static func lines(
        total: Decimal,
        rate: Decimal,
        description: String,
        roundingDescription: String,
        accountId: String?,
        receiptLines: [PrefillLine]?
    ) -> [LineInputValues] {
        if let receiptLines, !receiptLines.isEmpty {
            let gap = cents(total) - cents(linesTotal(receiptLines))
            if abs(gap) <= maxRoundingCents {
                let lines = receiptLines.map { item in
                    LineInputValues(
                        description: item.description.orIfBlank(description),
                        quantity: item.quantity.orIfBlank("1"),
                        unitPrice: item.unitPrice.orIfBlank("0"),
                        taxRate: item.taxRate ?? "0",
                        taxCode: nil,
                        accrueUseTax: false,
                        accountId: accountId,
                        sortOrder: 0
                    )
                }
                return numbered(lines + roundingLine(gap, roundingDescription))
            }
        }
        let parts = Self.split(total, rate: rate)
        let main = LineInputValues(
            description: description, quantity: "1", unitPrice: Amounts.plain(parts.net),
            taxRate: Amounts.plain(rate), taxCode: nil, accrueUseTax: false, accountId: accountId, sortOrder: 0
        )
        return numbered([main] + roundingLine(cents(parts.rounding), roundingDescription))
    }
}

/// Payment methods and where a received payment lands, per country.
enum Payments {
    static let usMethods = ["check", "ach", "wire", "credit_card", "debit_card", "cash", "other"]
    static let defaultMethods = ["bank_transfer", "card", "cash", "direct_debit", "manual"]

    static func methods(isUs: Bool) -> [String] { isUs ? usMethods : defaultMethods }

    static func defaultMethod(isUs: Bool) -> String { isUs ? "ach" : "bank_transfer" }

    /// How a receipt is usually paid: at the till, by card.
    static func defaultExpenseMethod(isUs: Bool) -> String { isUs ? "debit_card" : "card" }

    /// Only a received check or cash payment can wait in Undeposited Funds.
    static func offersDepositChoice(isUs: Bool, received: Bool, method: String) -> Bool {
        isUs && received && (method == "check" || method == "cash")
    }

    static func takesCheckNumber(isUs: Bool, method: String) -> Bool { isUs && method == "check" }

    /// `••••1234`.
    static func masked(_ last4: String?) -> String? {
        guard let last4, last4.fullyMatches("\\d{1,4}") else { return nil }
        return "••••\(last4)"
    }

    static let bankAccountTypes = ["checking", "savings", "credit_card", "money_market", "line_of_credit"]

    /// "Chase · Checking ••••1234" for a US account, else its IBAN or bank name.
    static func accountSubtitle(_ account: BankAccount, typeLabel: (String) -> String) -> String? {
        if let number = masked(account.accountNumberLast4) {
            let type = account.accountType.flatMap { bankAccountTypes.contains($0) ? typeLabel($0) : nil }
            let detail = [type, number].compactMap { $0 }.joined(separator: " ")
            return [account.bankName, detail].compactMap { $0 }.joined(separator: " · ")
        }
        return account.iban ?? account.bankName
    }
}

/// A document's tax, grouped as the detail screens show it. Nothing here calculates tax.
enum TaxBreakdown {
    private static let levelOrder = ["state": 0, "county": 1, "city": 2, "district": 3]

    struct Group: Identifiable, Hashable, Sendable {
        var key: String
        var name: String
        var level: String?
        var rate: Decimal
        var taxable: Decimal
        var tax: Decimal
        var exempt: Decimal
        var kind: String

        var id: String { key }
    }

    /// Per jurisdiction (and rate), state first; US use tax after the tax charged.
    static func groups(_ rows: [TaxRow]) -> [Group] {
        var order: [String] = []
        var groups: [String: Group] = [:]
        for row in rows {
            let kind = row.kind == "use" ? "use" : "tax"
            let name = row.jurisdictionName ?? row.name ?? row.jurisdictionCode ?? ""
            let key = [kind, row.jurisdictionCode ?? name, row.level ?? "", Amounts.plain(row.rate)].joined(separator: "|")
            var group = groups[key] ?? Group(key: key, name: name, level: row.level, rate: row.rate, taxable: 0, tax: 0, exempt: 0, kind: kind)
            if groups[key] == nil { order.append(key) }
            group.taxable = Amounts.cents(group.taxable + row.taxableAmount)
            group.tax = Amounts.cents(group.tax + row.taxAmount)
            group.exempt = Amounts.cents(group.exempt + row.exemptAmount)
            groups[key] = group
        }
        let list = order.enumerated().compactMap { index, key in groups[key].map { (index, $0) } }
        return list.sorted { left, right in
            let a = left.1
            let b = right.1
            let kindA = a.kind == "tax" ? 0 : 1
            let kindB = b.kind == "tax" ? 0 : 1
            if kindA != kindB { return kindA < kindB }
            let levelA = a.level.flatMap { levelOrder[$0] } ?? 9
            let levelB = b.level.flatMap { levelOrder[$0] } ?? 9
            if levelA != levelB { return levelA < levelB }
            if a.name != b.name { return a.name < b.name }
            return left.0 < right.0
        }.map(\.1)
    }

    static func hasExempt(_ rows: [TaxRow]) -> Bool { rows.contains { $0.exemptAmount > 0 || $0.exemptReason != nil } }

    static func exemptAmount(_ rows: [TaxRow]) -> Decimal { rows.reduce(0) { $0 + $1.exemptAmount } }

    /// "resale" → "Resale", "non_profit" → "Non profit", without repeats.
    static func exemptReasons(_ rows: [TaxRow]) -> [String] {
        var seen: [String] = []
        for reason in rows.compactMap(\.exemptReason) where !seen.contains(reason) { seen.append(reason) }
        return seen.map { $0.replacingOccurrences(of: "_", with: " ").trimmed.capitalizedFirst }
    }

    static func chargedTotal(_ rows: [TaxRow]) -> Decimal {
        Amounts.cents(rows.filter { $0.kind != "use" }.reduce(0) { $0 + $1.taxAmount })
    }

    static func useTaxTotal(_ rows: [TaxRow]) -> Decimal {
        Amounts.cents(rows.filter { $0.kind == "use" }.reduce(0) { $0 + $1.taxAmount })
    }

    /// `not_registered_in_state` or `tax_engine_unavailable: it timed out` → the code and the detail.
    static func parseWarning(_ warning: String) -> (code: String, detail: String?) {
        guard let index = warning.firstIndex(of: ":") else { return (warning.trimmed, nil) }
        let code = String(warning[..<index]).trimmed
        let detail = String(warning[warning.index(after: index)...]).trimmed
        return (code, detail.nilIfEmpty)
    }

    /// A warning in words: a known code's text, else the code made readable.
    static func warningText(_ warning: String, known: (String) -> String?) -> String {
        let (code, detail) = parseWarning(warning)
        if let text = known(code) { return text }
        let readable = code.replacingOccurrences(of: "_", with: " ")
        if let detail { return "\(readable): \(detail)" }
        return readable
    }

    // MARK: Brazil: how each tax sits in the total.

    static let treatments = ["added", "embedded", "withheld", "informational"]

    struct TreatmentTax: Identifiable, Hashable, Sendable {
        var key: String
        var name: String
        var rate: Decimal
        var base: Decimal
        var amount: Decimal

        var id: String { key }
    }

    struct TreatmentGroup: Identifiable, Hashable, Sendable {
        var treatment: String
        var taxes: [TreatmentTax]
        var total: Decimal

        var id: String { treatment }
    }

    static func hasTreatments(_ rows: [TaxRow]) -> Bool {
        rows.contains { row in row.treatment.map { treatments.contains($0) } ?? false }
    }

    static func byTreatment(_ rows: [TaxRow]) -> [TreatmentGroup] {
        var keys: [String: [String]] = [:]
        var taxes: [String: [String: TreatmentTax]] = [:]
        for row in rows {
            guard let treatment = row.treatment, treatments.contains(treatment) else { continue }
            let name = row.name?.nilIfEmpty ?? (row.component?.uppercased() ?? "")
            let key = [row.component ?? name, name, Amounts.plain(row.rate)].joined(separator: "|")
            var bucket = taxes[treatment] ?? [:]
            var tax = bucket[key] ?? TreatmentTax(key: key, name: name, rate: row.rate, base: 0, amount: 0)
            if bucket[key] == nil { keys[treatment, default: []].append(key) }
            tax.base = Amounts.cents(tax.base + row.taxableAmount)
            tax.amount = Amounts.cents(tax.amount + row.taxAmount.magnitude)
            bucket[key] = tax
            taxes[treatment] = bucket
        }
        return treatments.compactMap { treatment -> TreatmentGroup? in
            guard let bucket = taxes[treatment] else { return nil }
            let list = (keys[treatment] ?? []).compactMap { bucket[$0] }
            return TreatmentGroup(treatment: treatment, taxes: list, total: Amounts.cents(list.reduce(0) { $0 + $1.amount }))
        }
    }

    /// What the taxes add to the subtotal and what is withheld from it.
    static func treatmentTotals(_ rows: [TaxRow]) -> (added: Decimal, withheld: Decimal) {
        let groups = byTreatment(rows)
        let added = groups.first { $0.treatment == "added" }?.total ?? 0
        let withheld = groups.first { $0.treatment == "withheld" }?.total ?? 0
        return (added, withheld)
    }
}

/// Which expense account a quick-expense category books to, found by name in the company's own chart.
enum ExpenseCategories {
    static let all = ["food", "transport", "office", "travel", "supplies", "utilities", "insurance", "other"]

    /// Case-insensitive ICU patterns, tried in order.
    private static let patterns: [String: [String]] = [
        "food": ["\\bmeals?\\b", "representatie", "refei[çc]", "aliment", "kantine", "entertainment"],
        "transport": ["autokosten", "car and truck", "vervoer", "conveyance", "ve[íi]cul", "combust"],
        "office": ["kantoorkosten", "office expense", "escrit[óo]rio", "kantoorbenodigd"],
        "travel": ["reiskosten", "\\btravel", "viage"],
        "supplies": ["kantoorbenodigd", "\\bsupplies\\b", "material de", "consumo"],
        "utilities": ["gas, water", "\\butilities\\b", "energia", "energie", "elektra", "telefoon"],
        "insurance": ["verzekering", "\\binsurance\\b", "seguro"],
        "other": ["algemene kosten", "general expense", "other expense", "despesas gerais"],
    ]

    /// The active expense accounts, by code (numbers compared as numbers).
    static func expenseAccounts(_ accounts: [GlAccount]) -> [GlAccount] {
        accounts.filter { $0.type == "expense" && $0.isActive }
            .enumerated()
            .sorted { left, right in
                let order = naturalCompare(left.element.code, right.element.code)
                return order != 0 ? order < 0 : left.offset < right.offset
            }
            .map(\.element)
    }

    static func accountFor(_ category: String, _ accounts: [GlAccount]) -> GlAccount? {
        let candidates = expenseAccounts(accounts)
        for pattern in patterns[category] ?? [] {
            if let found = candidates.first(where: { $0.name.containsMatch(pattern, ignoringCase: true) }) { return found }
        }
        return nil
    }

    /// -1, 0 or 1.
    private static func naturalCompare(_ a: String, _ b: String) -> Int {
        if let x = Int64(a), let y = Int64(b) { return x == y ? 0 : (x < y ? -1 : 1) }
        return a == b ? 0 : (a < b ? -1 : 1)
    }
}

/// The identity half of the new-contact form: a company or a person.
struct ContactIdentityDraft: Hashable, Sendable {
    var kind: String = "company"
    var companyName: String = ""
    var nameOnInvoices: String = ""
    var firstName: String = ""
    var lastName: String = ""
    var taxId: String = ""

    static let nameMax = 255
    static let personNameMax = 100

    /// `companyName` or `personName` when the name is missing.
    func problem() -> String? {
        if kind == "company" { return companyName.isBlank ? "companyName" : nil }
        return firstName.isBlank && lastName.isBlank ? "personName" : nil
    }

    struct Payload: Hashable, Sendable {
        var kind: String
        var fullName: String
        var companyName: String?
        var firstName: String?
        var lastName: String?
        var vatNumber: String?
    }

    /// Only the chosen kind's fields go out: a company's VAT number never lands on a person.
    func payload(withTaxId: Bool) -> Payload {
        if kind == "person" {
            let first = firstName.trimmed
            let last = lastName.trimmed
            let full = [first, last].filter { !$0.isEmpty }.joined(separator: " ")
            return Payload(kind: "person", fullName: full, companyName: nil, firstName: first.nilIfEmpty, lastName: last.nilIfEmpty, vatNumber: nil)
        }
        let company = companyName.trimmed
        let tax = withTaxId ? taxId.trimmed : ""
        return Payload(kind: "company", fullName: nameOnInvoices.trimmed.nilIfEmpty ?? company, companyName: company, firstName: nil, lastName: nil, vatNumber: tax.nilIfEmpty)
    }
}

/// Which workspace-hub topics touch which screens (the Expo app's sync map), for `.realtimeRefresh(env, topics:)`.
enum BooksTopics {
    static let invoices = ["invoice", "payment", "accounting_entity"]
    static let bills = ["bill", "payment", "accounting_document", "accounting_entity"]
    static let dashboard = [
        "invoice", "bill", "payment", "accounting_document", "bank_account", "bank_transaction",
        "journal_entry", "vat_return", "account", "accounting_entity",
    ]
    static let banking = ["bank_account", "bank_transaction", "accounting_entity"]
    static let contacts = ["accounting_contact", "accounting_entity"]
    static let vat = ["vat_return", "accounting_entity"]
    static let reports = ["invoice", "bill", "journal_entry", "account", "accounting_entity"]
}
