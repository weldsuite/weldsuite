import Foundation
import Observation
import WeldCore

// How a screen gets what it needs (Android: `LocalBooks`, `LocalNotify`, `LocalErrors`):
//
//     @Environment(Books.self) private var books              // store, company, labels, formatting
//     @Environment(BooksNavigator.self) private var navigator // open / back / replace (Navigation.swift)
//     @Environment(Toaster.self) private var toaster          // toaster.show("Saved")
//
// - The store: `books.store` (every API call, `async throws`), the companies
//   `books.entities` (`active`, `canSwitch`, `openSwitcher()`, `load()`), the
//   offline queue `books.queue` (`items`, `isOnline`, `isSyncing`, `sync()`).
// - The open company: `books.entity`, `books.code`, `books.jurisdiction`,
//   `books.features` (`.vatReturn`, …), `books.terminology`, `books.isUs`,
//   `books.isBr`, `books.currency`, `books.locale`, `books.decimalPoint`
//   (pass it to `Amounts.parse` and `LineItems.*`), `books.workspaceId`.
// - Words that differ per country: `books.labels.tax`, `.taxPercent`,
//   `.taxId`, `.registrationId`, `.supplier`, `.suppliers`, `.creditNote`,
//   `.taxRate("21")`, and the lower-case `supplierLower` / `suppliersLower` /
//   `creditNoteLower` for the middle of a sentence.
// - Formatting in the company's locale: `books.money(amount, currency: nil)`,
//   `books.compactMoney(amount)` (KPI tiles), `books.date("2026-11-27…")`
//   ("27 Nov 2026" / "11/27/2026"), `books.shortDate(text)`, `books.day(Day)`.
// - An error in words: `ErrorTexts.describe(error, fallback: BooksStrings.commonActionFailed)`;
//   for `LoadErrorView` use `apiError(error)`.
// - Realtime: `.realtimeRefresh(books.env, topics: BooksTopics.invoices) { await reload() }`.

/// The words that differ per country, in the app's language.
struct Labels {
    let tax: String
    let taxPercent: String
    let taxId: String
    let taxIdPlaceholder: String
    let registrationId: String
    let supplier: String
    let suppliers: String
    let creditNote: String
    /// `{rate}% VAT`.
    let taxRate: (String) -> String

    /// `{supplier}` and friends in the middle of a sentence.
    var supplierLower: String { supplier.lowercased() }
    var suppliersLower: String { suppliers.lowercased() }
    var creditNoteLower: String { creditNote.lowercased() }
}

/// The country's words, translated.
func terminologyLabels(_ terminology: Terminology) -> Labels {
    let tax: String
    let taxPercent: String
    let taxRate: (String) -> String
    switch terminology.tax {
    case "gst":
        tax = BooksStrings.terminologyTaxGst
        taxPercent = BooksStrings.terminologyTaxPercentGst
        taxRate = { BooksStrings.terminologyTaxRateGst(rate: $0) }
    case "sales_tax":
        tax = BooksStrings.terminologyTaxSalesTax
        taxPercent = BooksStrings.terminologyTaxPercentSalesTax
        taxRate = { BooksStrings.terminologyTaxRateSalesTax(rate: $0) }
    case "tributos":
        tax = BooksStrings.terminologyTaxTributos
        taxPercent = BooksStrings.terminologyTaxPercentTributos
        taxRate = { BooksStrings.terminologyTaxRateTributos(rate: $0) }
    default:
        tax = BooksStrings.terminologyTaxVat
        taxPercent = BooksStrings.terminologyTaxPercentVat
        taxRate = { BooksStrings.terminologyTaxRateVat(rate: $0) }
    }
    let taxId: String
    let taxIdPlaceholder: String
    switch terminology.taxId {
    case "gstin":
        taxId = BooksStrings.terminologyTaxIdGstin
        taxIdPlaceholder = BooksStrings.terminologyTaxIdPlaceholderGstin
    case "ein":
        taxId = BooksStrings.terminologyTaxIdEin
        taxIdPlaceholder = BooksStrings.terminologyTaxIdPlaceholderEin
    case "cnpj":
        taxId = BooksStrings.terminologyTaxIdCnpj
        taxIdPlaceholder = BooksStrings.terminologyTaxIdPlaceholderCnpj
    default:
        taxId = BooksStrings.terminologyTaxIdVatNumber
        taxIdPlaceholder = BooksStrings.terminologyTaxIdPlaceholderVatNumber
    }
    let registration: String
    switch terminology.registrationId {
    case "kvk": registration = BooksStrings.terminologyRegistrationIdKvk
    case "pan": registration = BooksStrings.terminologyRegistrationIdPan
    case "state_id": registration = BooksStrings.terminologyRegistrationIdStateId
    case "ie": registration = BooksStrings.terminologyRegistrationIdIe
    default: registration = BooksStrings.terminologyRegistrationIdCompanyNumber
    }
    let vendor = terminology.supplier == "vendor"
    let creditMemo = terminology.creditNote == "credit_memo"
    return Labels(
        tax: tax,
        taxPercent: taxPercent,
        taxId: taxId,
        taxIdPlaceholder: taxIdPlaceholder,
        registrationId: registration,
        supplier: vendor ? BooksStrings.terminologySupplierVendor : BooksStrings.terminologySupplierSupplier,
        suppliers: vendor ? BooksStrings.terminologySuppliersVendor : BooksStrings.terminologySuppliersSupplier,
        creditNote: creditMemo ? BooksStrings.terminologyCreditNoteCreditMemo : BooksStrings.terminologyCreditNoteCreditNote,
        taxRate: taxRate
    )
}

