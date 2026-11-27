import SwiftUI
import WeldCore
import WeldUI

/// The workspace hub's topics for calendars and their events: what every screen reloads on.
let calendarTopics = ["calendar_event", "calendar", "calendar_share"]

extension Color {
    /// A `#RRGGBB` string as a colour; the brand colour for anything else.
    init(hex: String?) {
        let value = parseHex(hex) ?? parseHex(brandHex) ?? 0
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

// MARK: - Words for dates and values

enum CalendarText {
    /// "09:00", or "9:00 AM", as the phone shows times.
    static func time(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }

    /// "Wed 5 Aug".
    static func weekdayDate(_ day: Day, _ calendar: Calendar) -> String {
        day.start(calendar).formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }

    /// "5 Aug".
    static func shortDate(_ day: Day, _ calendar: Calendar) -> String {
        day.start(calendar).formatted(.dateTime.day().month(.abbreviated))
    }

    /// "November 2026".
    static func monthTitle(_ month: YearMonth, _ calendar: Calendar) -> String {
        month.firstDay.start(calendar).formatted(.dateTime.month(.wide).year())
    }

    /// "Today", "Tomorrow", "Yesterday", else "Wed 5 Aug" (with the year once it differs).
    static func dayHeading(_ day: Day, today: Day, _ calendar: Calendar) -> String {
        switch relativeDay(day, today: today, calendar) {
        case .today: return CoreStrings.commonToday
        case .tomorrow: return CoreStrings.commonTomorrow
        case .yesterday: return CoreStrings.commonYesterday
        case .thisYear: return weekdayDate(day, calendar)
        case .otherYear: return day.start(calendar).formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).year())
        }
    }

    /// "09:00 – 10:30", "09:00" without an end, the all-day label, and both dates when it spans days.
    static func timeRange(_ event: CalendarEvent, _ calendar: Calendar) -> String {
        let startDay = Day(event.start, calendar: calendar)
        let endDay = event.end.map { Day($0, calendar: calendar) }
        if event.allDay {
            if let endDay, endDay != startDay {
                return "\(CalendarStrings.agendaAllDay) · \(shortDate(startDay, calendar)) – \(shortDate(endDay, calendar))"
            }
            return CalendarStrings.agendaAllDay
        }
        guard let end = event.end, let endDay else { return time(event.start) }
        if endDay == startDay { return "\(time(event.start)) – \(time(end))" }
        return "\(shortDate(startDay, calendar)) \(time(event.start)) – \(shortDate(endDay, calendar)) \(time(end))"
    }

