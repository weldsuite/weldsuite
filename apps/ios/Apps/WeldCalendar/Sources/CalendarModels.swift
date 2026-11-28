import Foundation

/// What kind of event it is: drives its colour and its chip.
enum EventType: String, CaseIterable, Identifiable {
    case meeting, call, appointment, event, reminder, other

    var id: String { rawValue }

    /// A value the form doesn't offer reads as `other`.
    static func of(_ wire: String?) -> EventType {
        wire.flatMap(EventType.init(rawValue:)) ?? .other
    }
}

enum EventStatus: String, CaseIterable, Identifiable {
    case confirmed, tentative, cancelled

    var id: String { rawValue }

    /// Nil for a value the app doesn't know: no pill rather than a wrong one.
    static func of(_ wire: String?) -> EventStatus? {
        wire.flatMap(EventStatus.init(rawValue:))
    }
}

enum EventPriority: String, CaseIterable, Identifiable {
    case low, normal, high, urgent

    var id: String { rawValue }

    static func of(_ wire: String?) -> EventPriority? {
        wire.flatMap(EventPriority.init(rawValue:))
    }
}

/// view = read events · edit = create and change them · manage = edit + share + delete.
enum CalendarPermission: String {
    case view, edit, manage

    /// An unknown level is the safest one.
    static func of(_ wire: String?) -> CalendarPermission {
        wire.flatMap(CalendarPermission.init(rawValue:)) ?? .view
    }
}

/// A guest's answer to an invitation.
enum GuestResponse: Equatable {
    case accepted, declined, tentative, pending

    /// `accepted`, `declined`, `tentative`; anything else (`pending`, Google's `needsAction`) is no answer yet.
    static func of(_ status: String?) -> GuestResponse {
        switch status?.trimmingCharacters(in: .whitespaces).lowercased() {
        case "accepted", "yes": return .accepted
        case "declined", "no": return .declined
        case "tentative", "maybe": return .tentative
        default: return .pending
        }
    }
}

/// A calendar as the screens use it, mapped from the API in `CalendarStore`.
struct CalendarInfo: Identifiable, Equatable, Hashable {
    let id: String
    let name: String
    let description: String?
    /// `#RRGGBB`, or nil for the brand colour.
    let color: String?
    let isDefault: Bool
    /// False for a calendar shared with the person.
    let isOwn: Bool
    let permission: CalendarPermission

    /// `view` is read-only; owners and `edit`/`manage` shares may write events.
    var canWrite: Bool { isOwn || permission == .edit || permission == .manage }
}

/// One guest of an event. `status` and `role` are kept as stored so an edit sends them back unchanged.
struct Guest: Equatable, Hashable, Identifiable {
    let email: String
    let name: String?
    let status: String?
    let role: String?

    var id: String { email.lowercased() }
    var response: GuestResponse { GuestResponse.of(status) }

    /// Name, else the address.
    var label: String {
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
        return email
    }
}

/// An event as the screens use it. Times are instants; the screens show them in the phone's zone.
struct CalendarEvent: Identifiable, Equatable {
    let id: String
    let calendarID: String
    let title: String
    let description: String?
    let type: EventType
    let start: Date
    /// Nil for an open-ended event.
    var end: Date?
    let allDay: Bool
    /// The IANA zone it was scheduled in, if the server knows it.
    let timezone: String?
    let location: String?
    let isVirtual: Bool
    let meetingURL: String?
    /// Nil for a status the app doesn't know.
    let status: EventStatus?
    let priority: EventPriority?
    let color: String?
    /// An RRULE, or nil when it doesn't repeat.
    let recurrenceRule: String?
    let guests: [Guest]
    /// `task` or `activity` when WeldSuite placed it.
    let sourceType: String?
    let autoScheduled: Bool
    let notes: String?

    var isTask: Bool { sourceType == "task" }
    var isCancelled: Bool { status == .cancelled }
}
