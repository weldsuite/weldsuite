import Foundation

/// The most guests an event may have (every one is mailed).
let maxGuests = 100

/// The event form's values. Times are instants the pickers show in the phone's zone.
struct EventDraft: Equatable {
    var calendarID: String
    var title = ""
    var description = ""
    var type = EventType.meeting
    var start: Date
    var end: Date
    var allDay = false
    var location = ""
    var meetingURL = ""
    var status = EventStatus.confirmed
    var priority = EventPriority.normal
    /// The stored RRULE; empty when it doesn't repeat.
    var recurrenceRule = ""
    var guests: [Guest] = []
    /// Edit only: mail the guests about the change.
    var notifyGuests = false

    init(calendarID: String, start: Date, end: Date) {
        self.calendarID = calendarID
        self.start = start
        self.end = end
    }

    /// A new event: `start` for an hour, on the first calendar the person may write to.
    static func new(calendars: [CalendarInfo], start: Date) -> EventDraft {
        EventDraft(calendarID: calendars.first?.id ?? "", start: start, end: start.addingTimeInterval(3600))
    }

    /// The form for an existing event. An open-ended one gets an hour; the form always writes a pair.
    static func of(_ event: CalendarEvent) -> EventDraft {
        var draft = EventDraft(calendarID: event.calendarID, start: event.start, end: event.end ?? event.start.addingTimeInterval(3600))
        draft.title = event.title
        draft.description = event.description ?? ""
        draft.type = event.type
        draft.allDay = event.allDay
        draft.location = event.location ?? ""
        draft.meetingURL = event.meetingURL ?? ""
        draft.status = event.status ?? .confirmed
        draft.priority = event.priority ?? .normal
        draft.recurrenceRule = event.recurrenceRule ?? ""
        draft.guests = event.guests
        return draft
    }
}

/// What's wrong with a draft; nothing when it can be sent.
struct DraftProblems: Equatable {
    var titleMissing = false
    var endBeforeStart = false
    var badMeetingURL = false
    var noCalendar = false

    var isEmpty: Bool { !titleMissing && !endBeforeStart && !badMeetingURL && !noCalendar }
}

func problems(of draft: EventDraft) -> DraftProblems {
    DraftProblems(
        titleMissing: draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
        endBeforeStart: draft.end <= draft.start,
        badMeetingURL: !draft.meetingURL.trimmingCharacters(in: .whitespaces).isEmpty && !isHTTPURL(draft.meetingURL),
        noCalendar: draft.calendarID.isEmpty
    )
}

/// Why a typed guest can't be added.
enum GuestProblem: Equatable {
    case invalid, duplicate, limit
}

func guestProblem(_ email: String, guests: [Guest]) -> GuestProblem? {
    let address = email.trimmingCharacters(in: .whitespaces)
    if !isValidEmail(address) { return .invalid }
    if guests.contains(where: { $0.email.caseInsensitiveCompare(address) == .orderedSame }) { return .duplicate }
    if guests.count >= maxGuests { return .limit }
    return nil
}

/// The draft with a picked date or time applied, the end following a moved start.
enum DraftTimes {
    /// A new start (from the date or the time picker), the end carried along.
    static func start(_ draft: EventDraft, to newStart: Date) -> EventDraft {
        var next = draft
        let moved = CalendarDates.shiftStart(newStart, start: draft.start, end: draft.end)
        next.start = moved.start
        next.end = moved.end
        return next
    }

    static func end(_ draft: EventDraft, to newEnd: Date) -> EventDraft {
        var next = draft
        next.end = newEnd
        return next
    }

    static func allDay(_ draft: EventDraft, _ allDay: Bool, _ calendar: Calendar) -> EventDraft {
        var next = draft
        let range = CalendarDates.allDayRange(allDay: allDay, start: draft.start, end: draft.end, calendar)
        next.allDay = allDay
        next.start = range.start
        next.end = range.end
        return next
    }

    /// A time from a picker without its seconds, as the Expo form wrote it.
    static func wholeMinute(_ date: Date, _ calendar: Calendar) -> Date {
        calendar.dateInterval(of: .minute, for: date)?.start ?? date
    }
}
