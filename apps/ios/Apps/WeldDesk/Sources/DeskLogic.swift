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

    /// A row's title: the customer's name or email; nil for neither (the screen says "Conversation").
    static func rowTitle(_ conversation: DeskConversation) -> String? {
        nonBlank(conversation.name) ?? nonBlank(conversation.email)
    }

    /// A row's second line: the last message, else the subject, else the email.
    static func rowSubtitle(_ conversation: DeskConversation) -> String {
        nonBlank(conversation.lastMessagePreview) ?? nonBlank(conversation.title) ?? nonBlank(conversation.email) ?? ""
    }

    /// `#42 · Order question`, or `#42` without a subject.
    static func numberLabel(_ conversation: DeskConversation) -> String {
        let number = "#\(conversation.number)"
        guard let title = nonBlank(conversation.title) else { return number }
        return "\(number) · \(title)"
    }

    /// The thread's title: the customer's name, their email, or `#42`.
    static func threadTitle(_ conversation: DeskConversation) -> String {
        nonBlank(conversation.name) ?? nonBlank(conversation.email) ?? "#\(conversation.number)"
    }

    /// The time a row shows: the last message's, else the last change's.
    static func rowTime(_ conversation: DeskConversation) -> Date? {
        conversation.lastMessageAt ?? conversation.updatedAt
    }

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
