import SwiftUI
import WeldCore
import WeldUI

/// The workspace hub's topics for calendars and their events: what every screen reloads on.
let calendarTopics = ["calendar_event", "calendar", "calendar_share"]

extension Color {
    /// A `#RRGGBB` string as a colour; the platform's default calendar blue for anything else.
    init(hex: String?) {
        let value = parseHex(hex) ?? parseHex(defaultCalendarHex) ?? 0
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }

    /// The platform's today blue, the same in light and dark.
    static let todayBlue = Color(hex: todayHex)
}

// MARK: - Words for dates and values

enum CalendarText {
    /// "09:00", or "9:00 AM", as the phone shows times.
    static func time(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }

    /// "Mon, Oct 5".
    static func weekdayDate(_ day: Day, _ calendar: Calendar) -> String {
        day.start(calendar).formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
    }

    /// "Saturday, November 28".
    static func longDate(_ day: Day, _ calendar: Calendar) -> String {
        day.start(calendar).formatted(.dateTime.weekday(.wide).month(.wide).day())
    }

    /// "November 2026".
    static func monthTitle(_ month: YearMonth, _ calendar: Calendar) -> String {
        month.firstDay.start(calendar).formatted(.dateTime.month(.wide).year())
    }

    /// A day as the platform's list groups name it: "Today · Saturday,
    /// November 28" for today, tomorrow and yesterday, else the date alone.
    static func dayLabel(_ day: Day, today: Day, _ calendar: Calendar) -> String {
        let date = longDate(day, calendar)
        switch relativeDay(day, today: today, calendar) {
        case .today: return "\(CalendarStrings.scheduleToday) · \(date)"
        case .tomorrow: return "\(CalendarStrings.scheduleTomorrow) · \(date)"
        case .yesterday: return "\(CalendarStrings.scheduleYesterday) · \(date)"
        case .thisYear, .otherYear: return date
        }
    }

    /// The schedule group's heading, as the platform's list writes it.
    static func scheduleGroup(_ group: ScheduleGroup, today: Day, _ calendar: Calendar) -> String {
        switch group {
        case .earlier: return CalendarStrings.scheduleEarlier
        case .yesterday: return dayLabel(today.adding(days: -1, calendar), today: today, calendar)
        case .today: return dayLabel(today, today: today, calendar)
        case .tomorrow: return dayLabel(today.adding(days: 1, calendar), today: today, calendar)
        case .thisWeek: return CalendarStrings.scheduleThisWeek
        case .nextWeek: return CalendarStrings.scheduleNextWeek
        case .thisMonth: return today.start(calendar).formatted(.dateTime.month(.wide)).capitalized(with: .current)
        case .later: return CalendarStrings.scheduleLater
        }
    }

    /// The list's date column: "Mon, Oct 5", or "Mon, Oct 5 – Thu, Oct 8" for an event over several days.
    static func scheduleDate(_ event: CalendarEvent, _ calendar: Calendar) -> String {
        let range = EventLists.dayRange(event, calendar)
        guard EventLists.spansDays(event), range.last != range.first else {
            return weekdayDate(Day(event.start, calendar: calendar), calendar)
        }
        return "\(weekdayDate(range.first, calendar)) – \(weekdayDate(range.last, calendar))"
    }

    /// The row's time: the all-day label, "10:00 – 10:30 AM" (the phone's compact
    /// range when both ends fall on one day), or only the start without a later end.
    static func scheduleTime(_ event: CalendarEvent, _ calendar: Calendar) -> String {
        if event.allDay { return CalendarStrings.agendaAllDay }
        guard let end = event.end, end > event.start else { return time(event.start) }
        if Day(event.start, calendar: calendar) == Day(end, calendar: calendar) {
            return timeRange.string(from: event.start, to: end)
        }
        return "\(time(event.start)) – \(time(end))"
    }

