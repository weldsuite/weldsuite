import Foundation

/// Open, or closed. Read leniently: anything else is open.
enum ConversationState: String {
    case open, closed

    init(server value: String?) {
        self = value == "closed" ? .closed : .open
    }
}

/// Where a conversation came in. A channel added later shows by its own name (`other`).
enum DeskChannel: Equatable {
    case messenger, email, phone, whatsapp, sms, api, portal, other

    init(server value: String?) {
        switch value {
        case "messenger": self = .messenger
        case "email": self = .email
        case "phone": self = .phone
        case "whatsapp": self = .whatsapp
        case "sms": self = .sms
        case "api": self = .api
        case "portal": self = .portal
        default: self = .other
        }
    }
}

/// A reply to the customer, an internal note, or an event (closed, assigned, rated, …).
enum MessageKind: String {
    case message, note, event

    init(server value: String?) {
        self = MessageKind(rawValue: value ?? "") ?? .message
    }
}

enum AuthorType: String {
    case visitor, agent, bot, system

    init(server value: String?) {
        self = AuthorType(rawValue: value ?? "") ?? .system
    }
}

/// The inbox's order; the chip steps through them in this order.
enum InboxSort: String, CaseIterable {
    case newest
    case waitingLongest = "waiting_longest"
    case oldest

    /// newest → waiting longest → oldest → newest, as tapping the chip moves on.
    var next: InboxSort {
        switch self {
        case .newest: .waitingLongest
        case .waitingLongest: .oldest
        case .oldest: .newest
        }
    }
}

enum AssigneeFilter: String, CaseIterable {
    case all, mine, unassigned
}

/// What the inbox asks for.
struct InboxQuery: Equatable {
    var state: ConversationState = .open
    var assignee: AssigneeFilter = .all
    var sort: InboxSort = .newest
    var search = ""
}

/// The inbox request's parameters, as `GET /api/desk/conversations` takes them.
struct InboxRequest: Equatable {
    let state: String
    let assigneeID: String?
    let unassigned: Bool?
    let q: String?
    let sort: String
}

/// A conversation as the screens use it.
struct DeskConversation: Identifiable, Equatable {
    let id: String
    let number: Int
    let title: String?
    let state: ConversationState
    let channel: DeskChannel
    /// The server's channel value, shown as is for a channel the app doesn't know.
    let channelValue: String
    let visitorID: String?
    let name: String?
    let email: String?
    let assigneeID: String?
    let waitingSince: Date?
    let lastMessageAt: Date?
    let updatedAt: Date?
    let lastMessagePreview: String?
    /// urgent, high, medium or low.
    var priority: String?
    var tags: [String] = []
    /// The SLA clock: active, warning, breached, paused or achieved; nil without a policy.
    var slaStatus: String?
    var slaDueAt: Date?
    /// first_response, next_response or resolution.
    var slaMetric: String?

    var isWaiting: Bool { waitingSince != nil }
}

/// A file on a message.
struct DeskAttachment: Equatable, Hashable {
    let name: String?
    let url: String
    let contentType: String?
    let size: Int64?
    var width: Double?
    var height: Double?
}

/// One entry of a conversation's timeline.
struct DeskMessage: Identifiable, Equatable {
    let id: String
    let createdAt: Date?
    let conversationID: String
    let kind: MessageKind
    let body: String?
    let authorType: AuthorType
    let authorID: String?
    let attachments: [DeskAttachment]
    /// For an event: closed, reopened, assigned, unassigned, rated, …
    let eventType: String?
    let rating: Int?
    /// What else an event records, for its line in the timeline.
    var details = EventDetails()
}

/// What an event's metadata says beyond its type, as the platform's
/// timeline reads it. Each event type has its own keys; `DeskStore.eventDetails`
/// reads them from the response's JSON.
struct EventDetails: Equatable {
    /// assigned, escalated: who it went to.
    var assigneeID: String?
    /// assigned: by the workspace's assignment rules, not a person.
    var auto = false
    /// rated: the customer's comment.
    var ratingComment: String?
    /// sla_warning, sla_breached: first_response, next_response or resolution.
    var metric: String?
    /// attributes_changed: one entry per field.
    var changes: [AttributeChange] = []
    /// escalated: unassigned, no_response or sla_breach.
    var condition: String?
    var toTeamID: String?
    /// linked, unlinked, merged_*: the other ticket, and whether it is the parent.
    var linkRole: String?
    var linkedNumber: String?
    /// problem_linked, problem_unlinked.
    var problemNumber: String?
    /// approval_*: the step of the service request.
    var stepIndex: Int?
    var stepName: String?
    var approverID: String?
    var comment: String?
    /// fulfilment_started: the tasks created.
    var taskCount = 0
}

