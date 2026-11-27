import Foundation

/// A day on the phone's calendar (no time, no zone): what the grid and the agenda's headings are made of.
struct Day: Hashable, Comparable, Identifiable {
    let year: Int
    let month: Int
    let day: Int

    var id: String { key }

    /// `2026-11-27`, as links and the new-event form take it.
    var key: String { String(format: "%04ld-%02ld-%02ld", year, month, day) }

    init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    /// The day `date` falls on in `calendar`'s zone.
    init(_ date: Date, calendar: Calendar) {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        self.init(year: parts.year ?? 1970, month: parts.month ?? 1, day: parts.day ?? 1)
    }

    static func < (lhs: Day, rhs: Day) -> Bool {
        (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
    }

    /// Midnight of this day in `calendar`'s zone.
    func start(_ calendar: Calendar) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day)) ?? Date(timeIntervalSince1970: 0)
    }

    func adding(days: Int, _ calendar: Calendar) -> Day {
        Day(calendar.date(byAdding: .day, value: days, to: start(calendar)) ?? start(calendar), calendar: calendar)
    }
}

/// A month of the grid.
struct YearMonth: Hashable {
    let year: Int
    let month: Int

    init(year: Int, month: Int) {
        self.year = year
        self.month = month
    }

    init(_ day: Day) {
        self.init(year: day.year, month: day.month)
    }

    var firstDay: Day { Day(year: year, month: month, day: 1) }

    func adding(months: Int) -> YearMonth {
        let index = year * 12 + (month - 1) + months
        return YearMonth(year: index / 12, month: index % 12 + 1)
    }
}

/// Dates as the calendar screens use them. Everything works in the phone's
/// own zone, as the web app does: it builds an all-day event from local
/// midnight and reads it back with local hours, so an event lands on the
/// same square on every surface as long as nobody reaches for UTC days.
enum CalendarDates {
    /// The agenda covers today and the next two weeks.
    static let agendaDays = 14

    /// The Gregorian calendar in `zone`, weeks starting on Monday as the platform grid's do.
    static func calendar(_ zone: TimeZone = .current) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        calendar.locale = .current
        calendar.firstWeekday = 2
        return calendar
    }

    static func startOf(_ day: Day, _ calendar: Calendar) -> Date { day.start(calendar) }

    /// 23:59:59.999 of `day`.
    static func endOf(_ day: Day, _ calendar: Calendar) -> Date {
        day.adding(days: 1, calendar).start(calendar).addingTimeInterval(-0.001)
    }

    /// From today's midnight to the end of the fourteenth day after it.
    static func agendaWindow(today: Day, _ calendar: Calendar) -> (start: Date, end: Date) {
        (startOf(today, calendar), endOf(today.adding(days: agendaDays, calendar), calendar))
    }

    /// Six Monday-first weeks covering `month`: always 42 days, so the grid keeps its height.
    static func monthMatrix(_ month: YearMonth, _ calendar: Calendar) -> [[Day]] {
        let first = month.firstDay.start(calendar)
        let weekday = calendar.component(.weekday, from: first) // 1 = Sunday
        let leading = (weekday - 2 + 7) % 7
        let gridStart = month.firstDay.adding(days: -leading, calendar)
        return (0..<6).map { week in (0..<7).map { day in gridStart.adding(days: week * 7 + day, calendar) } }
    }

    /// The whole grid (its first and last rows spill into the neighbouring months), with a day of slack on each side.
    static func monthWindow(_ month: YearMonth, _ calendar: Calendar) -> (start: Date, end: Date) {
        let weeks = monthMatrix(month, calendar)
        let first = weeks.first?.first ?? month.firstDay
        let last = weeks.last?.last ?? month.firstDay
        return (startOf(first.adding(days: -1, calendar), calendar), endOf(last.adding(days: 1, calendar), calendar))
    }

    /// "1h 30m" as hours and minutes; nil when there is no measurable span.
    static func duration(start: Date, end: Date?) -> (hours: Int, minutes: Int)? {
        guard let end else { return nil }
        let minutes = Int(end.timeIntervalSince(start) / 60)
        guard minutes > 0 else { return nil }
        return (minutes / 60, minutes % 60)
    }

    /// 09:00 on `day`, or the next whole hour when `day` is today and 09:00 has passed; no day means the next whole hour.
    static func startFor(day: Day?, now: Date, _ calendar: Calendar) -> Date {
        let hourStart = calendar.dateInterval(of: .hour, for: now)?.start ?? now
        let nextHour = calendar.date(byAdding: .hour, value: 1, to: hourStart) ?? now
        guard let day else { return nextHour }
        let nine = calendar.date(byAdding: .hour, value: 9, to: day.start(calendar)) ?? day.start(calendar)
        if day == Day(now, calendar: calendar), calendar.component(.hour, from: now) >= 9 { return nextHour }
        return nine
    }

    /// All day snaps the pair to the day's bounds; turning it off again restores 09:00–10:00.
    static func allDayRange(allDay: Bool, start: Date, end: Date, _ calendar: Calendar) -> (start: Date, end: Date) {
        let startDay = Day(start, calendar: calendar)
        if allDay {
            let endDay = end < start ? startDay : Day(end, calendar: calendar)
            return (startOf(startDay, calendar), endOf(endDay, calendar))
        }
        let nine = calendar.date(byAdding: .hour, value: 9, to: startOf(startDay, calendar)) ?? start
        return (nine, nine.addingTimeInterval(3600))
    }

    /// Moving the start carries the end along, keeping the duration.
    static func shiftStart(_ newStart: Date, start: Date, end: Date) -> (start: Date, end: Date) {
        let length = max(end.timeIntervalSince(start), 0)
        return (newStart, newStart.addingTimeInterval(length))
    }

    /// `2026-11-27` from a link or the month tab, or nil.
    static func parseDay(_ text: String?) -> Day? {
        guard let text = text?.trimmingCharacters(in: .whitespaces), text.count == 10 else { return nil }
        let parts = text.split(separator: "-")
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              (1...12).contains(month), (1...31).contains(day)
        else { return nil }
        let candidate = Day(year: year, month: month, day: day)
        // 31 February rolls over in Calendar: refuse what doesn't come back the same.
        let utc = calendar(TimeZone(identifier: "UTC") ?? .current)
        return Day(candidate.start(utc), calendar: utc) == candidate ? candidate : nil
    }
}

