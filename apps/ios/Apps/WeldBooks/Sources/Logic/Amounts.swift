import Foundation

/// Amounts as typed and as the server sends them. Money is `Decimal`
/// everywhere in the app; nothing goes through `Double` except the few
/// numbers the server itself sends as JSON numbers.
enum Amounts {
    private static let posix = Locale(identifier: "en_US_POSIX")

    /// A server decimal (`"121.00"`, `"121"`, nil) as a number, 0 when it isn't one.
    static func of(_ text: String?) -> Decimal {
        guard let text = text?.trimmed, !text.isEmpty else { return 0 }
        return strictDecimal(text) ?? 0
    }

    /// A JSON number the server sent, 0 for nil or a non-finite value.
    static func of(_ value: Double?) -> Decimal {
        guard let value, value.isFinite else { return 0 }
        // The shortest text that reads back as the same double, as Java's `BigDecimal.valueOf`.
        return strictDecimal("\(value)") ?? Decimal(value)
    }

    /// What a person typed, in European (`1.234,56`) or US (`1,234.56`) style.
    /// A lone separator followed by three digits (`1,234`) is a thousands
    /// separator when `decimalPoint` (US English), else a decimal comma.
    static func parse(_ text: String, decimalPoint: Bool = false) -> Decimal {
        let cleaned = String(text.filter { $0.isASCII && ($0.isNumber || $0 == "." || $0 == "," || $0 == "-") })
        if cleaned.isEmpty { return 0 }
        if decimalPoint, cleaned.fullyMatches("-?\\d{1,3}(,\\d{3})+") {
            return strictDecimal(cleaned.replacingOccurrences(of: ",", with: "")) ?? 0
        }
        let comma = cleaned.lastIndex(of: ",")
        let point = cleaned.lastIndex(of: ".")
        let normal: String
        if let comma, point.map({ comma > $0 }) ?? true {
            // `1.234,56`: the points group thousands, the first comma is the decimal one.
            let withoutPoints = cleaned.replacingOccurrences(of: ".", with: "")
            if let first = withoutPoints.firstIndex(of: ",") {
                let head = String(withoutPoints[..<first])
                let tail = String(withoutPoints[withoutPoints.index(after: first)...]).replacingOccurrences(of: ",", with: "")
                normal = head + "." + tail
            } else {
                normal = withoutPoints
            }
        } else {
            normal = cleaned.replacingOccurrences(of: ",", with: "")
        }
        return strictDecimal(normal) ?? leadingNumber(normal)
    }

    /// `12.` or `-` while typing: the number so far.
    private static func leadingNumber(_ text: String) -> Decimal {
        guard let groups = text.firstMatchGroups("^-?\\d+(\\.\\d+)?"), let whole = groups.first else { return 0 }
        return strictDecimal(whole) ?? 0
    }

    /// The text as a number only when all of it is one (Java's `BigDecimal(String)`), never a prefix.
    private static func strictDecimal(_ text: String) -> Decimal? {
        guard text.fullyMatches("[+-]?(\\d+(\\.\\d*)?|\\.\\d+)([eE][+-]?\\d+)?"),
              let value = Decimal(string: text, locale: posix)
        else { return nil }
        return value.isNaN ? 0 : value
    }

    /// Rounded to `scale` decimals, half away from zero (Java's `HALF_UP`).
    static func round(_ amount: Decimal, scale: Int) -> Decimal {
        var value = amount
        var result = Decimal()
        NSDecimalRound(&result, &value, scale, .plain)
        return result
    }

    /// Rounded to cents.
    static func cents(_ amount: Decimal) -> Decimal { round(amount, scale: 2) }

    /// A whole number as an `Int` (after rounding it yourself).
    static func int(_ amount: Decimal) -> Int { NSDecimalNumber(decimal: amount).intValue }

    /// A number as the server takes it, without trailing zeros: `"2"`, `"12.5"`.
    static func plain(_ amount: Decimal) -> String {
        // `-0` can read as Foundation's NaN (a negative sign with no digits); either way it is 0.
        if amount.isZero || amount.isNaN { return "0" }
        // `stringValue` always writes a decimal point, never a comma or an exponent.
        var text = NSDecimalNumber(decimal: amount).stringValue
        if text.contains("."), !text.contains("e"), !text.contains("E") {
            while text.hasSuffix("0") { text.removeLast() }
            if text.hasSuffix(".") { text.removeLast() }
        }
        return text == "-0" ? "0" : text
    }

    /// A percentage for a label: `21`, `9.5`.
    static func percent(_ amount: Decimal) -> String { plain(round(amount, scale: 4)) }
}