/// One field an `attributes_changed` event changed.
struct AttributeChange: Equatable {
    /// ticketType, team, priority, tags, impact, urgency or customField.
    let field: String
    /// A custom field's label, else its `key`.
    var label: String?
    var key: String?
    var from: ChangeValue = .empty
    var to: ChangeValue = .empty
}

/// A changed field's value: text, a list (tags), a yes/no, or nothing.
enum ChangeValue: Equatable {
    case empty
    case text(String)
    case items([String])
    case flag(Bool)
}

struct ConversationDetail: Equatable {
    var conversation: DeskConversation
    var messages: [DeskMessage]
}

/// What a reply or a change answers: the conversation after it, and the new timeline entry.
struct ConversationChange {
    let conversation: DeskConversation
    let message: DeskMessage
}

struct InboxPage {
    let items: [DeskConversation]
    let hasMore: Bool
    let cursor: String?
}

/// A teammate a conversation can be assigned to.
struct DeskMember: Identifiable, Equatable {
    let userID: String
    let name: String
    let email: String
    let picture: String?

    var id: String { userID }
}

/// Close, reopen, or (un)assign.
enum ManageAction: Equatable {
    case close
    case reopen
    /// Nil unassigns.
    case assign(String?)
}

/// Where the app opens: from a notification, a link, or the tab bar.
enum DeskRoute: Equatable {
    case inbox
    case settings
    case conversation(String)
}

/// Whose a conversation is, as the header says it.
enum AssigneeLabel: Equatable {
    case unassigned
    case you
    case teammate(String)
    /// Someone not (yet) in the loaded roster.
    case someone
}

/// Why a file can't go on a reply.
enum AttachmentProblem: Equatable {
    case tooLarge, typeNotAllowed
}

/// WeldDesk's rules, without UI: what the screens show and send. The same
/// rules as the Android app's `DeskLogic`.
enum DeskLogic {
    static let pageSize = 30
    static let searchDebounce: Duration = .milliseconds(300)
    /// A typing signal is repeated at most this often while the agent types.
    static let typingRepeat: TimeInterval = 3
    /// The agent stopped typing when nothing was typed for this long.
    static let typingIdle: Duration = .seconds(4)
    /// A visitor's typing clears by itself after this, when no stop arrives.
    static let typingExpiry: Duration = .seconds(6)

    /// What the server takes on a reply: 10 MB, these types, ten of them.
    static let maxAttachmentBytes: Int64 = 10 * 1024 * 1024
    static let maxAttachments = 10
    static let attachmentTypes: [String] = [
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "application/pdf",
        "text/plain",
        "text/csv",
        "application/zip",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]

    /// The query for the inbox's filters: "mine" is the signed-in person's user id.
    static func inboxRequest(_ query: InboxQuery, userID: String?) -> InboxRequest {
        let search = query.search.trimmingCharacters(in: .whitespacesAndNewlines)
        return InboxRequest(
            state: query.state.rawValue,
            assigneeID: query.assignee == .mine ? nonBlank(userID) : nil,
            unassigned: query.assignee == .unassigned ? true : nil,
            q: search.isEmpty ? nil : search,
            sort: query.sort.rawValue
        )
    }

    /// A row's name: the customer's name or email; nil for neither (the screen says "(no subject)").
    static func rowTitle(_ conversation: DeskConversation) -> String? {
        nonBlank(conversation.name) ?? nonBlank(conversation.email)
    }

    /// A row's subject: the conversation's title, else `#42`.
    static func rowSubject(_ conversation: DeskConversation) -> String {
        nonBlank(conversation.title) ?? "#\(conversation.number)"
    }

    /// A row's preview: the last message, else the subject, else the email.
    static func rowSubtitle(_ conversation: DeskConversation) -> String {
        nonBlank(conversation.lastMessagePreview) ?? nonBlank(conversation.title) ?? nonBlank(conversation.email) ?? ""
    }

    /// The thread's title, as the platform's header: the subject, the name, the email; nil for none ("Untitled conversation").
    static func threadTitle(_ conversation: DeskConversation) -> String? {
        nonBlank(conversation.title) ?? nonBlank(conversation.name) ?? nonBlank(conversation.email)
    }

