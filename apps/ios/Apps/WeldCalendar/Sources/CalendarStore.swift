import Foundation
import Observation
import WeldCalendarAPI
import WeldCore

/// Calendars and events of the active workspace. The generated API types are
/// mapped to the app's own models here and nowhere else, so a generator
/// rename stays in this file.
@MainActor
@Observable
final class CalendarStore {
    /// The calendars the person can see: their own (default first), then the ones shared with them.
    private(set) var calendars = LoadState<[CalendarInfo]>()

    /// Goes up after every change made here, so open lists reload.
    private(set) var changes = 0

    /// Calendars hidden from the agenda and the grid, kept on the phone. A
    /// hidden set rather than a shown one: a calendar shared later shows up
    /// without a hunt for its switch.
    private(set) var hidden: Set<String>

    @ObservationIgnored private let env: AppEnvironment
    @ObservationIgnored private var workspace: String?
    /// The workspace the default calendar was asked for in: once, so a failure doesn't loop.
    @ObservationIgnored private var ensuredFor: String?

    private static let hiddenKey = "weldcalendar.hiddenCalendars"

    init(env: AppEnvironment) {
        self.env = env
        hidden = Set(UserDefaults.standard.stringArray(forKey: Self.hiddenKey) ?? [])
    }

    private func client() throws -> Client {
        guard let api = env.api else { throw APIError(status: nil, code: nil) }
        return Client(serverURL: api.serverURL, transport: api.transport, middlewares: api.middlewares)
    }

    /// Forget another workspace's calendars the moment the workspace changes.
    func use(workspace id: String) {
        guard workspace != id else { return }
        workspace = id
        calendars = LoadState()
    }

    func refreshCalendars() async {
        let forWorkspace = workspace
        calendars.loading = true
        calendars.error = nil
        let result: Result<[CalendarInfo], APIError>
        do {
            result = .success(try await fetchCalendars())
        } catch {
            result = .failure(APIError.from(error))
        }
        guard workspace == forWorkspace else { return }
        switch result {
        case let .success(list): calendars = LoadState(data: list)
        case let .failure(error): calendars = LoadState(data: calendars.data, error: error)
        }
    }

    /// A member who never opened WeldCalendar on the web owns no calendar, so
    /// the form would have nowhere to write: provision the default one (once
    /// per workspace). False when that failed.
    func ensureDefaultIfNeeded() async -> Bool {
        guard let list = calendars.data, !list.contains(where: \.isOwn), ensuredFor != workspace else { return true }
        ensuredFor = workspace
        do {
            switch try await client().ensureDefaultCalendar() {
            case .ok, .created:
                await refreshCalendars()
                return true
            case .default:
                return false
            }
        } catch {
            return false
        }
    }