/// Today, tomorrow, yesterday, or a date: the agenda's headings.
enum RelativeDay: Equatable {
    case today, tomorrow, yesterday, thisYear, otherYear
}

func relativeDay(_ day: Day, today: Day, _ calendar: Calendar) -> RelativeDay {
    if day == today { return .today }
    if day == today.adding(days: 1, calendar) { return .tomorrow }
    if day == today.adding(days: -1, calendar) { return .yesterday }
    return day.year == today.year ? .thisYear : .otherYear
}

/// Events under one day's heading.
struct DaySection: Identifiable {
    let day: Day
    let events: [CalendarEvent]
    var id: String { day.key }
}

/// What a day square of the month grid shows: up to three colours and how many events in all.
struct DayDots: Equatable {
    let colors: [String]
    let total: Int
    var overflow: Int { total - colors.count }
}

/// The agenda's numbers.
struct AgendaCounts: Equatable {
    let today: Int
    let nextSevenDays: Int
}

/// Lists of events as the agenda and the month grid read them.
enum EventLists {
    static let maxDots = 3

    private static func byStart(_ a: CalendarEvent, _ b: CalendarEvent) -> Bool {
        a.start == b.start ? a.title < b.title : a.start < b.start
    }

    /// Day sections in order, each sorted by start. A multi-day event is listed under its start day only.
    static func groupByDay(_ events: [CalendarEvent], _ calendar: Calendar) -> [DaySection] {
        Dictionary(grouping: events) { Day($0.start, calendar: calendar) }
            .sorted { $0.key < $1.key }
            .map { DaySection(day: $0.key, events: $0.value.sorted(by: byStart)) }
    }

    static func on(_ day: Day, _ events: [CalendarEvent], _ calendar: Calendar) -> [CalendarEvent] {
        events.filter { Day($0.start, calendar: calendar) == day }.sorted(by: byStart)
    }

    static func dots(_ events: [CalendarEvent], _ calendar: Calendar) -> [Day: DayDots] {
        Dictionary(grouping: events.sorted(by: byStart)) { Day($0.start, calendar: calendar) }
            .mapValues { list in DayDots(colors: list.prefix(maxDots).map { eventColor($0.color, $0.type) }, total: list.count) }
    }