    /// Under the title: the customer when the title is something else, and the number (`Ann · #42`).
    static func threadSubtitle(_ conversation: DeskConversation) -> String {
        let number = "#\(conversation.number)"
        guard let customer = nonBlank(conversation.name) ?? nonBlank(conversation.email), customer != threadTitle(conversation) else {
            return number
        }
        return "\(customer) · \(number)"
    }

    /// The time a row shows: the last message's, else the last change's.
    static func rowTime(_ conversation: DeskConversation) -> Date? {
        conversation.lastMessageAt ?? conversation.updatedAt
    }

    // MARK: - The inbox's date groups

    /// The platform's date groups (Gmail's): today, yesterday, a weekday this
    /// week, last week, weeks ago, a month. `weekday` is the calendar's
    /// (1 is Sunday).
    enum DateGroup: Hashable {
        /// Today has no header.
        case today
        case yesterday
        case weekday(Int)
        case lastWeek
        case weeksAgo(Int)
        /// The month, with its year once it is not this year's.
        case month(year: Int, month: Int, withYear: Bool)
        /// A later day (a scheduled message): the day itself.
        case later(Date)
    }

    /// The group of a day, seen from `today`; weeks start on Monday, as on the platform.
    static func dateGroup(_ date: Date, today now: Date, calendar: Calendar = .current) -> DateGroup {
        var calendar = calendar
        calendar.firstWeekday = 2
        let day = calendar.startOfDay(for: date)
        let today = calendar.startOfDay(for: now)
        if day == today { return .today }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: today), day == yesterday { return .yesterday }
        if day > today { return .later(day) }
        guard let thisWeek = calendar.dateInterval(of: .weekOfYear, for: today)?.start,
              let itsWeek = calendar.dateInterval(of: .weekOfYear, for: day)?.start
        else { return .today }
        if day >= thisWeek { return .weekday(calendar.component(.weekday, from: day)) }
        let days = calendar.dateComponents([.day], from: itsWeek, to: thisWeek).day ?? 0
        let weeks = Int((Double(days) / 7).rounded())
        if weeks == 1 { return .lastWeek }
        if weeks <= 3 { return .weeksAgo(weeks) }
        let year = calendar.component(.year, from: day)
        return .month(year: year, month: calendar.component(.month, from: day), withYear: year != calendar.component(.year, from: today))
    }

    /// One date group of the inbox and its conversations.
    struct ConversationGroup: Identifiable {
        let group: DateGroup
        let items: [DeskConversation]

        var id: DateGroup { group }
    }

    /// The inbox in its date groups, each in the order its first conversation comes (the list's sort).
    static func groupByDate(_ items: [DeskConversation], now: Date, calendar: Calendar = .current) -> [ConversationGroup] {
        var order: [DateGroup] = []
        var groups: [DateGroup: [DeskConversation]] = [:]
        for item in items {
            let group = dateGroup(rowTime(item) ?? now, today: now, calendar: calendar)
            if groups[group] == nil { order.append(group) }
            groups[group, default: []].append(item)
        }
        return order.map { ConversationGroup(group: $0, items: groups[$0] ?? []) }
    }

    // MARK: - SLA

    enum SlaTone: Equatable {
        case ok, warning, breached, muted
    }

    /// What the SLA chip says. `metric` is first_response, next_response or resolution.
    enum SlaLabel: Equatable {
        case dueIn(metric: String, time: String)
        case overdue(metric: String, time: String)
        case breached
        case paused
        case achieved
    }

    struct SlaDisplay: Equatable {
        let label: SlaLabel
        let tone: SlaTone
    }

    /// A conversation's SLA chip at `now` (the platform's `deskSlaDisplay`):
    /// the countdown while a target runs, "SLA breached" after. The list
    /// leaves out paused and met; the header shows them.
    static func slaDisplay(_ conversation: DeskConversation, now: Date, showPaused: Bool = false, showFinished: Bool = false) -> SlaDisplay? {
        guard let status = nonBlank(conversation.slaStatus) else { return nil }
        if let due = conversation.slaDueAt, let metric = nonBlank(conversation.slaMetric), conversation.state == .open {
            let remaining = due.timeIntervalSince(now) * 1000
            if remaining <= 0 { return SlaDisplay(label: .overdue(metric: metric, time: formatSlaDuration(remaining)), tone: .breached) }
            let tone: SlaTone
            switch status {
            case "warning": tone = .warning
            case "breached": tone = .breached
            default: tone = .ok
            }
            return SlaDisplay(label: .dueIn(metric: metric, time: formatSlaDuration(remaining)), tone: tone)
        }
        if status == "paused", showPaused { return SlaDisplay(label: .paused, tone: .muted) }
        if status == "breached" { return SlaDisplay(label: .breached, tone: .breached) }
        if status == "achieved", showFinished { return SlaDisplay(label: .achieved, tone: .ok) }
        return nil
    }

    /// "45m", "3h 5m", "2d 4h": how long until (or since) an SLA target, from milliseconds.
    static func formatSlaDuration(_ milliseconds: Double) -> String {
        let minutes = max(1, Int((abs(milliseconds) / 60_000).rounded()))
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return minutes % 60 != 0 ? "\(hours)h \(minutes % 60)m" : "\(hours)h" }
        let days = hours / 24
        return hours % 24 != 0 ? "\(days)d \(hours % 24)h" : "\(days)d"
    }

    // MARK: - The inbox row's badges

    /// A badge under an inbox row, in the platform's order.
    enum RowBadge: Equatable {
        case sla(SlaDisplay)
        /// Only urgent and high: the priorities that should catch the eye.
        case priority(String)
        case tag(String)
        /// Email, phone, help center and API; chat has none.
        case channel(DeskChannel)
        case unassigned
        /// The customer waits for an answer.
        case waiting
    }

    /// How many badges a row shows before "+N".
    static let maxRowBadges = 3

    /// A row's badges (the platform's `conversationToItem` labels): SLA, priority, two tags, channel, unassigned, waiting.
    static func rowBadges(_ conversation: DeskConversation, now: Date) -> [RowBadge] {
        var badges: [RowBadge] = []
        if let sla = slaDisplay(conversation, now: now) { badges.append(.sla(sla)) }
        if let priority = conversation.priority, priority == "urgent" || priority == "high" { badges.append(.priority(priority)) }
        for tag in conversation.tags.filter({ nonBlank($0) != nil }).prefix(2) { badges.append(.tag(tag)) }
        if [.email, .phone, .portal, .api].contains(conversation.channel) { badges.append(.channel(conversation.channel)) }
        if nonBlank(conversation.assigneeID) == nil { badges.append(.unassigned) }
        if conversation.isWaiting { badges.append(.waiting) }
        return badges
    }

    // MARK: - The thread

    /// How long ago a message was, short: now, minutes, hours, days, then the date.
    enum Ago: Equatable {
        case now
        case minutes(Int)
        case hours(Int)
        case days(Int)
        case on(Date)
    }

    static func ago(_ date: Date, now: Date) -> Ago {
        let minutes = Int(now.timeIntervalSince(date) / 60)
        if minutes < 1 { return .now }
        if minutes < 60 { return .minutes(minutes) }
        if minutes < 60 * 24 { return .hours(minutes / 60) }
        if minutes < 60 * 24 * 7 { return .days(minutes / (60 * 24)) }
        return .on(date)
    }

    /// Whether `message` starts a new day after `previous` (the timeline's day line).
    static func startsDay(_ previous: DeskMessage?, _ message: DeskMessage, calendar: Calendar = .current) -> Bool {
        guard let day = message.createdAt else { return false }
        guard let before = previous?.createdAt else { return true }
        return !calendar.isDate(day, inSameDayAs: before)
    }

    /// The tags a change added and removed, in order.
    static func tagDiff(_ change: AttributeChange) -> (added: [String], removed: [String]) {
        var before: [String] = []
        var after: [String] = []
        if case let .items(items) = change.from { before = items }
        if case let .items(items) = change.to { after = items }
        return (after.filter { !before.contains($0) }, before.filter { !after.contains($0) })
    }

    /// Whether a change cleared its field (nothing, an empty text or an empty list).
    static func isCleared(_ value: ChangeValue) -> Bool {
        switch value {
        case .empty: true
        case let .text(text): text.isEmpty
        case let .items(items): items.isEmpty
        case .flag: false
        }
    }

    /// Events only the team sees, which the timeline marks with a lock.
    static let internalEvents: Set<String> = [
        "attributes_changed",
        "linked", "unlinked", "merged_into", "merged_from", "incident_marked", "incident_unmarked",
        "problem_linked", "problem_unlinked",
        "approval_requested", "approval_approved", "approval_rejected", "fulfilment_started",
        "sla_warning", "sla_breached",
    ]

    /// Insert or replace a message by id, keeping the timeline in time order.
    static func merge(_ messages: [DeskMessage], _ incoming: DeskMessage) -> [DeskMessage] {
        if let index = messages.firstIndex(where: { $0.id == incoming.id }) {
            var next = messages
            next[index] = incoming
            return next
        }
        var next = messages
        next.append(incoming)
        // Stable, with undated entries last.
        return next.enumerated().sorted { lhs, rhs in
            switch (lhs.element.createdAt, rhs.element.createdAt) {
            case let (left?, right?):
                return left == right ? lhs.offset < rhs.offset : left < right
            case (.some, .none):
                return true
            case (.none, .some):
                return false
            case (.none, .none):
                return lhs.offset < rhs.offset
            }
        }.map(\.element)
    }

    static func assigneeLabel(assigneeID: String?, userID: String?, members: [DeskMember]?) -> AssigneeLabel {
        guard let assigneeID, !assigneeID.isEmpty else { return .unassigned }
        if assigneeID == userID { return .you }
        if let member = members?.first(where: { $0.userID == assigneeID }) { return .teammate(member.name) }
        return .someone
    }

    /// The picker's search over names and emails.
    static func filterMembers(_ members: [DeskMember], search: String) -> [DeskMember] {
        let needle = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return members }
        return members.filter { $0.name.lowercased().contains(needle) || $0.email.lowercased().contains(needle) }
    }

    /// The picker's roster from the team list: members with a user id, named by name, email or id.
    static func member(userID: String?, name: String?, email: String?, picture: String?) -> DeskMember? {
        guard let id = nonBlank(userID) else { return nil }
        return DeskMember(userID: id, name: nonBlank(name) ?? nonBlank(email) ?? id, email: email ?? "", picture: nonBlank(picture))
    }

    /// `1.4 MB`; empty for an unknown or empty size.
    static func formatFileSize(_ bytes: Int64?) -> String {
        guard let bytes, bytes > 0 else { return "" }
        let units = ["B", "KB", "MB", "GB"]
        var value = Double(bytes)
        var unit = 0
        while value >= 1024, unit < units.count - 1 {
            value /= 1024
            unit += 1
        }
        let rounded: String
        if unit == 0 || value >= 10 {
            rounded = String(Int(value.rounded()))
        } else {
            let tenths = (value * 10).rounded() / 10
            rounded = tenths == tenths.rounded(.down) ? String(Int(tenths)) : String(tenths)
        }
        return "\(rounded) \(units[unit])"
    }

    static func isImage(_ contentType: String?) -> Bool {
        (contentType ?? "").lowercased().hasPrefix("image/")
    }

    /// Only http(s) links are opened from a thread; anything else (`javascript:`, `file:`) isn't.
    static func openableURL(_ text: String?) -> URL? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        let lower = text.lowercased()
        guard lower.hasPrefix("http://") || lower.hasPrefix("https://") else { return nil }
        return URL(string: text)
    }

    static func attachmentProblem(contentType: String?, size: Int64?) -> AttachmentProblem? {
        if let size, size > maxAttachmentBytes { return .tooLarge }
        guard let type = contentType?.lowercased(), attachmentTypes.contains(type) else { return .typeNotAllowed }
        return nil
    }

    /// A realtime room member who is the visitor (`visitor:<id>`), not an agent.
    static func isVisitor(_ userID: String) -> Bool {
        userID.hasPrefix("visitor:")
    }

    /// The conversation a notification is about: its `conversationId`, a
    /// `desk_conversation` entity, or the web link `/welddesk/inbox/<id>`.
    /// Nil for anything else (a ticket opens the inbox).
    static func conversationID(fromPush values: [String: String]) -> String? {
        if let id = nonBlank(values["conversationId"]) { return id }
        if values["entityType"] == "desk_conversation", let id = nonBlank(values["entityId"]) { return id }
        guard let link = nonBlank(values["actionUrl"]) else { return nil }
        var path = String(link.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        path = String(path.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        while path.hasSuffix("/") { path.removeLast() }
        guard let range = path.range(of: "/welddesk/inbox/") else { return nil }
        let id = String(path[range.upperBound...])
        return id.isEmpty || id.contains("/") ? nil : id
    }

    /// Where a notification opens: its conversation, else the inbox.
    static func route(forPush values: [String: String]) -> DeskRoute {
        conversationID(fromPush: values).map { .conversation($0) } ?? .inbox
    }

    /// `welddesk://conversation/<id>`, `welddesk://settings` or
    /// `welddesk://inbox`, as the Expo app's routes; nil for another link
    /// (WeldID's `welddesk://sso-callback`).
    static func route(forLink link: String?) -> DeskRoute? {
        guard let text = link?.trimmingCharacters(in: .whitespaces), text.lowercased().hasPrefix("welddesk://") else { return nil }
        var rest = String(text.dropFirst("welddesk://".count))
        rest = String(rest.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        rest = String(rest.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        let parts = rest.split(separator: "/").map(String.init)
        guard let first = parts.first else { return .inbox }
        switch first {
        case "inbox", "(tabs)": return .inbox
        case "settings": return .settings
        case "conversation" where parts.count == 2: return .conversation(parts[1])
        default: return nil
        }
    }

    /// The realtime service's base URL: the server's `realtimeUrl` without a
    /// trailing `/ws`, else the server itself on `ws(s)://`. (The core's
    /// `realtimeBase`, which it keeps internal.)
    static func realtimeBase(_ configured: String?, server: URL) -> URL {
        let trimmed = configured?.trimmingCharacters(in: .whitespaces) ?? ""
        var text = trimmed.isEmpty
            ? server.absoluteString.replacingOccurrences(of: "^http", with: "ws", options: .regularExpression)
            : trimmed
        while text.hasSuffix("/") { text.removeLast() }
        if text.hasSuffix("/ws") { text.removeLast(3) }
        return URL(string: text) ?? server
    }

    private static func nonBlank(_ text: String?) -> String? {
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return text
    }
}

/// A conversation room's typing and presence (`@weldsuite/realtime`'s
/// `RoomClient`): the server's snapshot on connect, then joins, leaves and
/// typing signals. Pure, so the room socket and its tests share it.
struct RoomState: Equatable {
    /// User id → name of whoever is typing.
    var typing: [String: String] = [:]
    /// User ids in the room.
    var present: Set<String> = []

    /// Names of the visitors typing.
    var visitorsTyping: [String] {
        typing.filter { DeskLogic.isVisitor($0.key) }.sorted { $0.key < $1.key }.map(\.value)
    }

    var visitorOnline: Bool { present.contains(where: DeskLogic.isVisitor) }

    /// What [reduce] reads of a message.
    struct Fields: Equatable {
        var userID: String?
        var userName: String?
        var isTyping = false
        var presence: [String] = []
    }

    /// The state after one of the room's messages: `connected` (with
    /// `presence`), `presence:join`, `presence:leave`, `typing`. Anything else
    /// leaves it as it was.
    static func reduce(_ state: RoomState, type: String?, fields: Fields) -> RoomState {
        var next = state
        switch type {
        case "connected":
            next.present = Set(fields.presence)
            next.typing = [:]
        case "presence:join":
            if let id = fields.userID { next.present.insert(id) }
        case "presence:leave":
            if let id = fields.userID {
                next.present.remove(id)
                next.typing[id] = nil
            }
        case "typing":
            guard let id = fields.userID else { return state }
            next.typing[id] = fields.isTyping ? (fields.userName ?? "") : nil
        default:
            return state
        }
        return next
    }

    /// The fields [reduce] reads, from a message as JSON.
    static func fields(of message: [String: Any]) -> Fields {
        let member = message["member"] as? [String: Any]
        let presence = (message["presence"] as? [[String: Any]] ?? []).compactMap { $0["userId"] as? String }
        return Fields(
            userID: message["userId"] as? String ?? member?["userId"] as? String,
            userName: message["userName"] as? String ?? member?["userName"] as? String,
            isTyping: message["isTyping"] as? Bool ?? false,
            presence: presence
        )
    }
}

/// When to send the agent's own typing signal: a start at most every
/// `DeskLogic.typingRepeat`, a stop once after it.
struct TypingThrottle {
    private var lastSent: TimeInterval = 0

    /// A keystroke at `now`: whether to send `typing:start`.
    mutating func keystroke(now: TimeInterval) -> Bool {
        guard now - lastSent > DeskLogic.typingRepeat else { return false }
        lastSent = now
        return true
    }

    /// Typing ended (idle, sent, left): whether to send `typing:stop`.
    mutating func stop() -> Bool {
        guard lastSent != 0 else { return false }
        lastSent = 0
        return true
    }
}
