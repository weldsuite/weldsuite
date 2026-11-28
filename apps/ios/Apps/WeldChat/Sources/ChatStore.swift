import Foundation
import Observation
import WeldChatAPI
import WeldCore

// MARK: - Models

// What the screens use. Mapped from the generated API types in this file and
// nowhere else (the calls have their own, in Calls/), so a change in the
// generated names stays here.

/// A channel, a DM or a record chat row, with the caller's read state.
struct ChatChannel: Identifiable, Equatable {
    let id: String
    var name: String
    var type: String
    var description: String?
    var topic: String?
    var isArchived: Bool
    var threadsEnabled: Bool
    var memberCount: Int?
    var lastMessageAt: String?
    var lastMessagePreview: String?
    var sectionID: String?
    var entityType: String?
    var entityID: String?
    var entityDisplayName: String?
    var isMuted: Bool
    /// Nil: never read. Only meaningful when `hasReadState`.
    var lastReadAt: String?
    /// The answer carried the caller's read state (the list does, the detail doesn't).
    var hasReadState: Bool
    var unreadMentionCount: Int
    var pinnedBy: [String]
    var members: [ChannelMemberInfo]

    var isPrivate: Bool { type == "private" }
    var isDM: Bool { type == "dm" }
    var isRecord: Bool { type == "entity" }
}

/// A member of a channel: a person or a WeldAgent.
struct ChannelMemberInfo: Identifiable, Equatable {
    let id: String
    let userID: String
    var memberType: String
    var role: String?
    var isMuted: Bool
    var name: String?
    var email: String?
    var picture: String?
    var agentIcon: String?

    var isAgent: Bool { memberType == "agent" }
}

/// The caller's own membership row (mute and notification level).
struct ChatMembership: Equatable {
    let id: String
    var isMuted: Bool
    var notificationPreference: NotificationLevel
}

enum NotificationLevel: String, CaseIterable {
    case all, mentions, none
}

struct DmPerson: Identifiable, Equatable {
    let userID: String
    var name: String?
    var email: String?
    var picture: String?

    var id: String { userID }
    var displayName: String { name ?? email ?? ChatStrings.dmsUnknownMember }
}

/// A direct message as the DM list and Home show it (`mapDm`).
struct DmConversation: Identifiable, Equatable {
    let id: String
    var name: String
    var picture: String?
    var type: String
    var isGroup: Bool
    var otherMembers: [DmPerson]
    var isMuted: Bool
    var isPinned: Bool
    var hasUnread: Bool
    var unreadCount: Int
    var lastMessagePreview: String?
    var lastMessageAt: String?
    var isArchived: Bool

    /// The other person in a 1:1 conversation.
    var peerUserID: String? { isGroup ? nil : otherMembers.first?.userID }
}

struct ChatSection: Identifiable, Equatable {
    let id: String
    var name: String
    var position: Int
}

struct ChatAttachment: Identifiable, Equatable, Hashable {
    let id: String
    var fileName: String
    var fileSize: Double
    var mimeType: String
    var url: String

    var isImage: Bool { mimeType.lowercased().hasPrefix("image/") }
    var isAudio: Bool { mimeType.lowercased().hasPrefix("audio/") }
}

/// An inline reply's quote (`metadata.replyTo`).
struct ReplyReference: Equatable {
    var messageID: String
    var rootID: String
    var depth: Int
    var authorID: String
    var authorName: String
    var authorAvatar: String?
    var content: String
    var hasAttachments: Bool
}

struct AgentVisualRef: Equatable {
    var kind: String
    var title: String
}

struct ChatMessage: Identifiable, Equatable {
    let id: String
    var channelID: String
    var authorID: String
    var authorName: String
    var authorAvatar: String?
    var authorType: String?
    var content: String
    var type: String
    var parentID: String?
    var threadReplyCount: Int
    /// When the thread's last reply came in.
    var threadLastReplyAt: String? = nil
    var editedAt: String?
    var isPinned: Bool
    var hasAttachments: Bool
    var attachments: [ChatAttachment]
    var reactions: [String: [String]]
    var replyTo: ReplyReference?
    var visuals: [AgentVisualRef]
    var createdAt: String
    /// An optimistic row shown while the send runs.
    var pending = false

    var isSystem: Bool { type == "system" }
    var isAgent: Bool { authorType == "agent" }
    var date: Date? { WeldDate.parse(createdAt) }
}

/// A record chat (a chat on a company, person, task, …) with the caller's state.
struct RecordChat: Identifiable, Equatable {
    let id: String
    var name: String
    var entityType: String
    var entityID: String
    var entityDisplayName: String?
    var lastMessageAt: String?
    var lastMessagePreview: String?
    var isFollowing: Bool
    var isMuted: Bool
    var lastReadAt: String?
    var unreadMentionCount: Int

    var displayName: String { RecordChatRules.name(entityDisplayName: entityDisplayName, name: name) }
}

struct RecordChatTypeSummary: Equatable {
    var type: String
    var followed: Int
    var unread: Int
    var mentions: Int
}

struct TeamMember: Identifiable, Equatable {
    let id: String
    let userID: String
    var name: String?
    var email: String?
    var picture: String?
    var role: String
    var status: String
    var memberType: String

    var displayName: String { name ?? email ?? "?" }
    /// Invited, not joined yet: chat-api refuses a DM before then.
    var isPendingInvitee: Bool {
        status.uppercased() == "PENDING" || userID.hasPrefix("invited_") || userID.hasPrefix("pending_clerk_")
    }
}