    static func counts(_ events: [CalendarEvent], today: Day, _ calendar: Calendar) -> AgendaCounts {
        let weekEnd = CalendarDates.endOf(today.adding(days: 6, calendar), calendar)
        return AgendaCounts(
            today: events.filter { Day($0.start, calendar: calendar) == today }.count,
            nextSevenDays: events.filter { $0.start <= weekEnd }.count
        )
    }

    /// Over: its end (or start, when open-ended) has passed.
    static func isPast(_ event: CalendarEvent, now: Date) -> Bool {
        (event.end ?? event.start) < now
    }

    /// Happening now. An open-ended event counts for an hour after its start, as the web grid draws it.
    static func isOngoing(_ event: CalendarEvent, now: Date) -> Bool {
        let end = event.end ?? event.start.addingTimeInterval(3600)
        return event.start <= now && now <= end
    }
}

/// Who may write where; the server checks the same, this keeps the app from offering a 403.
enum CalendarAccess {
    static func writable(_ calendars: [CalendarInfo]) -> [CalendarInfo] {
        calendars.filter(\.canWrite)
    }

    /// Access follows the calendar. An event whose calendar isn't listed (yet) is read-only.
    static func canEdit(_ event: CalendarEvent, _ calendars: [CalendarInfo]) -> Bool {
        calendars.first { $0.id == event.calendarID }?.canWrite == true
    }

    /// Own calendars (default first, as the server sends them), then the ones shared with the person.
    static func sections(_ calendars: [CalendarInfo]) -> (own: [CalendarInfo], shared: [CalendarInfo]) {
        (calendars.filter(\.isOwn), calendars.filter { !$0.isOwn })
    }
}

/// Which calendars the agenda and the grid ask for.
enum Visibility {
    /// A value no calendar has: every calendar hidden must not read as "no filter".
    static let none = "__none__"

    /// `calendarIds` for the range request: nil when nothing is hidden.
    static func calendarIDsParam(_ all: [CalendarInfo], hidden: Set<String>) -> String? {
        guard !hidden.isEmpty else { return nil }
        let visible = all.map(\.id).filter { !hidden.contains($0) }
        return visible.isEmpty ? none : visible.joined(separator: ",")
    }
}

/// The brand colour, for a calendar without one.
let brandHex = "#E5375E"

/// Type colours, the same as the web app's `EVENT_TYPE_COLORS`.
func typeColor(_ type: EventType) -> String {
    switch type {
    case .meeting: return "#3B82F6"
    case .call: return "#22C55E"
    case .appointment: return "#8B5CF6"
    case .event: return "#F59E0B"
    case .reminder: return "#EF4444"
    case .other: return "#6B7280"
    }
}

/// The colour of a task placed in the calendar.
let taskHex = "#6366F1"

/// The palette offered for a new calendar, as on the web.
let calendarColors = [
    "#FE466C", "#EF4444", "#F59E0B", "#EAB308", "#22C55E", "#10B981",
    "#06B6D4", "#3B82F6", "#6366F1", "#8B5CF6", "#EC4899", "#6B7280",
]

/// An event's own colour when it has a valid one, else its type's.
func eventColor(_ color: String?, _ type: EventType) -> String {
    if let color, parseHex(color) != nil { return color }
    return typeColor(type)
}

/// `#RGB` or `#RRGGBB` as 0xRRGGBB; nil for anything else.
func parseHex(_ text: String?) -> UInt32? {
    guard var value = text?.trimmingCharacters(in: .whitespaces) else { return nil }
    if value.hasPrefix("#") { value.removeFirst() }
    if value.count == 3 { value = value.map { "\($0)\($0)" }.joined() }
    guard value.count == 6, value.allSatisfy(\.isHexDigit) else { return nil }
    return UInt32(value, radix: 16)
}

/// Ids in links and pushes become path segments: only `[A-Za-z0-9_-]`.
func safeID(_ value: String?) -> String? {
    guard let value, !value.isEmpty,
          value.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "_" || $0 == "-" })
    else { return nil }
    return value
}