    private static let timeRange: DateIntervalFormatter = {
        let formatter = DateIntervalFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()

    /// The detail's "When", as the platform's `formatEventWhen`: the date (or
    /// dates) of an all-day event, else the date and the times, naming the
    /// end's day when it differs.
    static func when(_ event: CalendarEvent, _ calendar: Calendar) -> String {
        let startDay = Day(event.start, calendar: calendar)
        let end = event.end.flatMap { $0 > event.start ? $0 : nil }
        let endDay = end.map { Day($0, calendar: calendar) }
        if event.allDay {
            if let endDay, endDay > startDay { return "\(weekdayDate(startDay, calendar)) – \(weekdayDate(endDay, calendar))" }
            return longDate(startDay, calendar)
        }
        let day = weekdayDate(startDay, calendar)
        guard let end, let endDay else { return "\(day) · \(time(event.start))" }
        if endDay == startDay { return "\(day) · \(time(event.start)) – \(time(end))" }
        return "\(day) · \(time(event.start)) – \(weekdayDate(endDay, calendar)) · \(time(end))"
    }

    /// "Nov 28, 2026": the detail's "Created".
    static func created(_ date: Date) -> String {
        date.formatted(.dateTime.month(.abbreviated).day().year())
    }

    static func type(_ type: EventType) -> String {
        switch type {
        case .meeting: return CalendarStrings.eventTypeMeeting
        case .call: return CalendarStrings.eventTypeCall
        case .appointment: return CalendarStrings.eventTypeAppointment
        case .event: return CalendarStrings.eventTypeEvent
        case .reminder: return CalendarStrings.eventTypeReminder
        case .other: return CalendarStrings.eventTypeOther
        }
    }

    /// The event's type, "Task" for one WeldSuite placed from a task, as the platform's list names it.
    static func eventType(_ event: CalendarEvent) -> String {
        event.isTask ? CalendarStrings.eventTask : type(event.type)
    }

    static func status(_ status: EventStatus) -> String {
        switch status {
        case .confirmed: return CalendarStrings.statusConfirmed
        case .tentative: return CalendarStrings.statusTentative
        case .cancelled: return CalendarStrings.statusCancelled
        }
    }

    static func priority(_ priority: EventPriority) -> String {
        switch priority {
        case .low: return CalendarStrings.priorityLow
        case .normal: return CalendarStrings.priorityNormal
        case .high: return CalendarStrings.priorityHigh
        case .urgent: return CalendarStrings.priorityUrgent
        }
    }

    static func response(_ response: GuestResponse) -> String {
        switch response {
        case .accepted: return CalendarStrings.responseAccepted
        case .declined: return CalendarStrings.responseDeclined
        case .tentative: return CalendarStrings.responseTentative
        case .pending: return CalendarStrings.responsePending
        }
    }

    static func preset(_ preset: RepeatPreset) -> String {
        switch preset {
        case .never: return CalendarStrings.repeatNone
        case .daily: return CalendarStrings.repeatDaily
        case .weekdays: return CalendarStrings.repeatWeekdays
        case .weekly: return CalendarStrings.repeatWeekly
        case .monthly: return CalendarStrings.repeatMonthly
        case .yearly: return CalendarStrings.repeatYearly
        }
    }

    static func swatch(_ swatch: CalendarSwatch) -> String {
        switch swatch {
        case .blue: return CalendarStrings.calendarsColorNamesBlue
        case .red: return CalendarStrings.calendarsColorNamesRed
        case .green: return CalendarStrings.calendarsColorNamesGreen
        case .amber: return CalendarStrings.calendarsColorNamesAmber
        case .violet: return CalendarStrings.calendarsColorNamesViolet
        case .pink: return CalendarStrings.calendarsColorNamesPink
        case .cyan: return CalendarStrings.calendarsColorNamesCyan
        case .orange: return CalendarStrings.calendarsColorNamesOrange
        case .teal: return CalendarStrings.calendarsColorNamesTeal
        case .indigo: return CalendarStrings.calendarsColorNamesIndigo
        }
    }

    /// A rule in words: "Every 2 weeks on Mon, Wed, until 31 Dec 2030". Nil when it doesn't repeat.
    static func repeats(_ rule: String?, _ calendar: Calendar) -> String? {
        guard let rule, !rule.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        guard let parsed = RRule.parse(rule) else { return CalendarStrings.repeatCustom }
        if parsed.frequency == .weekly, parsed.interval == 1, parsed.days == RepeatPreset.workdays, parsed.count == nil, parsed.until == nil {
            return CalendarStrings.repeatWeekdays
        }
        let every: String
        switch parsed.frequency {
        case .daily: every = CalendarStrings.repeatEveryDays(parsed.interval)
        case .weekly: every = CalendarStrings.repeatEveryWeeks(parsed.interval)
        case .monthly: every = CalendarStrings.repeatEveryMonths(parsed.interval)
        case .yearly: every = CalendarStrings.repeatEveryYears(parsed.interval)
        }
        var text = every
        if !parsed.days.isEmpty {
            let symbols = calendar.shortWeekdaySymbols
            let names = parsed.days.map { day in symbols.indices.contains(day.calendarWeekday - 1) ? symbols[day.calendarWeekday - 1] : "" }
            text = CalendarStrings.repeatOnDays(rule: every, days: names.joined(separator: ", "))
        }
        if let until = parsed.until {
            let date = until.start(calendar).formatted(.dateTime.day().month(.abbreviated).year())
            return CalendarStrings.repeatUntil(rule: text, date: date)
        }
        if let count = parsed.count {
            return CalendarStrings.repeatWithLimit(rule: text, limit: CalendarStrings.repeatTimes(count))
        }
        return text
    }

    /// A failed action's message: what failed, then why.
    static func failure(_ what: String, _ error: Error) -> String {
        "\(what)\n\(apiErrorMessage(APIError.from(error)))"
    }
}

func responseColor(_ response: GuestResponse) -> Color {
    switch response {
    case .accepted: return Tokens.Status.success
    case .declined: return Tokens.Status.danger
    case .tentative: return Tokens.Status.warning
    case .pending: return Tokens.Palette.mutedForeground
    }
}

// MARK: - Pieces

/// A small round colour sample, as the platform puts next to a calendar's name.
struct ColorDot: View {
    let hex: String?
    var size: CGFloat = 10

