import Foundation

/// The weekdays, Monday first, as an RRULE's `BYDAY` names them.
enum Weekday: Int, CaseIterable, Comparable {
    case monday = 2, tuesday, wednesday, thursday, friday, saturday, sunday

    /// `Calendar`'s weekday number (1 = Sunday).
    var calendarWeekday: Int { self == .sunday ? 1 : rawValue }

    static func < (lhs: Weekday, rhs: Weekday) -> Bool { lhs.rawValue < rhs.rawValue }

    static func of(code: String) -> Weekday? {
        switch code.uppercased() {
        case "MO": return .monday
        case "TU": return .tuesday
        case "WE": return .wednesday
        case "TH": return .thursday
        case "FR": return .friday
        case "SA": return .saturday
        case "SU": return .sunday
        default: return nil
        }
    }
}

/// Repeating events, as iCalendar RRULEs (`RRULE:FREQ=WEEKLY;BYDAY=MO`).
///
/// The rule is stored on the event and goes to Google with it; the server
/// doesn't expand occurrences (nor does the web app), so the apps show the
/// rule and let the person set one of the common ones. A rule the app didn't
/// write is shown in words and kept as it is unless the person picks another.
enum RepeatPreset: String, CaseIterable, Identifiable {
    case never, daily, weekdays, weekly, monthly, yearly

    var id: String { rawValue }

    /// The rule this preset writes; empty for never (an update then stops the repeat).
    var rule: String {
        switch self {
        case .never: return ""
        case .daily: return "RRULE:FREQ=DAILY"
        case .weekdays: return "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
        case .weekly: return "RRULE:FREQ=WEEKLY"
        case .monthly: return "RRULE:FREQ=MONTHLY"
        case .yearly: return "RRULE:FREQ=YEARLY"
        }
    }

    static let workdays: [Weekday] = [.monday, .tuesday, .wednesday, .thursday, .friday]

    /// The preset a stored rule is, or nil for a rule none of them writes.
    static func of(_ rule: String?) -> RepeatPreset? {
        guard let parsed = RRule.parse(rule) else {
            return (rule ?? "").trimmingCharacters(in: .whitespaces).isEmpty ? RepeatPreset.never : nil
        }
        guard parsed.interval == 1, parsed.count == nil, parsed.until == nil else { return nil }
        switch parsed.frequency {
        case .daily: return parsed.days.isEmpty ? .daily : nil
        case .weekly:
            if parsed.days.isEmpty { return .weekly }
            return parsed.days == workdays ? .weekdays : nil
        case .monthly: return parsed.days.isEmpty ? .monthly : nil
        case .yearly: return parsed.days.isEmpty ? .yearly : nil
        }
    }
}

/// The parts of an RRULE the apps put into words.
struct RRule: Equatable {
    enum Frequency: Equatable { case daily, weekly, monthly, yearly }

    let frequency: Frequency
    let interval: Int
    /// `BYDAY`, in week order; an ordinal (`1MO`) is read as the day alone.
    let days: [Weekday]
    let count: Int?
    let until: Day?

    /// `RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20301231T000000Z`, with
    /// or without the prefix. Nil for no rule, or a frequency the apps don't
    /// name (hourly and finer).
    static func parse(_ text: String?) -> RRule? {
        guard let body = text?.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty else { return nil }
        let line: String
        if let ruleLine = body.components(separatedBy: .newlines)
            .map({ $0.trimmingCharacters(in: .whitespaces) })
            .first(where: { $0.uppercased().hasPrefix("RRULE:") }) {
            line = String(ruleLine.dropFirst(6))
        } else if !body.contains(":") {
            line = body
        } else {
            return nil
        }
        var parts: [String: String] = [:]
        for part in line.split(separator: ";") {
            let pieces = part.split(separator: "=", maxSplits: 1)
            if pieces.count == 2 {
                parts[pieces[0].trimmingCharacters(in: .whitespaces).uppercased()] = pieces[1].trimmingCharacters(in: .whitespaces)
            }
        }
        let frequency: Frequency
        switch parts["FREQ"]?.uppercased() {
        case "DAILY": frequency = .daily
        case "WEEKLY": frequency = .weekly
        case "MONTHLY": frequency = .monthly
        case "YEARLY": frequency = .yearly
        default: return nil
        }
        let interval = parts["INTERVAL"].flatMap(Int.init).flatMap { $0 > 0 ? $0 : nil } ?? 1
        var days: [Weekday] = []
        for code in (parts["BYDAY"] ?? "").split(separator: ",") {
            if let day = Weekday.of(code: String(code.suffix(2))), !days.contains(day) { days.append(day) }
        }
        let count = parts["COUNT"].flatMap(Int.init).flatMap { $0 > 0 ? $0 : nil }
        var until: Day?
        if let value = parts["UNTIL"], value.count >= 8 {
            let digits = String(value.prefix(8))
            if digits.allSatisfy(\.isNumber), let year = Int(digits.prefix(4)),
               let month = Int(digits.dropFirst(4).prefix(2)), let day = Int(digits.suffix(2)),
               (1...12).contains(month), (1...31).contains(day) {
                until = Day(year: year, month: month, day: day)
            }
        }
        return RRule(frequency: frequency, interval: interval, days: days.sorted(), count: count, until: until)
    }
}