struct ActivityNotification: Identifiable, Equatable {
    let id: String
    var title: String
    var body: String?
    var category: String
    var notificationType: String
    var entityType: String?
    var entityID: String?
    var actionURL: String?
    var isRead: Bool
    var createdAt: String
    var actorName: String?
    var actorAvatar: String?
    var actorID: String? = nil
    /// The conversation it happened in, and its name (a channel's; a DM's is who it is with).
    var channelID: String? = nil
    var channelName: String? = nil
}

struct ChatDraft: Identifiable, Equatable {
    let id: String
    var channelID: String?
    var content: String
    var updatedAt: String
}

struct ChatBookmark: Identifiable, Equatable {
    let id: String
    var messageID: String
    var channelID: String
    var note: String?
    var createdAt: String
    var messageContent: String?
    var messageAuthorName: String?
    var messageAuthorAvatar: String? = nil
    var channelName: String?
    var channelType: String?
}

struct SearchHitItem: Identifiable, Equatable {
    let id: String
    var content: String
    var authorName: String
    var authorAvatar: String?
    var channelID: String
    var channelName: String?
    var channelType: String?
    var createdAt: String
    var attachments: [ChatAttachment]
}

enum PresenceStatus: String, CaseIterable {
    case online, busy, away, dnd, offline
}

struct MemberPresence: Equatable {
    var status: PresenceStatus
    var statusText: String?
    var statusEmoji: String?
}

struct ProfileLinkItem: Equatable, Hashable {
    var label: String
    var url: String
}

struct DayHoursInfo: Equatable {
    var isOpen: Bool
    var openTime: String?
    var closeTime: String?
    var breaks: [(start: String, end: String)]

    static func == (lhs: DayHoursInfo, rhs: DayHoursInfo) -> Bool {
        lhs.isOpen == rhs.isOpen && lhs.openTime == rhs.openTime && lhs.closeTime == rhs.closeTime
            && lhs.breaks.map(\.start) == rhs.breaks.map(\.start) && lhs.breaks.map(\.end) == rhs.breaks.map(\.end)
    }
}

enum Weekday: String, CaseIterable {
    case monday, tuesday, wednesday, thursday, friday, saturday, sunday
}

struct MemberProfileInfo: Equatable {
    var id: String
    var userID: String
    var name: String?
    var email: String?
    var picture: String?
    var role: String
    var status: String
    var title: String?
    var bio: String?
    var phone: String?
    var location: String?
    var pronouns: String?
    var links: [ProfileLinkItem]
    var hoursPerWeek: String?
    var workingHours: [Weekday: DayHoursInfo]
    var timezone: String
    var canEdit: Bool
}

/// A change to one profile field; empty text clears it.
enum ProfileField {
    case title, bio, phone, location, pronouns, hoursPerWeek
}

struct CommonConceptsInfo: Equatable {
    struct Channel: Equatable, Identifiable { let id: String; var name: String; var type: String; var memberCount: Int }
    struct Project: Equatable, Identifiable { let id: String; var name: String; var status: String? }
    struct Task: Equatable, Identifiable { let id: String; var title: String; var status: String; var role: String }
    struct Crm: Equatable, Identifiable { let id: String; var kind: String; var name: String; var status: String? }
    struct Helpdesk: Equatable, Identifiable { let id: String; var kind: String; var subject: String; var status: String }

    var channels: [Channel]
    var projects: [Project]
    var tasks: [Task]
    var crm: [Crm]
    var helpdesk: [Helpdesk]
}

struct MemberActivityEntry: Identifiable, Equatable {
    let id: String
    var action: String
    var entityType: String
    var entityID: String
    var description: String
    var createdAt: String
}

/// One page of a list, and where the next one starts.
struct Page<T> {
    var items: [T]
    var cursor: String?
    var hasMore: Bool
}

// MARK: - Store

/// Everything WeldChat reads and writes, except calls (Calls/CallAPI.swift).
/// Keeps the lists Home and the DM list share, so switching tabs paints at
/// once; a screen's own data (messages, a profile) stays in the screen.
@MainActor
@Observable
final class ChatStore {
    private(set) var channels: [ChatChannel] = []
    private(set) var sections: [ChatSection] = []
    private(set) var dms: [DmConversation] = []
    private(set) var homeLoaded = false
    private(set) var dmsLoaded = false
    private(set) var savedCount: Int?
    private(set) var draftCount: Int?
    private(set) var activityUnread = 0
    /// The workspace roster: names for mentions, presence for DM headers.
    private(set) var roster: [TeamMember] = []
    private(set) var recordSummary: [RecordChatTypeSummary]?
    private(set) var recordRows: [String: [RecordChat]] = [:]

    @ObservationIgnored let env: AppEnvironment
    @ObservationIgnored private(set) var currentUserID: String?
    @ObservationIgnored private var workspace: String?
    @ObservationIgnored private var memberships: [String: ChatMembership] = [:]
    @ObservationIgnored private var recordRefresh = RecordRefreshQueue()
    @ObservationIgnored private var recordGeneration = 0

    init(env: AppEnvironment) {
        self.env = env
    }

    /// Forget another workspace's (or person's) lists the moment they change.
    func use(workspace id: String, userID: String) {
        guard workspace != id || currentUserID != userID else { return }
        workspace = id
        currentUserID = userID
        channels = []
        sections = []
        dms = []
        homeLoaded = false
        dmsLoaded = false
        savedCount = nil
        draftCount = nil
        activityUnread = 0
        roster = []
        recordSummary = nil
        recordRows = [:]
        memberships = [:]
        recordGeneration += 1
    }