    var body: some View {
        Circle().fill(Color(hex: hex)).frame(width: size, height: size).accessibilityHidden(true)
    }
}

/// The event's dot in a list: solid in its colour, a dashed ring for a tentative event (`statusDotStyle`).
struct EventDot: View {
    let color: Color
    let tentative: Bool

    var body: some View {
        Group {
            if tentative {
                Circle().strokeBorder(color, style: StrokeStyle(lineWidth: 1.5, dash: [2, 1.5]))
            } else {
                Circle().fill(color)
            }
        }
        .frame(width: 8, height: 8)
        .accessibilityHidden(true)
    }
}

/// A group's heading in a list, as the platform's lists draw it: a small
/// muted label and a count on a light band, with a hairline under it. Put it
/// in a section header with `.listRowInsets(EdgeInsets())`.
struct GroupHeader: View {
    let label: String
    let count: Int?

    @Environment(\.displayScale) private var displayScale

    var body: some View {
        HStack(spacing: Tokens.Spacing.s) {
            Text(label)
                .font(.inter(.caption, weight: .medium))
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .lineLimit(1)
            if let count { CountPill(count: count) }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Tokens.Spacing.m)
        .frame(maxWidth: .infinity, minHeight: 32)
        .background(Tokens.Palette.muted.opacity(0.5))
        .background(Tokens.Palette.background)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Tokens.Palette.border.opacity(0.7)).frame(height: 1 / displayScale)
        }
        .textCase(nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// The count next to a group's label: small mono digits on the muted fill, with a border.
struct CountPill: View {
    let count: Int

    var body: some View {
        Text("\(count)")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(Tokens.Palette.mutedForeground)
            .padding(.horizontal, 4)
            .frame(minWidth: 16, minHeight: 16)
            .background(Tokens.Palette.muted, in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Tokens.Palette.border, lineWidth: 1))
    }
}

/// One row of the schedule list, stacked for a phone: the event's dot and its
/// title (with the status when it isn't confirmed), then a muted line with the
/// date and the time, then the type and the place. The date is left out when
/// the group's heading already names the day (`showDate` false), except for an
/// event over several days. A cancelled event is faded and struck through.
struct EventRow: View {
    let event: CalendarEvent
    let color: Color
    let showDate: Bool

    private var calendar: Calendar { CalendarDates.calendar() }

    var body: some View {
        let cancelled = event.status == .cancelled
        let statusText: String? = {
            guard let status = event.status, status != .confirmed else { return nil }
            return CalendarText.status(status)
        }()
        let range = EventLists.dayRange(event, calendar)
        let multiDay = EventLists.spansDays(event) && range.first != range.last
        let date: String? = showDate || multiDay ? CalendarText.scheduleDate(event, calendar) : nil
        let whenLine = [date, CalendarText.scheduleTime(event, calendar)].compactMap { $0 }.joined(separator: " · ")
        let subtitle = [CalendarText.eventType(event), event.location].compactMap { $0 }.joined(separator: " · ")
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Spacing.m) {
            EventDot(color: color, tentative: event.status == .tentative)
                // Centred on the title's first line: the dot's bottom sits just above the baseline.
                .alignmentGuide(.firstTextBaseline) { dimensions in dimensions[.bottom] + 1 }
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: Tokens.Spacing.s) {
                    Text(event.title)
                        .font(.inter(.subheadline, weight: .medium))
                        .foregroundStyle(Tokens.Palette.foreground)
                        .strikethrough(cancelled)
                        .lineLimit(2)
                    if let statusText {
                        Text(statusText)
                            .font(.inter(.caption))
                            .foregroundStyle(Tokens.Palette.mutedForeground)
                            .lineLimit(1)
                            .layoutPriority(1)
                    }
                }
                Text(whenLine)
                    .font(.inter(.caption))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.inter(.caption))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, Tokens.Spacing.m)
        .opacity(cancelled ? 0.6 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("event-row")
    }
}