/// What every screen needs to know about the open company. One per app,
/// created in `WeldBooksApp` and put in the environment: `@Environment(Books.self)`.
@MainActor
@Observable
final class Books {
    let env: AppEnvironment
    /// Every API call (Android: `books.repository`).
    let store: BooksStore
    /// The workspace's companies and the open one.
    let entities: EntityState
    /// Expenses and receipts captured offline.
    let queue: OfflineQueue
    /// The workspace the app is in (set by `ContentView`).
    var workspaceId: String = ""
    /// Who is signed in (set by `ContentView`, which starts over for someone else).
    var personId: String = ""

    init(env: AppEnvironment) {
        self.env = env
        let store = BooksStore(env: env)
        self.store = store
        entities = EntityState(store: store)
        queue = OfflineQueue(env: env)
    }

    /// The open company.
    var entity: Entity? { entities.active }
    var jurisdictions: [Jurisdiction]? { entities.jurisdictions }
    var code: String? { entity?.jurisdictionCode.uppercased() }
    var jurisdiction: Jurisdiction? { Jurisdictions.find(code, jurisdictions) }
    var features: Features { jurisdiction?.features ?? Features() }
    var terminology: Terminology { jurisdiction?.terminology ?? Terminology() }
    var labels: Labels { terminologyLabels(terminology) }
    var isUs: Bool { Jurisdictions.isUs(code) }
    var isBr: Bool { Jurisdictions.isBr(code) }
    var currency: String { entity?.baseCurrency ?? jurisdiction?.defaultCurrency ?? Jurisdictions.fallbackCurrency }
    var locale: Locale { Jurisdictions.formatLocale(entity?.locale ?? jurisdiction?.defaultLocale) }

    /// US English types `1,234.56`; everyone else may type a decimal comma.
    var decimalPoint: Bool { locale.language.languageCode?.identifier == "en" && locale.region?.identifier == "US" }

    func money(_ amount: Decimal, currency: String? = nil) -> String {
        formatMoney(amount, currency: currency ?? self.currency, locale: locale)
    }

    /// For KPI tiles: `€12.3K` above a thousand, exact below.
    func compactMoney(_ amount: Decimal, currency: String? = nil) -> String {
        formatCompact(amount, currency: currency ?? self.currency, locale: locale)
    }

    /// `27 Nov 2026`, or `11/27/2026` for a US company; `—` for no date.
    func date(_ text: String?) -> String {
        guard let day = Days.of(text) else { return BooksStrings.commonDash }
        return formatDay(day, locale: locale)
    }

    /// `27 Nov`, or `11/27`.
    func shortDate(_ text: String?) -> String {
        guard let day = Days.of(text) else { return BooksStrings.commonDash }
        return formatShortDay(day, locale: locale)
    }

    /// A day in the company's format.
    func day(_ day: Day) -> String { formatDay(day, locale: locale) }
}

// MARK: - Formatting

/// Formatters are slow to make; these are made once per locale and pattern.
private final class FormatterCache: @unchecked Sendable {
    static let shared = FormatterCache()
    private let lock = NSLock()
    private var dates: [String: DateFormatter] = [:]
    private var numbers: [String: NumberFormatter] = [:]

    func date(_ key: String, make: () -> DateFormatter) -> DateFormatter {
        lock.lock()
        defer { lock.unlock() }
        if let cached = dates[key] { return cached }
        let made = make()
        dates[key] = made
        return made
    }

    func number(_ key: String, make: () -> NumberFormatter) -> NumberFormatter {
        lock.lock()
        defer { lock.unlock() }
        if let cached = numbers[key] { return cached }
        let made = make()
        numbers[key] = made
        return made
    }
}

private let utc = TimeZone(identifier: "UTC") ?? .current

private func isUsLocale(_ locale: Locale) -> Bool { locale.region?.identifier == "US" }

private func dayFormatter(_ locale: Locale, pattern: String?) -> DateFormatter {
    FormatterCache.shared.date("\(locale.identifier)|\(pattern ?? "medium")") {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = utc
        formatter.locale = locale
        if let pattern {
            formatter.dateFormat = pattern
        } else {
            formatter.dateStyle = .medium
            formatter.timeStyle = .none
        }
        return formatter
    }
}

/// `27 nov 2026` in the locale's medium style, or `11/27/2026` for the US. A day never shifts with the time zone.
func formatDay(_ day: Day, locale: Locale) -> String {
    dayFormatter(locale, pattern: isUsLocale(locale) ? "MM/dd/yyyy" : nil).string(from: day.date(timeZone: utc))
}