    func createCalendar(name: String, description: String, color: String) async throws {
        let trimmed = description.trimmingCharacters(in: .whitespacesAndNewlines)
        let input = Components.Schemas.CalendarInput(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            description: trimmed.isEmpty ? nil : trimmed,
            color: color
        )
        do {
            switch try await client().createCalendar(body: .json(input)) {
            case .created:
                await refreshCalendars()
                changes += 1
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    func toggleHidden(_ calendarID: String) {
        if hidden.contains(calendarID) { hidden.remove(calendarID) } else { hidden.insert(calendarID) }
        UserDefaults.standard.set(hidden.sorted(), forKey: Self.hiddenKey)
    }

    /// Events overlapping the window, earliest first.
    func events(start: Date, end: Date, calendarIDs: String?) async throws -> [CalendarEvent] {
        do {
            let output = try await client().listEventsInRange(query: .init(
                startDate: WeldDate.timestampString(start),
                endDate: WeldDate.timestampString(end),
                calendarIds: calendarIDs
            ))
            switch output {
            case let .ok(ok):
                return try ok.body.json.data.compactMap { Self.event($0) }.sorted { $0.start < $1.start }
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    func event(id: String) async throws -> CalendarEvent {
        do {
            switch try await client().getEvent(path: .init(eventId: id)) {
            case let .ok(ok):
                guard let event = Self.event(try ok.body.json.data) else { throw APIError(status: 0, code: nil) }
                return event
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    /// Add an event. Guests are mailed an invitation by the server.
    func create(_ draft: EventDraft, zone: TimeZone = .current) async throws {
        do {
            switch try await client().createEvent(body: .json(Self.createInput(draft, zone: zone))) {
            case .created:
                changes += 1
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    /// Change an event: the fields that differ from `original`, guests mailed when the draft says so.
    func update(_ original: CalendarEvent, with draft: EventDraft, zone: TimeZone = .current) async throws {
        do {
            let output = try await client().updateEvent(
                path: .init(eventId: original.id),
                query: .init(sendNotification: draft.notifyGuests ? true : nil),
                body: .json(Self.updateInput(original, draft, zone: zone))
            )
            switch output {
            case .ok:
                changes += 1
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    func delete(id: String, notifyGuests: Bool) async throws {
        do {
            let output = try await client().deleteEvent(
                path: .init(eventId: id),
                query: .init(sendNotification: notifyGuests ? true : nil)
            )
            switch output {
            case .noContent:
                changes += 1
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    /// Signed out or switched: nothing of this workspace stays in memory.
    func clear() {
        workspace = nil
        ensuredFor = nil
        calendars = LoadState()
    }

    private func fetchCalendars() async throws -> [CalendarInfo] {
        switch try await client().listCalendars() {
        case let .ok(ok):
            return try ok.body.json.data.map(Self.calendar)
        case let .default(status, response):
            throw APIError(status: status, code: try? response.body.json.error.code)
        }
    }

    // MARK: - Mapping

    nonisolated static func calendar(_ calendar: Components.Schemas.Calendar) -> CalendarInfo {
        let own = calendar.isOwn ?? false
        return CalendarInfo(
            id: calendar.id,
            name: calendar.name,
            description: nonBlank(calendar.description),
            color: parseHex(calendar.color) != nil ? calendar.color : nil,
            isDefault: calendar.isDefault == true,
            // Absent only outside the list; the list always says.
            isOwn: own,
            permission: own ? .manage : CalendarPermission.of(calendar.permission)
        )
    }

    /// Nil for a row whose start can't be read: one bad row mustn't empty the agenda.
    nonisolated static func event(_ event: Components.Schemas.CalendarEvent) -> CalendarEvent? {
        guard let start = WeldDate.parse(event.startTime) else { return nil }
        let guests: [Guest] = (event.attendees ?? []).compactMap { attendee in
            guard let email = nonBlank(attendee.email?.trimmingCharacters(in: .whitespaces)) else { return nil }
            return Guest(email: email, name: nonBlank(attendee.name), status: attendee.status, role: attendee.role)
        }
        return CalendarEvent(
            id: event.id,
            calendarID: event.calendarId,
            title: event.title,
            description: nonBlank(event.description),
            type: EventType.of(event._type),
            start: start,
            end: WeldDate.parse(event.endTime),
            allDay: event.allDay == true,
            timezone: nonBlank(event.timezone),
            location: nonBlank(event.location),
            isVirtual: event.isVirtual == true,
            meetingURL: nonBlank(event.meetingUrl),
            status: EventStatus.of(event.status),
            priority: EventPriority.of(event.priority),
            color: nonBlank(event.color),
            recurrenceRule: nonBlank(event.recurrenceRule),
            guests: guests,
            sourceType: event.sourceType,
            autoScheduled: event.autoScheduled == true,
            notes: nonBlank(event.notes),
            createdAt: WeldDate.parse(event.createdAt)
        )
    }

    private nonisolated static func nonBlank(_ text: String?) -> String? {
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return text
    }

    private nonisolated static func guestInput(_ guest: Guest) -> Components.Schemas.AttendeeInput {
        Components.Schemas.AttendeeInput(
            email: guest.email,
            name: nonBlank(guest.name),
            status: nonBlank(guest.status),
            role: nonBlank(guest.role)
        )
    }

    /// A new event: empty fields stay out; the phone's zone goes along when it's an IANA name.
    nonisolated static func createInput(_ draft: EventDraft, zone: TimeZone) -> Components.Schemas.EventInput {
        let meetingURL = draft.meetingURL.trimmingCharacters(in: .whitespaces)
        let description = draft.description.trimmingCharacters(in: .whitespacesAndNewlines)
        let location = draft.location.trimmingCharacters(in: .whitespacesAndNewlines)
        let rule = draft.recurrenceRule.trimmingCharacters(in: .whitespaces)
        return Components.Schemas.EventInput(
            calendarId: draft.calendarID,
            title: draft.title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description.isEmpty ? nil : description,
            _type: {
                switch draft.type {
                case .meeting: return .meeting
                case .call: return .call
                case .appointment: return .appointment
                case .event: return .event
                case .reminder: return .reminder
                case .other: return .other
                }
            }(),
            startTime: WeldDate.timestampString(draft.start),
            endTime: WeldDate.timestampString(draft.end),
            allDay: draft.allDay,
            timezone: ianaZone(zone.identifier),
            location: location.isEmpty ? nil : location,
            isVirtual: !meetingURL.isEmpty,
            meetingUrl: meetingURL.isEmpty ? nil : meetingURL,
            status: {
                switch draft.status {
                case .confirmed: return .confirmed
                case .tentative: return .tentative
                case .cancelled: return .cancelled
                }
            }(),
            priority: {
                switch draft.priority {
                case .low: return .low
                case .normal: return .normal
                case .high: return .high
                case .urgent: return .urgent
                }
            }(),
            recurrenceRule: rule.isEmpty ? nil : rule,
            attendees: draft.guests.isEmpty ? nil : draft.guests.map(guestInput)
        )
    }

    /// A change: the form's fields, an empty string clearing a text field.
    /// The calendar, the rule and the guests only when they changed, so an
    /// edit of the title doesn't rewrite the guest list.
    nonisolated static func updateInput(_ original: CalendarEvent, _ draft: EventDraft, zone: TimeZone) -> Components.Schemas.EventInput {
        let meetingURL = draft.meetingURL.trimmingCharacters(in: .whitespaces)
        let rule = draft.recurrenceRule.trimmingCharacters(in: .whitespaces)
        return Components.Schemas.EventInput(
            calendarId: draft.calendarID == original.calendarID ? nil : draft.calendarID,
            title: draft.title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: draft.description.trimmingCharacters(in: .whitespacesAndNewlines),
            _type: {
                switch draft.type {
                case .meeting: return .meeting
                case .call: return .call
                case .appointment: return .appointment
                case .event: return .event
                case .reminder: return .reminder
                case .other: return .other
                }
            }(),
            startTime: WeldDate.timestampString(draft.start),
            endTime: WeldDate.timestampString(draft.end),
            allDay: draft.allDay,
            timezone: ianaZone(zone.identifier),
            location: draft.location.trimmingCharacters(in: .whitespacesAndNewlines),
            isVirtual: !meetingURL.isEmpty,
            meetingUrl: meetingURL,
            status: {
                switch draft.status {
                case .confirmed: return .confirmed
                case .tentative: return .tentative
                case .cancelled: return .cancelled
                }
            }(),
            priority: {
                switch draft.priority {
                case .low: return .low
                case .normal: return .normal
                case .high: return .high
                case .urgent: return .urgent
                }
            }(),
            recurrenceRule: rule == (original.recurrenceRule ?? "") ? nil : rule,
            attendees: draft.guests == original.guests ? nil : draft.guests.map(guestInput)
        )
    }

}