extension View {
    /// A list row as the platform's lists draw it: the row's own padding, a full-width hairline in the border colour.
    func platformRow() -> some View {
        listRowInsets(EdgeInsets(top: 0, leading: Tokens.Spacing.m, bottom: 0, trailing: Tokens.Spacing.l))
            .listRowSeparatorTint(Tokens.Palette.border)
            .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
    }
}

/// What an empty list shows, as on the platform: the icon in a muted rounded
/// square, a semibold title and a muted description.
struct CalendarEmptyState: View {
    let systemImage: String
    let title: String
    let description: String?

    var body: some View {
        VStack(spacing: Tokens.Spacing.s) {
            Image(systemName: systemImage)
                .font(.system(size: 22))
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .frame(width: 48, height: 48)
                .background(Tokens.Palette.muted, in: RoundedRectangle(cornerRadius: Tokens.Radius.large))
                .padding(.bottom, Tokens.Spacing.xs)
            Text(title)
                .font(.inter(.subheadline, weight: .semibold))
                .multilineTextAlignment(.center)
            if let description {
                Text(description)
                    .font(.inter(.footnote))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Tokens.Spacing.xl)
        .padding(.vertical, 48)
    }
}

/// A badge on the muted fill, as the platform shows a priority or a status in the event's details.
struct MutedBadge: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.inter(.caption, weight: .medium))
            .foregroundStyle(Tokens.Palette.foreground)
            .lineLimit(1)
            .padding(.horizontal, Tokens.Spacing.s)
            .padding(.vertical, 3)
            .background(Tokens.Palette.muted, in: RoundedRectangle(cornerRadius: 4))
    }
}

/// A badge tinted with a colour, as the platform shows an event's type: the colour at 12.5% under it.
struct TintBadge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.inter(.caption, weight: .medium))
            .foregroundStyle(color)
            .lineLimit(1)
            .padding(.horizontal, Tokens.Spacing.s)
            .padding(.vertical, 3)
            .background(color.opacity(0.125), in: RoundedRectangle(cornerRadius: 4))
    }
}

/// The palette the platform draws an attendee's initial on when there's no picture.
private let attendeePalette = [
    "#0D9488", "#16A34A", "#2563EB", "#7C3AED", "#DB2777",
    "#DC2626", "#EA580C", "#CA8A04", "#0891B2", "#4F46E5",
]

/// The calendar's attendee colour for `seed` (`attendeeFallbackColor`): a
/// 32-bit `hash * 31 + codePoint` over the UTF-16 units, as JavaScript does it.
func attendeeColor(_ seed: String) -> Color {
    let units = Array(seed.utf16)
    var hash: Int32 = 0
    for index in units.indices {
        let unit = units[index]
        var point = UInt32(unit)
        if UTF16.isLeadSurrogate(unit), index + 1 < units.count, UTF16.isTrailSurrogate(units[index + 1]) {
            point = 0x10000 + ((UInt32(unit) - 0xD800) << 10) + (UInt32(units[index + 1]) - 0xDC00)
        }
        hash = Int32(truncatingIfNeeded: Int64(hash) * 31 + Int64(point))
    }
    return Color(hex: attendeePalette[Int(abs(Int64(hash)) % Int64(attendeePalette.count))])
}

/// An attendee's initial on their colour, as the calendar's event panel draws it.
struct AttendeeAvatar: View {
    let email: String
    let name: String?
    var size: CGFloat = 24

    var body: some View {
        let seed = email.isEmpty ? (name?.isEmpty == false ? name! : "?") : email
        let source = name?.isEmpty == false ? name! : (email.isEmpty ? "?" : email)
        Text(String(source.prefix(1)).uppercased())
            .font(.inter(size: size * 0.45, weight: .medium))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(attendeeColor(seed), in: Circle())
            .accessibilityHidden(true)
    }
}

/// Lays its children out in rows, wrapping to the next row when one is full: the guests' chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(subviews, width: proposal.width ?? .infinity)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(subviews, width: bounds.width) {
            var x = bounds.minX
            for item in row.items {
                subviews[item.index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(item.size))
                x += item.size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var items: [(index: Int, size: CGSize)] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    /// Rows of children at their own width, none wider than the row: a long one is cut off with an ellipsis.
    private func arrange(_ subviews: Subviews, width: CGFloat) -> [Row] {
        let limit = ProposedViewSize(width: width.isFinite ? width : nil, height: nil)
        var rows: [Row] = []
        var current = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(limit)
            if !current.items.isEmpty, current.width + spacing + size.width > width {
                rows.append(current)
                current = Row()
            }
            current.width = current.items.isEmpty ? size.width : current.width + spacing + size.width
            current.height = max(current.height, size.height)
            current.items.append((index, size))
        }
        if !current.items.isEmpty { rows.append(current) }
        return rows
    }
}