/// `27 Nov`, or `11/27` for the US.
func formatShortDay(_ day: Day, locale: Locale) -> String {
    dayFormatter(locale, pattern: isUsLocale(locale) ? "MM/dd" : "d MMM").string(from: day.date(timeZone: utc))
}

private let knownCurrencies: Set<String> = Set(Locale.Currency.isoCurrencies.map(\.identifier))

private func knownCurrency(_ currency: String?) -> (code: String?, known: Bool) {
    guard let code = currency?.trimmed.uppercased(), !code.isEmpty else { return (nil, false) }
    return (code, knownCurrencies.contains(code))
}

/// `€ 1.250,50` in `locale`. Without a known currency, the number with two decimals (after the code, if any).
func formatMoney(_ amount: Decimal, currency: String?, locale: Locale) -> String {
    let (code, known) = knownCurrency(currency)
    let formatter = FormatterCache.shared.number("money|\(locale.identifier)|\(known ? (code ?? "") : "")") {
        let formatter = NumberFormatter()
        formatter.locale = locale
        if known, let code {
            formatter.numberStyle = .currency
            formatter.currencyCode = code
        } else {
            formatter.numberStyle = .decimal
            formatter.minimumFractionDigits = 2
            formatter.maximumFractionDigits = 2
        }
        return formatter
    }
    let text = formatter.string(from: NSDecimalNumber(decimal: amount)) ?? Amounts.plain(amount)
    if !known, let code { return "\(code) \(text)" }
    return text
}

/// For KPI tiles: `€12.3K` from a thousand up, exact below (and for an unknown currency).
func formatCompact(_ amount: Decimal, currency: String?, locale: Locale) -> String {
    let magnitude = amount.magnitude
    let (code, known) = knownCurrency(currency)
    guard magnitude >= 1000, known, let code else { return formatMoney(amount, currency: currency, locale: locale) }
    let scaled: Decimal
    let suffix: String
    if magnitude >= 1_000_000_000 {
        scaled = amount / 1_000_000_000
        suffix = "B"
    } else if magnitude >= 1_000_000 {
        scaled = amount / 1_000_000
        suffix = "M"
    } else {
        scaled = amount / 1000
        suffix = "K"
    }
    let formatter = FormatterCache.shared.number("compact|\(locale.identifier)|\(code)") {
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .currency
        formatter.currencyCode = code
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = 1
        return formatter
    }
    let text = formatter.string(from: NSDecimalNumber(decimal: Amounts.round(scaled, scale: 1))) ?? Amounts.plain(scaled)
    // `€ 12,3` → `€ 12,3K`; `12,3 €` → `12,3K €`.
    guard let lastDigit = text.lastIndex(where: { $0.isNumber }) else { return text }
    let next = text.index(after: lastDigit)
    return String(text[..<next]) + suffix + String(text[next...])
}

// MARK: - Errors

/// Turns a failed call into words the person can act on (Android `ErrorTexts.describe`).
enum ErrorTexts {
    private static func known(_ code: String) -> String? {
        switch code {
        case "ADDRESS_REQUIRED": return BooksStrings.salesTaxErrorsAddressRequired
        case "TAX_ENGINE_UNAVAILABLE": return BooksStrings.salesTaxErrorsEngineUnavailable
        case "TAX_RATES_NOT_CONFIGURED": return BooksStrings.salesTaxErrorsRatesNotConfigured
        case "USE_TAX_ENGINE_UNSUPPORTED": return BooksStrings.salesTaxErrorsUseTaxUnsupported
        case "TAX_NOT_CALCULATED": return BooksStrings.salesTaxErrorsNotCalculated
        case "CREDIT_LINE_NOT_ON_ORIGINAL": return BooksStrings.salesTaxErrorsCreditLineNotOnOriginal
        case "TAX_COMMIT_NOT_APPLICABLE": return BooksStrings.salesTaxErrorsCommitNotApplicable
        default: return nil
        }
    }

    /// The server's explanation where it gave one the person can act on, else `fallback`.
    static func describe(_ error: Error?, fallback: String) -> String {
        guard let error else { return fallback }
        if let missing = error as? CompanyFieldsMissing { return missing.message ?? fallback }
        let failure: BooksError
        if let books = error as? BooksError {
            failure = books
        } else if let api = error as? APIError {
            failure = BooksError(api: api, message: nil)
        } else {
            return fallback
        }
        let api = failure.api
        if let code = api.code, let message = known(code) {
            return code == "TAX_ENGINE_UNAVAILABLE" && api.status == 503 ? BooksStrings.salesTaxErrorsEngineUnavailableRetry : message
        }
        if api.isNetwork { return BooksStrings.commonOfflineError }
        if api.status == 403 || api.status == 404 { return apiErrorMessage(api) }
        if let status = api.status, (400...499).contains(status), let message = failure.message, !message.hasPrefix("Request failed") {
            return message
        }
        return fallback
    }
}