    /// "1h 30m", or nil when there is no measurable span.
    static func duration(_ event: CalendarEvent) -> String? {
        guard !event.allDay, let span = CalendarDates.duration(start: event.start, end: event.end) else { return nil }
        if span.hours == 0 { return CalendarStrings.eventDurationMinutes(minuteCount: span.minutes) }
        if span.minutes == 0 { return CalendarStrings.eventDurationHours(hourCount: span.hours) }
        return CalendarStrings.eventDurationHoursMinutes(hourCount: span.hours, minuteCount: span.minutes)
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

    static func permission(_ permission: CalendarPermission) -> String {
        switch permission {
        case .view: return CalendarStrings.permissionView
        case .edit: return CalendarStrings.permissionEdit
        case .manage: return CalendarStrings.permissionManage
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

func statusColor(_ status: EventStatus) -> Color {
    switch status {
    case .confirmed: return Tokens.Status.success
    case .tentative: return Tokens.Status.warning
    case .cancelled: return .secondary
    }
}

func responseColor(_ response: GuestResponse) -> Color {
    switch response {
    case .accepted: return Tokens.Status.success
    case .declined: return Tokens.Status.danger
    case .tentative: return Tokens.Status.warning
    case .pending: return .secondary
    }
}

// MARK: - Pieces

/// A small round colour sample.
struct ColorDot: View {
    let hex: String?
    var size: CGFloat = 12

    var body: some View {
        Circle().fill(Color(hex: hex)).frame(width: size, height: size).accessibilityHidden(true)
    }
}

/// A chip tinted with a colour: the event's type, or "Task".
struct TintChip: View {
    let text: String
    let hex: String

    var body: some View {
        let color = Color(hex: hex)
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(text).font(.caption.weight(.semibold)).foregroundStyle(color)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(color.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
    }
}

/// The event's status pill: none for a task block while it's confirmed, "Closed" once its task is done.
struct StatePill: View {
    let event: CalendarEvent

    var body: some View {
        if let status = event.status, !(event.isTask && status == .confirmed) {
            if event.isTask && status == .cancelled {
                StatusBadge(CalendarStrings.eventTaskClosed, color: .secondary)
            } else {
                StatusBadge(CalendarText.status(status), color: statusColor(status))
            }
        }
    }
}

/// `normal` carries no signal, so it shows nothing.
struct PriorityBadge: View {
    let priority: EventPriority?

    var body: some View {
        if let priority, priority != .normal {
            StatusBadge(
                CalendarText.priority(priority),
                color: priority == .urgent ? Tokens.Status.danger : priority == .high ? Tokens.Status.warning : .secondary
            )
        }
    }
}

/// The row every list uses: a time column, the type's colour as a rule, the
/// title, the calendar and the place, and what's special about it. A
/// cancelled event stays, struck through; a past one is dimmed.
struct EventRow: View {
    let event: CalendarEvent
    let calendarName: String?
    let now: Date

    var body: some View {
        let accent = Color(hex: eventColor(event.color, event.type))
        let cancelled = event.isCancelled
        let past = !cancelled && EventLists.isPast(event, now: now)
        let live = !cancelled && EventLists.isOngoing(event, now: now)
        HStack(alignment: .top, spacing: Tokens.Spacing.m) {
            VStack(alignment: .leading, spacing: 1) {
                if event.allDay {
                    Text(CalendarStrings.agendaAllDay).font(.caption.weight(.semibold)).foregroundStyle(.secondary).lineLimit(2)
                } else {
                    Text(CalendarText.time(event.start)).font(.subheadline.weight(.semibold)).lineLimit(1)
                    if let end = event.end {
                        Text(CalendarText.time(end)).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            .frame(width: 56, alignment: .leading)
            RoundedRectangle(cornerRadius: 2)
                .fill(accent)
                .frame(width: 3)
                .opacity(past ? 0.55 : 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.title)
                    .font(.body.weight(.semibold))
                    .strikethrough(cancelled)
                    .foregroundStyle(cancelled ? Color.secondary : Color.primary)
                    .lineLimit(2)
                    .opacity(past ? 0.55 : 1)
                let subtitle = [calendarName, event.location].compactMap { $0 }.joined(separator: " · ")
                if !subtitle.isEmpty {
                    HStack(spacing: 4) {
                        if event.location != nil { Image(systemName: "mappin").font(.caption2) }
                        Text(subtitle).lineLimit(1)
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
                meta(live: live, accent: accent)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel([event.title, event.allDay ? CalendarStrings.agendaAllDay : CalendarText.time(event.start), calendarName]
            .compactMap { $0 }
            .joined(separator: ", "))
        .accessibilityIdentifier("event-row")
    }

    @ViewBuilder private func meta(live: Bool, accent: Color) -> some View {
        let video = event.isVirtual || event.meetingURL != nil
        let repeats = event.recurrenceRule != nil
        if live || event.isTask || video || repeats || !event.guests.isEmpty {
            HStack(spacing: 10) {
                if live {
                    Text(CalendarStrings.agendaNow)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(accent, in: RoundedRectangle(cornerRadius: 8))
                }
                if event.isTask { Label(CalendarStrings.eventTask, systemImage: "checkmark.square") }
                if video { Image(systemName: "video") }
                if repeats { Image(systemName: "repeat") }
                if !event.guests.isEmpty {
                    Label(CalendarStrings.eventAttendeeCount(event.guests.count), systemImage: "person.2")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.top, 4)
        }
    }
}