    var memberNames: [String: String] {
        var names: [String: String] = [:]
        for member in roster {
            if let name = member.name { names[member.userID] = name }
        }
        return names
    }

    func memberStatus(_ userID: String) -> String? {
        roster.first { $0.userID == userID }?.status
    }

    private func client() throws -> Client {
        guard let api = env.api else { throw APIError(status: nil, code: nil) }
        return Client(serverURL: api.serverURL, transport: api.transport, middlewares: api.middlewares)
    }

    /// Runs a request; anything thrown becomes an `APIError`.
    private func call<T>(_ request: () async throws -> T) async throws -> T {
        do {
            return try await request()
        } catch {
            throw APIError.from(error)
        }
    }

    // MARK: Shared lists

    /// Home's channels, sections and DMs. A failure keeps what was shown.
    func loadHome() async {
        let forWorkspace = workspace
        async let channelPage = listChannels(types: "public,private", limit: 100)
        async let sectionList = listSections()
        async let dmList = listDms()
        let loadedChannels = try? await channelPage
        let loadedSections = try? await sectionList
        let loadedDms = try? await dmList
        guard workspace == forWorkspace else { return }
        if let loadedChannels {
            // DMs and record chats have their own lists.
            channels = loadedChannels.items.filter { !$0.isDM && !$0.isRecord }
        }
        if let loadedSections { sections = loadedSections }
        if let loadedDms {
            dms = loadedDms
            dmsLoaded = true
        }
        homeLoaded = true
    }

    func loadDmList() async {
        let forWorkspace = workspace
        guard let loaded = try? await listDms(), workspace == forWorkspace else { return }
        dms = loaded
        dmsLoaded = true
    }

    /// The counts on Home's Saved and Drafts tiles. Best effort.
    func loadCounts() async {
        if let saved = try? await listBookmarks(limit: ChatLogic.savedCap) { savedCount = saved.count }
        if let drafts = try? await listDrafts(channelID: nil) { draftCount = drafts.count }
    }

    func loadActivityUnread() async {
        if let count = try? await unreadActivityCount() { activityUnread = count }
    }

    func setActivityUnread(_ count: Int) {
        activityUnread = count
    }

    func loadRosterIfNeeded() async {
        guard roster.isEmpty else { return }
        await loadRoster()
    }

    func loadRoster() async {
        if let members = try? await listTeamMembers() { roster = members }
    }

    /// A change made from a row's menu, shown before the server confirms it.
    func patchChannel(_ id: String, _ patch: ConversationPatch) {
        channels = channels.map { channel in
            guard channel.id == id else { return channel }
            var next = channel
            if let muted = patch.isMuted { next.isMuted = muted }
            if patch.hasUnread == false {
                next.unreadMentionCount = 0
                next.lastReadAt = WeldDate.timestampString(Date())
                next.hasReadState = true
            }
            return next
        }
    }

    func patchDm(_ id: String, _ patch: ConversationPatch) {
        if patch.archived == true {
            dms.removeAll { $0.id == id }
            return
        }
        dms = dms.map { dm in
            guard dm.id == id else { return dm }
            var next = dm
            if let muted = patch.isMuted { next.isMuted = muted }
            if let pinned = patch.isPinned { next.isPinned = pinned }
            if let unread = patch.hasUnread { next.hasUnread = unread }
            return next
        }
    }

    func removeDm(_ id: String) {
        dms.removeAll { $0.id == id }
    }

    // MARK: Record chats on Home

    /// Reload the record chat groups; `immediate` skips the burst wait.
    func refreshRecordChats(_ kind: RecordRefreshKind, immediate: Bool = false) {
        recordRefresh.request(kind)
        if immediate {
            Task { await runRecordRefresh() }
        } else if !recordRefresh.scheduled {
            recordRefresh.scheduled = true
            Task {
                try? await Task.sleep(for: .milliseconds(400))
                recordRefresh.scheduled = false
                await runRecordRefresh()
            }
        }
    }

    /// One load at a time; a request that comes in meanwhile runs after it.
    private func runRecordRefresh() async {
        guard !recordRefresh.running else { return }
        while let kind = recordRefresh.take() {
            recordRefresh.running = true
            await loadRecordChats(kind)
            recordRefresh.running = false
        }
    }

    /// `all`: the summary and every followed type. `summary`: the summary,
    /// then only the types whose counts moved.
    private func loadRecordChats(_ kind: RecordRefreshKind) async {
        let generation = recordGeneration
        guard let summary = try? await recordChatSummary() else { return }
        let types = kind == .all ? RecordChatRules.types : RecordChatRules.changedSummaryTypes(recordSummary, summary)
        var loaded: [String: [RecordChat]] = [:]
        for type in types {
            guard let counts = summary.first(where: { $0.type == type }), counts.followed > 0 else {
                loaded[type] = []
                continue
            }
            loaded[type] = await loadFollowed(type: type, counts: counts)
        }
        guard generation == recordGeneration else { return }
        recordSummary = summary
        recordRows.merge(loaded) { _, new in new }
    }

    /// The followed chats of one type; more pages while the summary counts
    /// unread chats or mentions the rows don't hold yet.
    private func loadFollowed(type: String, counts: RecordChatTypeSummary) async -> [RecordChat] {
        var pages: [[RecordChat]] = []
        var cursor: String?
        for _ in 0..<RecordChatRules.maxGroupPages {
            guard let page = try? await listRecordChats(type: type, filter: "following", search: nil, cursor: cursor, limit: 25) else {
                break
            }
            pages.append(page.items)
            let rows = RecordChatRules.uniqueRows(pages)
            guard page.hasMore, let next = page.cursor, !RecordChatRules.coversUnread(rows, counts) else { break }
            cursor = next
        }
        return RecordChatRules.uniqueRows(pages)
    }