/// A calendar day (`2026-11-27`) with no time and no time zone: accounting
/// dates are days, and the server writes them as ISO timestamps at midnight
/// UTC. Arithmetic is pure (no `Calendar`), so it never shifts a day.
struct Day: Hashable, Comparable, Sendable, CustomStringConvertible {
    let year: Int
    let month: Int
    let day: Int

    /// A real day of the Gregorian calendar, else nil (`2026-02-30` is nil).
    init?(year: Int, month: Int, day: Int) {
        guard (1...12).contains(month), day >= 1, day <= Day.length(ofMonth: month, year: year) else { return nil }
        self.year = year
        self.month = month
        self.day = day
    }

    private init(valid year: Int, _ month: Int, _ day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    /// `2026-11-27` (only the first ten characters are read by `Days.of`).
    init?(iso text: String) {
        guard let groups = text.firstMatchGroups("^(\\d{4})-(\\d{2})-(\\d{2})$"), groups.count == 4,
              let year = Int(groups[1]), let month = Int(groups[2]), let day = Int(groups[3])
        else { return nil }
        self.init(year: year, month: month, day: day)
    }

    /// The day `date` falls on, on the phone's clock (Gregorian, the phone's time zone).
    init(date: Date, timeZone: TimeZone = .current) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        self.init(valid: parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    /// `2026-11-27`, as the server takes a day.
    var iso: String { String(format: "%04ld-%02ld-%02ld", year, month, day) }

    var description: String { iso }

    /// Midnight of this day on the phone's clock: for a `DatePicker`.
    func date(timeZone: TimeZone = .current) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.date(from: DateComponents(year: year, month: month, day: day)) ?? Date(timeIntervalSince1970: TimeInterval(epochDay) * 86_400)
    }

    /// Days since 1970-01-01 (negative before).
    var epochDay: Int {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yearOfEra = y - era * 400
        let dayOfYear = (153 * (month > 2 ? month - 3 : month + 9) + 2) / 5 + day - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146_097 + dayOfEra - 719_468
    }

    init(epochDay: Int) {
        let z = epochDay + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let dayOfEra = z - era * 146_097
        let yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36524 - dayOfEra / 146_096) / 365
        let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let mp = (5 * dayOfYear + 2) / 153
        let day = dayOfYear - (153 * mp + 2) / 5 + 1
        let month = mp < 10 ? mp + 3 : mp - 9
        self.init(valid: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day)
    }

    func adding(days: Int) -> Day { Day(epochDay: epochDay + days) }

    static func < (lhs: Day, rhs: Day) -> Bool { lhs.epochDay < rhs.epochDay }

    static func isLeapYear(_ year: Int) -> Bool { (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 }

    static func length(ofMonth month: Int, year: Int) -> Int {
        switch month {
        case 2: return isLeapYear(year) ? 29 : 28
        case 4, 6, 9, 11: return 30
        default: return 31
        }
    }

    var lengthOfMonth: Int { Day.length(ofMonth: month, year: year) }
    var lengthOfYear: Int { Day.isLeapYear(year) ? 366 : 365 }
    var firstOfMonth: Day { Day(valid: year, month, 1) }
    var lastOfMonth: Day { Day(valid: year, month, lengthOfMonth) }
    var firstOfYear: Day { Day(valid: year, 1, 1) }
    var lastOfYear: Day { Day(valid: year, 12, 31) }
}

/// Accounting dates are calendar days (`2026-11-27`); the server writes them as ISO timestamps at midnight UTC.
enum Days {
    /// The calendar day of a server date or timestamp.
    static func of(_ text: String?) -> Day? {
        guard let value = text?.trimmed, value.count >= 10 else { return nil }
        return Day(iso: value.take(10))
    }

    static func today(timeZone: TimeZone = .current) -> Day { Day(date: Date(), timeZone: timeZone) }

    /// Whole days until `day`; negative once it has passed.
    static func until(_ day: Day?, today: Day = Days.today()) -> Int? {
        guard let day else { return nil }
        return day.epochDay - today.epochDay
    }

    /// Past due with something still open.
    static func isOverdue(_ dueDate: String?, balanceDue: Decimal, today: Day = Days.today()) -> Bool {
        if balanceDue <= 0 { return false }
        guard let days = until(of(dueDate), today: today) else { return false }
        return days < 0
    }

    static func monthRange(today: Day = Days.today()) -> (Day, Day) { (today.firstOfMonth, today.lastOfMonth) }

    static func yearRange(today: Day = Days.today()) -> (Day, Day) { (today.firstOfYear, today.lastOfYear) }
}