/// The event a tapped push opens: `eventId`, else `entityId` of a
/// `calendar_event`, else the `event` of its `actionUrl` (`/weldcalendar?event=evt_1`).
func eventIDFromPush(_ values: [String: String]) -> String? {
    if let explicit = values["eventId"], !explicit.isEmpty { return safeID(explicit) }
    if values["entityType"] == "calendar_event", let entity = values["entityId"], !entity.isEmpty { return safeID(entity) }
    guard let url = values["actionUrl"], let range = url.range(of: #"[?&]event=([^&#]+)"#, options: .regularExpression) else { return nil }
    let match = url[range]
    guard let equals = match.firstIndex(of: "=") else { return nil }
    return safeID(String(match[match.index(after: equals)...]))
}

/// Where a `weldcalendar://` link goes.
enum CalendarLink: Equatable {
    case event(String)
    case editEvent(String)
    case newEvent(Day?)
    case tab(AppTab)
}

/// The app's tabs.
enum AppTab: String, Hashable {
    case agenda, month, calendars, more
}

/// `weldcalendar://event/<id>`, `…/event/edit/<id>`, `…/event/new?date=2026-11-27`,
/// and the tabs (`agenda`, `month`, `calendars`, `more`, `settings`), the
/// paths the Expo app's router answered.
func parseCalendarLink(_ url: String?) -> CalendarLink? {
    guard let text = url?.trimmingCharacters(in: .whitespaces), text.hasPrefix("weldcalendar://") else { return nil }
    let rest = String(text.dropFirst("weldcalendar://".count))
    let beforeFragment = rest.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? rest
    let pieces = beforeFragment.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
    let path = pieces.first.map(String.init) ?? ""
    let query = pieces.count > 1 ? String(pieces[1]) : ""
    let segments = path.split(separator: "/").map(String.init)
    guard let first = segments.first else { return .tab(.agenda) }
    switch first {
    case "event":
        let second = segments.count > 1 ? segments[1] : nil
        if second == "new" { return .newEvent(CalendarDates.parseDay(queryValue(query, "date"))) }
        if second == "edit" { return safeID(segments.count > 2 ? segments[2] : nil).map(CalendarLink.editEvent) }
        return safeID(second).map(CalendarLink.event)
    case "agenda": return .tab(.agenda)
    case "month": return .tab(.month)
    case "calendars": return .tab(.calendars)
    case "more", "settings": return .tab(.more)
    default: return nil
    }
}

private func queryValue(_ query: String, _ name: String) -> String? {
    for pair in query.split(separator: "&") {
        let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
        if parts.first.map(String.init) == name { return parts.count > 1 ? String(parts[1]) : "" }
    }
    return nil
}

/// The zone to send with an event: the phone's when it's an IANA name
/// (`Europe/Amsterdam`, `UTC`). The server refuses one it doesn't know.
func ianaZone(_ id: String?) -> String? {
    guard let value = id?.trimmingCharacters(in: .whitespaces), !value.isEmpty, value.count <= 50 else { return nil }
    if value == "UTC" { return value }
    return value.range(of: #"^[A-Za-z]+(/[A-Za-z0-9_+\-]+)+$"#, options: .regularExpression) != nil ? value : nil
}

/// A plain check for an address someone typed: something@something.tld, no spaces.
func isValidEmail(_ text: String) -> Bool {
    text.trimmingCharacters(in: .whitespaces).range(of: #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#, options: .regularExpression) != nil
}

/// An http(s) link, as the server requires for a meeting link.
func isHTTPURL(_ text: String) -> Bool {
    let value = text.trimmingCharacters(in: .whitespaces).lowercased()
    guard value.hasPrefix("http://") || value.hasPrefix("https://") else { return false }
    let afterScheme = value.components(separatedBy: "://").dropFirst().first ?? ""
    return !(afterScheme.split(separator: "/", omittingEmptySubsequences: false).first ?? "").isEmpty
}

/// How many guests answered which way.
struct GuestAnswers: Equatable {
    let accepted: Int
    let declined: Int
    let tentative: Int
    let pending: Int
}

func guestAnswers(_ guests: [Guest]) -> GuestAnswers {
    GuestAnswers(
        accepted: guests.filter { $0.response == .accepted }.count,
        declined: guests.filter { $0.response == .declined }.count,
        tentative: guests.filter { $0.response == .tentative }.count,
        pending: guests.filter { $0.response == .pending }.count
    )
}
