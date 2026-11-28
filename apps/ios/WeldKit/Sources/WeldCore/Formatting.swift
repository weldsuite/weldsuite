import Foundation

/// Dates as the server sends them, and as the apps show them.
///
/// The server writes timestamps as ISO 8601 in UTC, with or without
/// milliseconds (`2026-11-27T09:30:00.000Z`), and calendar days as
/// `yyyy-MM-dd` (an invoice date, a leave day), which are days on the
/// phone's own calendar, never instants.
public enum WeldDate {
    /// A timestamp or a day. Nil for nil, empty or anything else.
    public static func parse(_ text: String?) -> Date? {
        guard let text = text?.trimmingCharacters(in: .whitespaces), !text.isEmpty else { return nil }
        if let date = fractional.date(from: text) ?? plain.date(from: text) { return date }
        if let date = spaced.date(from: text) { return date }
        return day(text)
    }

    /// `2026-11-27` as midnight of that day on the phone's calendar.
    public static func day(_ text: String?) -> Date? {
        guard let text, text.count >= 10 else { return nil }
        return dayFormatter.date(from: String(text.prefix(10)))
    }

    /// A date as the server takes a calendar day: `2026-11-27`.
    public static func dayString(_ date: Date) -> String {
        dayFormatter.string(from: date)
    }

    /// A timestamp as the server takes it: `2026-11-27T09:30:00.000Z`.
    public static func timestampString(_ date: Date) -> String {
        fractional.string(from: date)
    }

    /// "Today 09:30", "Yesterday 18:02", or the date and time.
    public static func relative(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDate(date, inSameDayAs: now) { return "\(CoreStrings.commonToday) \(time)" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "\(CoreStrings.commonYesterday) \(time)"
        }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    /// For a list row: the time today, the weekday this week, else the date.
    public static func short(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return date.formatted(date: .omitted, time: .shortened) }
        if let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day,
           days > 0, days < 7 {
            return date.formatted(.dateTime.weekday(.abbreviated))
        }
        if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            return date.formatted(.dateTime.day().month(.abbreviated))
        }
        return date.formatted(date: .numeric, time: .omitted)
    }

    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let spaced: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter
    }()

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}

/// Amounts of money. The server sends them as numbers or as decimal strings
/// (`"1250.50"`), with an ISO currency code next to them.
public enum Money {
    /// `"1250.50"`, `1250.5` → 1250.5 as a `Decimal`; nil for anything else.
    public static func parse(_ text: String?) -> Decimal? {
        guard let text = text?.trimmingCharacters(in: .whitespaces), !text.isEmpty else { return nil }
        return Decimal(string: text, locale: Locale(identifier: "en_US_POSIX"))
    }

    /// `€ 1.250,50` in the phone's locale. Without a currency, just the number with two decimals.
    public static func format(_ amount: Decimal, currency: String?) -> String {
        if let currency, !currency.isEmpty {
            return amount.formatted(.currency(code: currency.uppercased()))
        }
        return amount.formatted(.number.precision(.fractionLength(2)))
    }

    public static func format(_ amount: Double, currency: String?) -> String {
        format(Decimal(amount), currency: currency)
    }

    /// A decimal string as the server takes it: `1250.50`.
    public static func apiString(_ amount: Decimal) -> String {
        apiFormatter.string(from: NSDecimalNumber(decimal: amount)) ?? "\(amount)"
    }

    private static let apiFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = false
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        formatter.roundingMode = .halfUp
        return formatter
    }()
}

/// What a failed API call means to the person, in their language.
public func apiErrorMessage(_ error: APIError?) -> String {
    guard let error else { return CoreStrings.errorsGeneric }
    if error.isNetwork { return CoreStrings.errorsOffline }
    switch error.status {
    case 403: return CoreStrings.errorsForbidden
    case 404: return CoreStrings.errorsNotFound
    default: return CoreStrings.errorsGeneric
    }
}

/// A list as a screen shows it: what was last loaded, and how loading went.
/// A failed reload keeps the last data next to the error.
public struct LoadState<T> {
    public var data: T?
    public var loading: Bool
    public var error: APIError?

    public init(data: T? = nil, loading: Bool = false, error: APIError? = nil) {
        self.data = data
        self.loading = loading
        self.error = error
    }

    /// Nothing loaded yet and nothing failed: show a spinner.
    public var isFirstLoad: Bool { data == nil && error == nil }
}