    func patchRecordChat(_ id: String, _ patch: RecordChatPatch) {
        let next = RecordChatRules.patch(summary: recordSummary, rows: recordRows, id: id, patch: patch, now: Date())
        recordSummary = next.summary
        recordRows = next.rows
    }

    // MARK: Memberships (mute, notification level)

    func cachedMembership(_ channelID: String) -> ChatMembership? {
        memberships[channelID]
    }

    func forgetMembership(_ channelID: String) {
        memberships[channelID] = nil
    }

    func membership(_ channelID: String) async throws -> ChatMembership? {
        if let cached = memberships[channelID] { return cached }
        guard let userID = currentUserID else { return nil }
        let found = try await call { () async throws -> ChatMembership? in
            switch try await client().listChannelMemberships(query: .init(channelId: channelID, userId: userID)) {
            case let .ok(ok):
                return try ok.body.json.data.first.map { row in
                    ChatMembership(
                        id: row.id,
                        isMuted: row.isMuted ?? false,
                        notificationPreference: NotificationLevel(rawValue: row.notificationPreference ?? "all") ?? .all
                    )
                }
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
        if let found { memberships[channelID] = found }
        return found
    }

    /// Mute or the notification level, on the caller's own row (`channels:read` is enough).
    func updateMembership(channelID: String, isMuted: Bool? = nil, level: NotificationLevel? = nil) async throws {
        guard var row = try await membership(channelID) else { throw APIError(status: 404, code: nil) }
        var input = Components.Schemas.UpdateMembershipInput()
        input.isMuted = isMuted
        if let level { input.notificationPreference = .init(rawValue: level.rawValue) }
        let body = input
        try await call {
            switch try await client().updateChannelMembership(path: .init(membershipId: row.id), body: .json(body)) {
            case .ok:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
        if let isMuted { row.isMuted = isMuted }
        if let level { row.notificationPreference = level }
        memberships[channelID] = row
    }

    // MARK: Channels

    func listChannels(types: String?, limit: Int?, cursor: String? = nil) async throws -> Page<ChatChannel> {
        try await call {
            switch try await client().listChannels(query: .init(types: types, limit: limit, cursor: cursor)) {
            case let .ok(ok):
                let body = try ok.body.json
                return Page(items: body.data.map(Self.channel), cursor: body.pagination.cursor, hasMore: body.pagination.hasMore)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func channel(_ id: String) async throws -> ChatChannel {
        try await call {
            switch try await client().getChannel(path: .init(channelId: id)) {
            case let .ok(ok):
                return Self.channel(try ok.body.json.data)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func createChannel(name: String, isPrivate: Bool, sectionID: String?, memberIDs: [String]) async throws -> String {
        let body = Components.Schemas.CreateChannelInput(
            name: name,
            _type: .init(rawValue: isPrivate ? "private" : "public"),
            sectionId: sectionID,
            memberIds: memberIDs.isEmpty ? nil : memberIDs
        )
        return try await call {
            switch try await client().createChannel(body: .json(body)) {
            case let .created(created):
                return try created.body.json.data.id
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func renameChannel(_ id: String, name: String) async throws {
        try await call {
            switch try await client().updateChannel(path: .init(channelId: id), body: .json(.init(name: name))) {
            case .ok:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func deleteChannel(_ id: String) async throws {
        try await call {
            switch try await client().deleteChannel(path: .init(channelId: id)) {
            case .noContent:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func channelMembers(_ id: String) async throws -> [ChannelMemberInfo] {
        try await call {
            switch try await client().listChannelMembers(path: .init(channelId: id)) {
            case let .ok(ok):
                return try ok.body.json.data.map(Self.member)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func addMembers(_ channelID: String, userIDs: [String]) async throws {
        try await call {
            switch try await client().addChannelMembers(path: .init(channelId: channelID), body: .json(.init(userIds: userIDs))) {
            case .created:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func leaveChannel(_ id: String) async throws {
        try await call {
            switch try await client().leaveChannel(path: .init(channelId: id)) {
            case .ok:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func markRead(_ channelID: String) async throws {
        try await call {
            switch try await client().markChannelRead(path: .init(channelId: channelID)) {
            case .ok:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    // MARK: Messages

    func messages(channelID: String, parentID: String? = nil, cursor: String? = nil, limit: Int? = nil) async throws -> Page<ChatMessage> {
        try await call {
            switch try await client().listMessages(query: .init(channelId: channelID, parentId: parentID, cursor: cursor, limit: limit)) {
            case let .ok(ok):
                let body = try ok.body.json
                return Page(items: body.data.map(Self.message), cursor: body.pagination.cursor, hasMore: body.pagination.hasMore)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func message(_ id: String) async throws -> ChatMessage {
        try await call {
            switch try await client().getMessage(path: .init(messageId: id)) {
            case let .ok(ok):
                return Self.message(try ok.body.json.data)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    /// Send a message (a reply in the channel when `replyToID` is set, a thread reply with `parentID`).
    func send(
        channelID: String,
        body text: String,
        parentID: String? = nil,
        replyToID: String? = nil,
        replyMention: Bool? = nil,
        attachments: [ChatAttachment] = []
    ) async throws -> String {
        let input = Components.Schemas.CreateMessageInput(
            channelId: channelID,
            body: text,
            parentId: parentID,
            replyToId: replyToID,
            replyMention: replyMention,
            attachments: attachments.isEmpty ? nil : attachments.map { attachment in
                Components.Schemas.AttachmentInput(
                    id: attachment.id,
                    fileName: attachment.fileName,
                    fileSize: attachment.fileSize,
                    mimeType: attachment.mimeType,
                    url: attachment.url
                )
            }
        )
        return try await call {
            switch try await client().createMessage(body: .json(input)) {
            case let .created(created):
                return try created.body.json.data.id
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func editMessage(_ id: String, content: String) async throws {
        try await call {
            switch try await client().updateMessage(path: .init(messageId: id), body: .json(.init(content: content))) {
            case .ok:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func deleteMessage(_ id: String) async throws {
        try await call {
            switch try await client().deleteMessage(path: .init(messageId: id)) {
            case .noContent:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func react(_ messageID: String, emoji: String, add: Bool) async throws {
        try await call {
            if add {
                switch try await client().addReaction(path: .init(messageId: messageID), body: .json(.init(emoji: emoji))) {
                case .ok:
                    return
                case let .default(status, response):
                    throw APIError(status: status, code: try? response.body.json.error.code)
                }
            } else {
                switch try await client().removeReaction(path: .init(messageId: messageID, emoji: emoji)) {
                case .ok:
                    return
                case let .default(status, response):
                    throw APIError(status: status, code: try? response.body.json.error.code)
                }
            }
        }
    }

    /// Pin until `expiresAt` (nil: for good); `notify` posts the channel's "pinned a message" notice.
    func pin(_ messageID: String, expiresAt: Date?, notify: Bool) async throws {
        let body = Components.Schemas.PinInput(expiresAt: expiresAt.map(WeldDate.timestampString), notify: notify)
        try await call {
            switch try await client().pinMessage(path: .init(messageId: messageID), body: .json(body)) {
            case .ok:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func unpin(_ messageID: String) async throws {
        try await call {
            switch try await client().unpinMessage(path: .init(messageId: messageID)) {
            case .ok:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    // MARK: Direct messages

    func listDms() async throws -> [DmConversation] {
        let me = currentUserID
        return try await call {
            switch try await client().listDms() {
            case let .ok(ok):
                return try ok.body.json.data.map { Self.dm($0, currentUserID: me) }
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    /// The DM with exactly these people, made when there is none. Returns its id.
    func createDm(userIDs: [String]) async throws -> DmConversation {
        let me = currentUserID
        return try await call {
            switch try await client().createDm(body: .json(.init(userIds: userIDs))) {
            case let .ok(ok):
                return Self.dm(try ok.body.json.data, currentUserID: me)
            case let .created(created):
                return Self.dm(try created.body.json.data, currentUserID: me)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    /// The 1:1 DM with `userID`, made if there isn't one yet.
    func ensureDm(with userID: String) async throws -> DmConversation {
        if let existing = try await listDms().first(where: { !$0.isGroup && $0.otherMembers.first?.userID == userID }) {
            return existing
        }
        return try await createDm(userIDs: [userID])
    }

    func setArchived(_ channelID: String, archived: Bool) async throws {
        try await call {
            if archived {
                switch try await client().archiveDm(path: .init(channelId: channelID)) {
                case .ok:
                    return
                case let .default(status, response):
                    throw APIError(status: status, code: try? response.body.json.error.code)
                }
            } else {
                switch try await client().unarchiveDm(path: .init(channelId: channelID)) {
                case .ok:
                    return
                case let .default(status, response):
                    throw APIError(status: status, code: try? response.body.json.error.code)
                }
            }
        }
    }

    func pinDm(_ channelID: String, pinned: Bool) async throws {
        try await call {
            switch try await client().pinDm(path: .init(channelId: channelID), body: .json(.init(isPinned: pinned))) {
            case .ok:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func leaveDm(_ channelID: String) async throws {
        try await call {
            switch try await client().leaveDm(path: .init(channelId: channelID)) {
            case .noContent:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    // MARK: Sections

    func listSections() async throws -> [ChatSection] {
        try await call {
            switch try await client().listSections(query: .init(limit: 100)) {
            case let .ok(ok):
                return try ok.body.json.data.map { ChatSection(id: $0.id, name: $0.name, position: $0.position ?? 0) }
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func createSection(name: String) async throws {
        try await call {
            switch try await client().createSection(body: .json(.init(name: name))) {
            case .created:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    // MARK: Search, drafts, saved, presence

    func search(_ text: String) async throws -> [SearchHitItem] {
        try await call {
            switch try await client().searchMessages(query: .init(q: text, limit: 50)) {
            case let .ok(ok):
                return try ok.body.json.data.messages.map { hit in
                    SearchHitItem(
                        id: hit.id,
                        content: MentionText.stripFileTokens(hit.content ?? ""),
                        authorName: hit.authorName ?? ChatStrings.savedUnknownAuthor,
                        authorAvatar: hit.authorAvatar,
                        channelID: hit.channelId,
                        channelName: hit.channel?.name,
                        channelType: hit.channel?._type,
                        createdAt: hit.createdAt,
                        attachments: (hit.attachments ?? []).compactMap(Self.attachment)
                    )
                }
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func listDrafts(channelID: String?) async throws -> [ChatDraft] {
        try await call {
            switch try await client().listDrafts(query: .init(channelId: channelID)) {
            case let .ok(ok):
                return try ok.body.json.data.map { ChatDraft(id: $0.id, channelID: $0.channelId, content: $0.content, updatedAt: $0.updatedAt) }
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    /// Save a channel's draft: a new one (returns its id), or an update of `draftID`.
    func saveDraft(draftID: String?, channelID: String, content: String) async throws -> String? {
        let body = Components.Schemas.DraftInput(workspaceId: workspace, channelId: channelID, content: content)
        return try await call {
            if let draftID {
                switch try await client().updateDraft(path: .init(draftId: draftID), body: .json(body)) {
                case let .ok(ok):
                    let result = try ok.body.json.data
                    return result.deleted == true ? nil : draftID
                case let .default(status, response):
                    throw APIError(status: status, code: try? response.body.json.error.code)
                }
            }
            switch try await client().createDraft(body: .json(body)) {
            case let .ok(ok):
                let result = try ok.body.json.data
                return result.deleted == true ? nil : result.id
            case let .created(created):
                return try created.body.json.data.id
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func deleteDraft(_ id: String) async throws {
        try await call {
            switch try await client().deleteDraft(path: .init(draftId: id)) {
            case .noContent:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func listBookmarks(limit: Int) async throws -> [ChatBookmark] {
        try await call {
            switch try await client().listBookmarks(query: .init(limit: limit)) {
            case let .ok(ok):
                return try ok.body.json.data.map { row in
                    ChatBookmark(
                        id: row.id,
                        messageID: row.messageId,
                        channelID: row.channelId,
                        note: row.note,
                        createdAt: row.createdAt,
                        messageContent: row.messageContent,
                        messageAuthorName: row.messageAuthorName,
                        messageAuthorAvatar: row.messageAuthorAvatar,
                        channelName: row.channelName,
                        channelType: row.channelType
                    )
                }
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    /// Save a message for later. True when it was already saved.
    func bookmark(messageID: String, channelID: String) async throws -> Bool {
        let body = Components.Schemas.CreateBookmarkInput(messageId: messageID, channelId: channelID)
        return try await call {
            switch try await client().createBookmark(body: .json(body)) {
            case let .ok(ok):
                return try ok.body.json.data.alreadyExists ?? true
            case .created:
                return false
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func deleteBookmark(_ id: String) async throws {
        try await call {
            switch try await client().deleteBookmark(path: .init(bookmarkId: id)) {
            case .noContent:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func presence(of userID: String) async throws -> MemberPresence {
        try await call {
            switch try await client().listMemberStatuses() {
            case let .ok(ok):
                let row = try ok.body.json.data.first { $0.userId == userID }
                return MemberPresence(
                    status: row?.status.flatMap(PresenceStatus.init(rawValue:)) ?? .offline,
                    statusText: row?.statusText.flatMap { $0.isEmpty ? nil : $0 },
                    statusEmoji: row?.statusEmoji.flatMap { $0.isEmpty ? nil : $0 }
                )
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    // MARK: Record chats

    func listRecordChats(type: String?, filter: String, search: String?, cursor: String?, limit: Int) async throws -> Page<RecordChat> {
        try await call {
            switch try await client().listRecordChats(query: .init(_type: type, filter: filter, search: search, cursor: cursor, limit: limit)) {
            case let .ok(ok):
                let body = try ok.body.json
                return Page(items: body.data.map(Self.recordChat), cursor: body.pagination.cursor, hasMore: body.pagination.hasMore)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func recordChatSummary() async throws -> [RecordChatTypeSummary] {
        try await call {
            switch try await client().getRecordChatSummary() {
            case let .ok(ok):
                return try ok.body.json.data.map {
                    RecordChatTypeSummary(type: $0._type, followed: $0.followed, unread: $0.unread, mentions: $0.mentions)
                }
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func setFollowing(entityType: String, entityID: String, following: Bool) async throws {
        try await call {
            if following {
                switch try await client().followRecordChat(path: .init(entityType: entityType, entityId: entityID)) {
                case .ok:
                    return
                case let .default(status, response):
                    throw APIError(status: status, code: try? response.body.json.error.code)
                }
            } else {
                switch try await client().unfollowRecordChat(path: .init(entityType: entityType, entityId: entityID)) {
                case .noContent:
                    return
                case let .default(status, response):
                    throw APIError(status: status, code: try? response.body.json.error.code)
                }
            }
        }
    }

    /// A task's project, for its WeldFlow link. Nil when unknown.
    func recordProjectID(entityType: String, entityID: String) async -> String? {
        try? await call { () async throws -> String? in
            switch try await client().getRecordDetail(path: .init(entityType: entityType, entityId: entityID)) {
            case let .ok(ok):
                return try ok.body.json.data?.projectId
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    // MARK: Team members

    func listTeamMembers() async throws -> [TeamMember] {
        try await call {
            switch try await client().listTeamMembers(query: .init(memberType: "all", limit: 100)) {
            case let .ok(ok):
                return try ok.body.json.data.map { row in
                    TeamMember(
                        id: row.id,
                        userID: row.userId,
                        name: row.name.flatMap { $0.isEmpty ? nil : $0 },
                        email: row.email,
                        picture: row.picture,
                        role: row.role,
                        status: row.status,
                        memberType: row.memberType
                    )
                }
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func memberProfile(_ userID: String) async throws -> MemberProfileInfo {
        try await call {
            switch try await client().getMemberProfile(path: .init(userId: userID)) {
            case let .ok(ok):
                return Self.profile(try ok.body.json.data)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    /// Change one profile field; empty text clears it.
    func updateProfile(_ userID: String, field: ProfileField, value: String) async throws -> MemberProfileInfo {
        var input = Components.Schemas.UpdateMemberProfileInput()
        switch field {
        case .title: input.title = value
        case .bio: input.bio = value
        case .phone: input.phone = value
        case .location: input.location = value
        case .pronouns: input.pronouns = value
        case .hoursPerWeek: input.hoursPerWeek = Double(value.replacingOccurrences(of: ",", with: "."))
        }
        let body = input
        return try await call {
            switch try await client().updateMemberProfile(path: .init(userId: userID), body: .json(body)) {
            case let .ok(ok):
                return Self.profile(try ok.body.json.data)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func memberCommon(_ userID: String) async throws -> CommonConceptsInfo {
        try await call {
            switch try await client().getMemberCommon(path: .init(userId: userID)) {
            case let .ok(ok):
                let data = try ok.body.json.data
                return CommonConceptsInfo(
                    channels: data.channels.map { .init(id: $0.id, name: $0.name, type: $0._type, memberCount: $0.memberCount ?? 0) },
                    projects: data.projects.map { .init(id: $0.id, name: $0.name, status: $0.status) },
                    tasks: data.tasks.map { .init(id: $0.id, title: $0.title, status: $0.status ?? "", role: $0.role ?? "") },
                    // Only opportunities are surfaced from CRM, as on the platform.
                    crm: data.crm.filter { $0.kind == "opportunity" }.map { .init(id: $0.id, kind: $0.kind, name: $0.name, status: $0.status) },
                    helpdesk: data.helpdesk.map { .init(id: $0.id, kind: $0.kind, subject: $0.subject, status: $0.status ?? "") }
                )
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func memberActivity(_ userID: String) async throws -> [MemberActivityEntry] {
        try await call {
            switch try await client().listMemberActivity(path: .init(userId: userID), query: .init(limit: 50)) {
            case let .ok(ok):
                return try ok.body.json.data.map {
                    MemberActivityEntry(
                        id: $0.id,
                        action: $0.action,
                        entityType: $0.entityType,
                        entityID: $0.entityId,
                        description: $0.description,
                        createdAt: $0.createdAt
                    )
                }
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    /// The caller's private note about a member; empty when there is none.
    func memberNote(_ userID: String) async throws -> String {
        try await call {
            switch try await client().getMemberNote(path: .init(userId: userID)) {
            case let .ok(ok):
                return try ok.body.json.data?.body ?? ""
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func saveMemberNote(_ userID: String, body text: String) async throws {
        try await call {
            switch try await client().saveMemberNote(path: .init(userId: userID), body: .json(.init(body: text))) {
            case .ok:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    // MARK: Notifications (Activity)

    /// The Activity tab: the caller's chat activity (mentions, thread replies, missed calls), newest first, as the platform's.
    func listActivity(limit: Int = 50) async throws -> [ActivityNotification] {
        try await call {
            switch try await client().listChatActivity(query: .init(limit: limit)) {
            case let .ok(ok):
                return try ok.body.json.data.map { row in
                    ActivityNotification(
                        id: row.id,
                        title: row.title,
                        body: row.body,
                        category: "weldchat",
                        notificationType: row._type,
                        entityType: nil,
                        entityID: row.messageId,
                        actionURL: row.actionUrl,
                        isRead: row.readAt != nil,
                        createdAt: row.createdAt,
                        actorName: row.actorName,
                        actorAvatar: row.actorAvatarUrl,
                        actorID: row.actorId,
                        channelID: row.channelId,
                        channelName: row.channelName
                    )
                }
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    /// The Activity badge: unread mentions, thread replies and missed calls, as the platform's (not other apps' notifications).
    func unreadActivityCount() async throws -> Int {
        try await call {
            switch try await client().getChatActivityUnreadCount() {
            case let .ok(ok):
                return try ok.body.json.data.count
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    /// Marks one activity item read.
    func markActivityRead(_ id: String) async throws {
        try await call {
            switch try await client().markChatActivityRead(body: .json(.init(notificationId: id))) {
            case .noContent:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    /// Marks every activity item read (other apps' notifications stay unread).
    func markAllActivityRead() async throws {
        try await call {
            switch try await client().markChatActivityRead(body: .json(.init())) {
            case .noContent:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    // MARK: - Mapping

    nonisolated static func channel(_ row: Components.Schemas.Channel) -> ChatChannel {
        ChatChannel(
            id: row.id,
            name: row.name,
            type: row._type,
            description: row.description,
            topic: row.topic,
            isArchived: row.isArchived ?? false,
            threadsEnabled: row.threadsEnabled ?? true,
            memberCount: row.memberCount,
            lastMessageAt: row.lastMessageAt,
            lastMessagePreview: row.lastMessagePreview,
            sectionID: row.sectionId,
            entityType: row.entityType,
            entityID: row.entityId,
            entityDisplayName: row.entityDisplayName,
            isMuted: row.isMuted ?? false,
            lastReadAt: row.lastReadAt,
            hasReadState: row.unreadMentionCount != nil,
            unreadMentionCount: row.unreadMentionCount ?? 0,
            pinnedBy: row.metadata?.pinnedBy ?? [],
            members: (row.members ?? []).map(member)
        )
    }

    nonisolated static func member(_ row: Components.Schemas.ChannelMember) -> ChannelMemberInfo {
        ChannelMemberInfo(
            id: row.id,
            userID: row.userId,
            memberType: row.memberType ?? "user",
            role: row.role,
            isMuted: row.isMuted ?? false,
            name: row.name,
            email: row.email,
            picture: row.picture,
            agentIcon: row.agentIcon
        )
    }

    nonisolated static func attachment(_ row: Components.Schemas.Attachment) -> ChatAttachment? {
        guard let url = row.url, !url.isEmpty else { return nil }
        return ChatAttachment(
            id: row.id ?? url,
            fileName: row.fileName ?? URL(string: url)?.lastPathComponent ?? url,
            fileSize: row.fileSize ?? 0,
            mimeType: row.mimeType ?? "application/octet-stream",
            url: url
        )
    }

    nonisolated static func message(_ row: Components.Schemas.Message) -> ChatMessage {
        let reply = row.metadata?.replyTo.map { ref in
            ReplyReference(
                messageID: ref.messageId,
                rootID: ref.rootId ?? ref.messageId,
                depth: Int(ref.depth ?? 0),
                authorID: ref.authorId ?? "",
                authorName: ref.authorName ?? "",
                authorAvatar: ref.authorAvatar,
                content: ref.content ?? "",
                hasAttachments: ref.hasAttachments ?? false
            )
        }
        let visuals = (row.metadata?.visuals ?? []).compactMap { visual -> AgentVisualRef? in
            guard let kind = visual._type, AgentVisuals.kinds.contains(kind) else { return nil }
            return AgentVisualRef(kind: kind, title: visual.title ?? "")
        }
        return ChatMessage(
            id: row.id,
            channelID: row.channelId,
            authorID: row.authorId,
            authorName: row.authorName,
            authorAvatar: row.authorAvatar,
            authorType: row.authorType,
            content: row.content,
            type: row._type,
            parentID: row.parentId,
            threadReplyCount: row.threadReplyCount ?? 0,
            threadLastReplyAt: row.threadLastReplyAt,
            editedAt: row.editedAt,
            isPinned: row.isPinned ?? false,
            hasAttachments: row.hasAttachments ?? false,
            attachments: (row.attachments ?? []).compactMap(attachment),
            reactions: row.reactions?.additionalProperties ?? [:],
            replyTo: reply,
            visuals: visuals,
            createdAt: row.createdAt
        )
    }

    nonisolated static func dm(_ row: Components.Schemas.DmChannel, currentUserID: String?) -> DmConversation {
        let others = (row.otherMembers ?? []).map { DmPerson(userID: $0.userId, name: $0.name, email: $0.email, picture: $0.picture) }
        return DmLogic.conversation(
            id: row.id,
            type: row._type,
            storedName: row.name,
            otherMembers: others,
            lastMessageAt: row.lastMessageAt,
            lastReadAt: row.lastReadAt,
            pinnedBy: row.metadata?.pinnedBy ?? [],
            currentUserID: currentUserID,
            isMuted: row.isMuted ?? false,
            lastMessagePreview: row.lastMessagePreview,
            isArchived: row.isArchived ?? false
        )
    }

    nonisolated static func recordChat(_ row: Components.Schemas.RecordChat) -> RecordChat {
        RecordChat(
            id: row.id,
            name: row.name,
            entityType: row.entityType,
            entityID: row.entityId,
            entityDisplayName: row.entityDisplayName,
            lastMessageAt: row.lastMessageAt,
            lastMessagePreview: row.lastMessagePreview,
            isFollowing: row.isFollowing,
            isMuted: row.isMuted,
            lastReadAt: row.lastReadAt,
            unreadMentionCount: row.unreadMentionCount
        )
    }

    nonisolated static func profile(_ row: Components.Schemas.MemberProfile) -> MemberProfileInfo {
        var hours: [Weekday: DayHoursInfo] = [:]
        if let week = row.workingHours {
            let days: [(Weekday, Components.Schemas.DayHours?)] = [
                (.monday, week.monday), (.tuesday, week.tuesday), (.wednesday, week.wednesday),
                (.thursday, week.thursday), (.friday, week.friday), (.saturday, week.saturday), (.sunday, week.sunday),
            ]
            for (day, value) in days {
                guard let value else { continue }
                hours[day] = DayHoursInfo(
                    isOpen: value.isOpen ?? false,
                    openTime: value.openTime,
                    closeTime: value.closeTime,
                    breaks: (value.breaks ?? []).map { (start: $0.start ?? "", end: $0.end ?? "") }
                )
            }
        }
        return MemberProfileInfo(
            id: row.id,
            userID: row.userId,
            name: row.name.flatMap { $0.isEmpty ? nil : $0 },
            email: row.email,
            picture: row.picture,
            role: row.role,
            status: row.status,
            title: row.title,
            bio: row.bio,
            phone: row.phone,
            location: row.location,
            pronouns: row.pronouns,
            links: (row.links ?? []).compactMap { link in
                guard let url = link.url, !url.isEmpty else { return nil }
                return ProfileLinkItem(label: link.label ?? url, url: url)
            },
            hoursPerWeek: row.hoursPerWeek,
            workingHours: hours,
            timezone: row.timezone,
            canEdit: row.canEdit
        )
    }
}

/// A change made from a conversation's menu, swipe or header, shown at once.
struct ConversationPatch: Equatable {
    var isMuted: Bool?
    var isPinned: Bool?
    var hasUnread: Bool?
    var archived: Bool?
    var isFollowing: Bool?
}

enum RecordRefreshKind: Equatable {
    case all, summary
}

/// Coalesces the record chat reloads a busy chat's events ask for.
struct RecordRefreshQueue {
    var pending: RecordRefreshKind?
    var running = false
    var scheduled = false

    mutating func request(_ kind: RecordRefreshKind) {
        pending = pending == .all ? .all : kind
    }

    mutating func take() -> RecordRefreshKind? {
        defer { pending = nil }
        return pending
    }
}
