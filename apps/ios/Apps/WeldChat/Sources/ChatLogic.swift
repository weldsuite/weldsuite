import Foundation
import WeldCore

// The rules behind the screens, without the screens: what is unread, how a
// DM is named, which record chats Home shows, how a message's text splits
// into mentions, links and inline files, how call events pair up. Pure, so
// `ChatLogicTests` covers them.

enum ChatLogic {
    /// How many recent conversations Home shows before "See all".
    static let recentDmCount = 5
    /// The bookmark list is fetched with this cap; at the cap the count reads "50+".
    static let savedCap = 50
    /// Replying this deep in a reply chain suggests a thread, as Discord does.
    static let threadSuggestionDepth = 2
    /// Shorter voice messages are dropped: almost always an accidental tap.
    static let minVoiceMessageSeconds: TimeInterval = 1
    /// At most this many pinned messages per channel.
    static let pinLimit = 3
    static let quickEmojis = ["👍", "❤️", "😂", "😮", "🙏", "🔥"]
    static let emojiList = [
        "👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👏",
        "🙌", "💯", "🤔", "👀", "🚀", "✅", "❌", "⭐",
        "💪", "🙏", "😍", "🤣", "😅", "🥳", "🤝", "💡",
        "📌", "🎯", "💬", "📎", "🔗", "⚡", "🏆", "🌟",
    ]

    /// A message since you last read it, or a mention.
    static func isChannelUnread(_ channel: ChatChannel) -> Bool {
        if channel.unreadMentionCount > 0 { return true }
        guard channel.hasReadState, let last = WeldDate.parse(channel.lastMessageAt) else { return false }
        guard let read = WeldDate.parse(channel.lastReadAt) else { return true }
        return last > read
    }

    /// Regular channels by section, as the platform's sidebar: the sections
    /// in their order, then the default group with the unsectioned ones. The
    /// default group is always there while there are no sections (so a new
    /// workspace still sees "Channels" and its "Add channel"), and whenever
    /// a channel has no section (or one that is gone); it is called
    /// `otherName` when a section already has the name "Channels".
    static func groupSections(
        channels: [ChatChannel],
        sections: [ChatSection],
        defaultName: String,
        otherName: String? = nil
    ) -> [ChannelGroup] {
        var groups = sections.map { section in
            ChannelGroup(id: section.id, name: section.name, channels: channels.filter { $0.sectionID == section.id })
        }
        let known = Set(sections.map(\.id))
        let unsectioned = channels.filter { channel in
            guard let section = channel.sectionID else { return true }
            return !known.contains(section)
        }
        if sections.isEmpty || !unsectioned.isEmpty {
            let name = sections.contains(where: { $0.name == "Channels" }) ? (otherName ?? defaultName) : defaultName
            groups.append(ChannelGroup(id: unsectionedID, name: name, channels: unsectioned))
        }
        return groups
    }

    /// Whether `content` mentions `userID`, by name or with @everyone (the platform's highlight).
    static func mentionsUser(_ content: String, userID: String) -> Bool {
        guard !userID.isEmpty else { return false }
        return content.contains("<@\(userID)>") || content.contains("<@\(userID):") || content.contains("<@everyone>")
    }
    struct ChannelGroup: Identifiable, Equatable {
        let id: String
        var name: String
        var channels: [ChatChannel]
    }

    static let unsectionedID = "__unsectioned__"

    /// "12 items", or "50+ items" at the cap.
    static func countLabel(_ count: Int?, cap: Int? = nil, plural: (Int) -> String, capped: (Int) -> String) -> String? {
        guard let count else { return nil }
        if let cap, count >= cap { return capped(cap) }
        return plural(count)
    }

    /// `reactions` with `userID` added to or removed from `emoji`.
    static func withReaction(_ reactions: [String: [String]], emoji: String, userID: String, add: Bool) -> [String: [String]] {
        var next = reactions
        var users = next[emoji] ?? []
        if add {
            if !users.contains(userID) { users.append(userID) }
            next[emoji] = users
        } else {
            users.removeAll { $0 == userID }
            next[emoji] = users.isEmpty ? nil : users
        }
        return next
    }

    /// Reactions with someone in them, in a stable order.
    static func reactionEntries(_ reactions: [String: [String]]) -> [(emoji: String, users: [String])] {
        reactions
            .filter { !$0.value.isEmpty }
            .sorted { $0.key < $1.key }
            .map { (emoji: $0.key, users: $0.value) }
    }

    /// The pinned message the bar shows, cycling through the pins.
    static func pinnedPosition(index: Int, count: Int) -> Int {
        count > 0 ? index % count : 0
    }

    /// "Ann is typing…", "Ann and Bob are typing…", "Ann and 2 others are typing…".
    static func typingLabel(_ userIDs: [String], names: [String: String]) -> String? {
        guard let first = userIDs.first else { return nil }
        let name = names[first] ?? ChatStrings.channelSomeone
        if userIDs.count == 1 {
            return MentionText.isAgentID(first) ? ChatStrings.channelAgentWorking(name: name) : ChatStrings.channelTypingOne(name: name)
        }
        if userIDs.count == 2 {
            let other = names[userIDs[1]] ?? ChatStrings.channelSomeone.lowercased()
            return ChatStrings.channelTypingTwo(name: name, other: other)
        }
        return ChatStrings.channelTypingMany(name: name, count: userIDs.count - 1)
    }

    /// The quote line of a reply: its text in one line, else "Attachment" / "Original message".
    static func replyQuoteText(_ reply: ReplyReference, names: [String: String]) -> String {
        let text = MentionText.plainText(reply.content, names: names)
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        if !text.isEmpty { return text }
        return reply.hasAttachments ? ChatStrings.channelAttachment : ChatStrings.channelOriginalMessage
    }

    /// The author name of an optimistic message: the roster, else the first fallback, else "You".
    static func optimisticAuthorName(userID: String?, names: [String: String], fallbacks: [String?]) -> String {
        if let userID, let name = names[userID], !name.isEmpty { return name }
        return fallbacks.compactMap { $0 }.first { !$0.isEmpty } ?? ChatStrings.channelYou
    }

    /// The web address of a conversation, as the web sidebar links it.
    static func conversationWebURL(origin: URL, channelID: String, isDM: Bool, peerUserID: String?) -> String {
        let base = origin.absoluteString.hasSuffix("/") ? String(origin.absoluteString.dropLast()) : origin.absoluteString
        guard isDM else { return "\(base)/weldchat/\(channelID)" }
        if let peerUserID { return "\(base)/weldchat/dm/\(peerUserID)" }
        return "\(base)/weldchat/dm/group/\(channelID)"
    }

    /// Activity lists WeldChat's notifications only.
    static func isChatNotification(category: String, type: String) -> Bool {
        category == "weldchat" || type.hasPrefix("chat_")
    }

    /// What the Activity tab lists and its badge counts: the server's chat activity feed (`/chat-activity`).
    static let activityTypes = ["chat_mention", "chat_thread_reply", "chat_missed_call"]

    /// Whether a notification belongs on Activity: a mention, a reply in your thread or a missed call (a DM's message shows in the DM).
    static func isActivityItem(category: String, type: String) -> Bool {
        category == "weldchat" && activityTypes.contains(type)
    }

    /// Activity's groups, in the platform's order.
    enum ActivityCategory: CaseIterable {
        case mentions, replies, calls, other
    }

    /// Which group an activity item goes in (the platform's `activityCategory`).
    static func activityCategory(_ type: String) -> ActivityCategory {
        let lower = type.lowercased()
        if lower.contains("mention") { return .mentions }
        if lower.contains("reply") || lower.contains("thread") { return .replies }
        if lower.contains("call") { return .calls }
        return .other
    }

    /// Where a notification's `actionUrl` points: `/weldchat/dm/<id>` or `/weldchat/<id>`.
    static func conversation(fromActionURL url: String?) -> (channelID: String, isDM: Bool)? {
        guard let url else { return nil }
        if let id = firstMatch(#"/weldchat/dm/([^?/#]+)"#, in: url), id != "group" {
            return (id, true)
        }
        if let id = firstMatch(#"/weldchat/dm/group/([^?/#]+)"#, in: url) {
            return (id, true)
        }
        if let id = firstMatch(#"/weldchat/([^?/#]+)"#, in: url) {
            return (id, false)
        }
        return nil
    }

    static func firstMatch(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: text)
        else { return nil }
        return String(text[range])
    }

    /// "65 s" → "1:05".
    static func clock(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds))
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

// MARK: - Direct messages

enum DmLogic {
    /// `mapDm`: name and avatar from the other members, unread from the read
    /// marker, pinned from the channel's `pinnedBy`.
    static func conversation(
        id: String,
        type: String,
        storedName: String,
        otherMembers: [DmPerson],
        lastMessageAt: String?,
        lastReadAt: String?,
        pinnedBy: [String],
        currentUserID: String?,
        isMuted: Bool,
        lastMessagePreview: String?,
        isArchived: Bool
    ) -> DmConversation {
        let others = otherMembers.filter { !$0.userID.isEmpty }
        let isGroup = others.count > 1
        let name: String
        if isGroup {
            let joined = others.map { $0.name ?? $0.email ?? ChatStrings.dmsUnknownMember }.joined(separator: ", ")
            name = joined.isEmpty ? (storedName.isEmpty ? ChatStrings.dmsGroupFallback : storedName) : joined
        } else {
            name = others.first?.name ?? others.first?.email ?? (storedName.isEmpty ? ChatStrings.dmsFallbackName : storedName)
        }
        var hasUnread = false
        if let last = WeldDate.parse(lastMessageAt) {
            if let read = WeldDate.parse(lastReadAt) { hasUnread = last > read } else { hasUnread = true }
        }
        return DmConversation(
            id: id,
            name: name,
            picture: isGroup ? nil : others.first?.picture,
            type: type,
            isGroup: isGroup,
            otherMembers: others,
            isMuted: isMuted,
            isPinned: currentUserID.map { pinnedBy.contains($0) } ?? false,
            hasUnread: hasUnread,
            unreadCount: 0,
            lastMessagePreview: lastMessagePreview,
            lastMessageAt: lastMessageAt,
            isArchived: isArchived
        )
    }

    enum Filter: String, CaseIterable {
        case all, unread, favourites, muted
    }

    /// The chip filter, then pinned first and newest first.
    static func sorted(_ dms: [DmConversation], filter: Filter) -> [DmConversation] {
        let filtered: [DmConversation]
        switch filter {
        case .all: filtered = dms
        case .unread: filtered = dms.filter(\.hasUnread)
        case .favourites: filtered = dms.filter(\.isPinned)
        case .muted: filtered = dms.filter(\.isMuted)
        }
        return filtered.sorted { a, b in
            if a.isPinned != b.isPinned { return a.isPinned }
            return time(a.lastMessageAt) > time(b.lastMessageAt)
        }
    }

    /// Newest first.
    static func recent(_ dms: [DmConversation]) -> [DmConversation] {
        dms.sorted { time($0.lastMessageAt) > time($1.lastMessageAt) }
    }

    static func time(_ text: String?) -> TimeInterval {
        WeldDate.parse(text)?.timeIntervalSince1970 ?? 0
    }
}

// MARK: - Record chats (rules.ts)

/// A change made from a record chat's menu, shown before the server confirms it.
struct RecordChatPatch: Equatable {
    var isMuted: Bool?
    /// `true`: read up to now.
    var markRead = false
    /// `true`: unfollowed, so the chat leaves Home.
    var unfollowed = false
}

struct RecordGroup: Equatable {
    var type: String
    /// The top chats, or under a collapsed header only the unread ones.
    var rows: [RecordChat]
    var followed: Int
    var unread: Int
    var mentions: Int
    var collapsed: Bool
    /// "Show all (N)": the group lists fewer chats than are followed.
    var showAll: Bool
}

enum RecordChatRules {
    /// Record chat types, in sidebar order.
    static let types = ["company", "person", "task", "project", "domain", "sheet", "doc", "board"]
    static let topN = 5
    static let quietAfter: TimeInterval = 30 * 24 * 60 * 60
    static let maxGroupPages = 4

    static func isType(_ type: String?) -> Bool {
        guard let type else { return false }
        return types.contains(type)
    }

    /// A record chat's name: the record's display name, else the channel name.
    static func name(entityDisplayName: String?, name: String?) -> String {
        if let display = entityDisplayName, !display.isEmpty { return display }
        return name ?? ""
    }

    static func hasUnreadMessages(_ row: RecordChat) -> Bool {
        guard let last = WeldDate.parse(row.lastMessageAt) else { return false }
        guard let read = WeldDate.parse(row.lastReadAt) else { return true }
        return last > read
    }

    /// Not muted, with messages after the read marker (the server's `unread`).
    static func isUnread(_ row: RecordChat) -> Bool {
        !row.isMuted && hasUnreadMessages(row)
    }

    static func hasUnreadMentions(_ row: RecordChat) -> Bool {
        row.unreadMentionCount > 0
    }

    static func needsAttention(_ row: RecordChat) -> Bool {
        hasUnreadMentions(row) || isUnread(row)
    }

    /// No message in 30 days (or none) and nothing asking for attention.
    static func isQuiet(_ row: RecordChat, now: Date) -> Bool {
        if needsAttention(row) { return false }
        guard let last = WeldDate.parse(row.lastMessageAt) else { return true }
        return now.timeIntervalSince(last) > quietAfter
    }

    private static func tier(_ row: RecordChat) -> Int {
        if hasUnreadMentions(row) { return 0 }
        if hasUnreadMessages(row) { return 1 }
        return 2
    }

    /// Mentions first, then unread, then the rest; newest first within each.
    static func sorted(_ rows: [RecordChat]) -> [RecordChat] {
        rows.sorted { a, b in
            let (ta, tb) = (tier(a), tier(b))
            if ta != tb { return ta < tb }
            return DmLogic.time(a.lastMessageAt) > DmLogic.time(b.lastMessageAt)
        }
    }

    /// Home's groups: one per type with followed chats that are not all quiet.
    static func groups(
        summary: [RecordChatTypeSummary]?,
        rows: [String: [RecordChat]],
        isCollapsed: (String) -> Bool,
        now: Date
    ) -> [RecordGroup] {
        var groups: [RecordGroup] = []
        for type in types {
            guard let counts = summary?.first(where: { $0.type == type }), counts.followed > 0 else { continue }
            let listed = Array(sorted((rows[type] ?? []).filter { !isQuiet($0, now: now) }).prefix(topN))
            if listed.isEmpty { continue }
            let collapsed = isCollapsed(type)
            groups.append(RecordGroup(
                type: type,
                rows: collapsed ? listed.filter { hasUnreadMentions($0) || hasUnreadMessages($0) } : listed,
                followed: counts.followed,
                unread: counts.unread,
                mentions: counts.mentions,
                collapsed: collapsed,
                showAll: !collapsed && counts.followed > listed.count
            ))
        }
        return groups
    }

    /// Whether the loaded rows hold every unread chat and mention the summary counts.
    static func coversUnread(_ rows: [RecordChat], _ summary: RecordChatTypeSummary) -> Bool {
        let unread = rows.filter(isUnread).count
        let mentions = rows.reduce(0) { $0 + $1.unreadMentionCount }
        return unread >= summary.unread && mentions >= summary.mentions
    }

    /// Rows of several pages, each chat once.
    static func uniqueRows(_ pages: [[RecordChat]]) -> [RecordChat] {
        var seen = Set<String>()
        var out: [RecordChat] = []
        for page in pages {
            for row in page where seen.insert(row.id).inserted {
                out.append(row)
            }
        }
        return out
    }

    /// Types whose followed, unread or mention counts differ.
    static func changedSummaryTypes(_ previous: [RecordChatTypeSummary]?, _ next: [RecordChatTypeSummary]) -> [String] {
        types.filter { type in
            let a = previous?.first { $0.type == type }
            let b = next.first { $0.type == type }
            guard let a, let b else { return (a == nil) != (b == nil) }
            return a.followed != b.followed || a.unread != b.unread || a.mentions != b.mentions
        }
    }

    /// The rows with one chat changed, its type's summary counts moved with it.
    static func patch(
        summary: [RecordChatTypeSummary]?,
        rows: [String: [RecordChat]],
        id: String,
        patch: RecordChatPatch,
        now: Date
    ) -> (summary: [RecordChatTypeSummary]?, rows: [String: [RecordChat]]) {
        guard let type = types.first(where: { type in rows[type]?.contains(where: { row in row.id == id }) == true }),
              let before = rows[type]?.first(where: { row in row.id == id })
        else { return (summary, rows) }
        var after: RecordChat? = before
        if let muted = patch.isMuted { after?.isMuted = muted }
        if patch.markRead {
            after?.lastReadAt = WeldDate.timestampString(now)
            after?.unreadMentionCount = 0
        }
        if patch.unfollowed { after = nil }
        func counts(_ row: RecordChat?) -> (followed: Int, unread: Int, mentions: Int) {
            guard let row else { return (0, 0, 0) }
            return (1, isUnread(row) ? 1 : 0, row.unreadMentionCount)
        }
        let a = counts(before)
        let b = counts(after)
        let nextSummary = summary?.map { entry -> RecordChatTypeSummary in
            guard entry.type == type else { return entry }
            return RecordChatTypeSummary(
                type: entry.type,
                followed: max(0, entry.followed - a.followed + b.followed),
                unread: max(0, entry.unread - a.unread + b.unread),
                mentions: max(0, entry.mentions - a.mentions + b.mentions)
            )
        }
        var nextRows = rows
        if let after {
            nextRows[type] = rows[type]?.map { $0.id == id ? after : $0 }
        } else {
            nextRows[type] = rows[type]?.filter { $0.id != id }
        }
        return (nextSummary, nextRows)
    }

    enum Refresh: Equatable {
        case all, summary, none
    }

    /// What a per-person realtime event means for Home's groups.
    static func refresh(for event: String?, channelID: String?, recordChatIDs: Set<String>, channelIDs: Set<String>) -> Refresh {
        guard let event, !event.isEmpty else { return .summary }
        if event == "channel_new" { return .all }
        if event == "dm_new" { return .none }
        if let channelID, recordChatIDs.contains(channelID) { return .all }
        if let channelID, channelIDs.contains(channelID) { return .none }
        return .summary
    }

    /// The app a record opens in, and its link; nil without one.
    static func appLink(type: String, entityID: String, projectID: String?) -> (app: String, url: URL)? {
        let id = entityID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? entityID
        switch type {
        case "company": return URL(string: "weldcrm://company/\(id)").map { ("WeldCRM", $0) }
        case "person": return URL(string: "weldcrm://person/\(id)").map { ("WeldCRM", $0) }
        case "project": return URL(string: "weldflow://project/\(id)").map { ("WeldFlow", $0) }
        case "task":
            guard let projectID, !projectID.isEmpty else { return nil }
            let project = projectID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? projectID
            return URL(string: "weldflow://task/\(project)/\(id)").map { ("WeldFlow", $0) }
        default:
            return nil
        }
    }

    /// The app name for a type, when it has one.
    static func app(for type: String) -> String? {
        switch type {
        case "company", "person": "WeldCRM"
        case "project", "task": "WeldFlow"
        default: nil
        }
    }

    static func groupLabel(_ type: String) -> String {
        switch type {
        case "company": ChatStrings.recordChatsGroupsCompany
        case "person": ChatStrings.recordChatsGroupsPerson
        case "task": ChatStrings.recordChatsGroupsTask
        case "project": ChatStrings.recordChatsGroupsProject
        case "domain": ChatStrings.recordChatsGroupsDomain
        case "sheet": ChatStrings.recordChatsGroupsSheet
        case "doc": ChatStrings.recordChatsGroupsDoc
        case "board": ChatStrings.recordChatsGroupsBoard
        default: type
        }
    }

    static func typeLabel(_ type: String) -> String {
        switch type {
        case "company": ChatStrings.recordChatsTypesCompany
        case "person": ChatStrings.recordChatsTypesPerson
        case "task": ChatStrings.recordChatsTypesTask
        case "project": ChatStrings.recordChatsTypesProject
        case "domain": ChatStrings.recordChatsTypesDomain
        case "sheet": ChatStrings.recordChatsTypesSheet
        case "doc": ChatStrings.recordChatsTypesDoc
        case "board": ChatStrings.recordChatsTypesBoard
        default: type
        }
    }

    /// The SF Symbol for a record type.
    static func symbol(_ type: String?) -> String {
        switch type {
        case "company": "building.2"
        case "person": "person"
        case "task": "checkmark.square"
        case "project": "briefcase"
        case "domain": "globe"
        case "sheet": "tablecells"
        case "doc": "doc.text"
        case "board": "rectangle.on.rectangle"
        default: "number"
        }
    }
}

// MARK: - Mentions, links and inline files

/// A piece of a message body: text, or one of its attachments placed in it.
enum MessageBlock: Equatable {
    case text(String)
    case file(String)

    var isFile: Bool {
        if case .file = self { return true }
        return false
    }
}

/// A run of message text: plain, a link, or a mention.
enum TextRun: Equatable {
    case plain(String)
    case link(text: String, url: URL)
    case mention(String)
}

enum MentionText {
    private static let tokenPattern = "<@([^>]+)>"

    private static var tokenRegex: NSRegularExpression? {
        try? NSRegularExpression(pattern: tokenPattern)
    }

    /// Whether an id names a WeldAgent workspace agent rather than a person.
    static func isAgentID(_ id: String) -> Bool {
        id.hasPrefix("agt_")
    }

    /// The attachment id of a `<@file:…>` token body, nil for any other.
    static func fileTokenID(_ token: String) -> String? {
        guard token.hasPrefix("file:") else { return nil }
        let id = String(token.dropFirst(5))
        return id.isEmpty ? nil : id
    }

    /// The `<@…>` tokens of `text`: the whole token's range and its body.
    static func tokens(_ text: String) -> [(range: Range<String.Index>, body: String)] {
        guard let regex = tokenRegex else { return [] }
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
            guard let whole = Range(match.range, in: text), let body = Range(match.range(at: 1), in: text) else { return nil }
            return (whole, String(text[body]))
        }
    }

    /// Attachment ids placed inline, in order, without duplicates.
    static func fileTokenIDs(_ text: String) -> [String] {
        var ids: [String] = []
        for token in tokens(text) {
            if let id = fileTokenID(token.body), !ids.contains(id) { ids.append(id) }
        }
        return ids
    }

    /// `text` without its inline file tokens.
    static func stripFileTokens(_ text: String) -> String {
        var out = ""
        var last = text.startIndex
        for token in tokens(text) where fileTokenID(token.body) != nil {
            out += text[last..<token.range.lowerBound]
            last = token.range.upperBound
        }
        out += text[last...]
        return out
    }

    /// The label inside a token: `id|Label`, `id:Label`, or the roster's name.
    static func label(_ token: String, names: [String: String]) -> String {
        if let pipe = token.firstIndex(of: "|") { return String(token[token.index(after: pipe)...]) }
        if let colon = token.firstIndex(of: ":") { return String(token[token.index(after: colon)...]) }
        return names[token] ?? "unknown"
    }

    /// Mentions as `@Name`, inline files dropped (one-line previews).
    static func plainText(_ text: String, names: [String: String]) -> String {
        var out = ""
        var last = text.startIndex
        for token in tokens(text) {
            out += text[last..<token.range.lowerBound]
            if fileTokenID(token.body) == nil { out += "@" + label(token.body, names: names) }
            last = token.range.upperBound
        }
        out += text[last...]
        return out
    }

    /// The body split at its inline file tokens; a token whose attachment
    /// isn't known is dropped, and so are the line breaks around a file.
    static func blocks(_ text: String, attachmentIDs: Set<String>) -> [MessageBlock] {
        var blocks: [MessageBlock] = []
        var pending = ""
        var last = text.startIndex
        func pushText(afterFile: Bool, beforeFile: Bool) {
            var chunk = pending
            if afterFile, let range = chunk.range(of: #"^[^\S\n]*\n"#, options: .regularExpression) {
                chunk.removeSubrange(range)
            }
            if beforeFile, let range = chunk.range(of: #"\n[^\S\n]*$"#, options: .regularExpression) {
                chunk.removeSubrange(range)
            }
            if !chunk.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { blocks.append(.text(chunk)) }
            pending = ""
        }
        for token in tokens(text) {
            guard let id = fileTokenID(token.body) else { continue }
            pending += text[last..<token.range.lowerBound]
            last = token.range.upperBound
            guard attachmentIDs.contains(id) else { continue }
            pushText(afterFile: blocks.last?.isFile ?? false, beforeFile: true)
            blocks.append(.file(id))
        }
        pending += text[last...]
        pushText(afterFile: blocks.last?.isFile ?? false, beforeFile: false)
        return blocks
    }

    /// Text with mentions as badges and web addresses as links.
    static func runs(_ text: String, names: [String: String]) -> [TextRun] {
        var runs: [TextRun] = []
        var last = text.startIndex
        func appendText(_ chunk: Substring) {
            guard !chunk.isEmpty else { return }
            runs.append(contentsOf: LinkText.runs(String(chunk)))
        }
        for token in tokens(text) {
            appendText(text[last..<token.range.lowerBound])
            if fileTokenID(token.body) == nil { runs.append(.mention("@" + label(token.body, names: names))) }
            last = token.range.upperBound
        }
        appendText(text[last...])
        return runs
    }

    /// The `@query` being typed at the end of the text, or nil. `@` must
    /// start the text or follow whitespace, so e-mail addresses don't count.
    static func mentionQuery(_ text: String) -> String? {
        guard let range = text.range(of: #"(?:^|\s)@([^\s@<>]*)$"#, options: .regularExpression) else { return nil }
        let match = String(text[range])
        guard let at = match.firstIndex(of: "@") else { return nil }
        return String(match[match.index(after: at)...])
    }

    /// The trailing `@query` swapped for the member's token.
    static func insertMention(_ text: String, userID: String) -> String {
        guard let range = text.range(of: #"@[^\s@<>]*$"#, options: .regularExpression) else { return text }
        return text.replacingCharacters(in: range, with: "<@\(userID)> ")
    }
}

enum LinkText {
    private static let pattern = #"\b(?:https?://|www\.)[^\s<]*[^\s<.,:;"')\]!?]"#

    /// The web addresses in `text`: where, as written, and what to open.
    static func find(_ text: String) -> [(range: Range<String.Index>, text: String, url: URL)] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else { return [] }
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
            guard let range = Range(match.range, in: text) else { return nil }
            let written = String(text[range])
            let href = written.lowercased().hasPrefix("http") ? written : "https://\(written)"
            guard let url = URL(string: href) else { return nil }
            return (range, written, url)
        }
    }

    static func runs(_ text: String) -> [TextRun] {
        var runs: [TextRun] = []
        var last = text.startIndex
        for link in find(text) {
            if link.range.lowerBound > last { runs.append(.plain(String(text[last..<link.range.lowerBound]))) }
            runs.append(.link(text: link.text, url: link.url))
            last = link.range.upperBound
        }
        if last < text.endIndex { runs.append(.plain(String(text[last...]))) }
        return runs
    }
}

// MARK: - Calls in the conversation

/// A call event the server posts as a `system` message.
enum CallEvent: Equatable {
    case start(isVideo: Bool)
    case ended(isVideo: Bool, duration: String?)
    case missed(isVideo: Bool)
}

/// One call, shown as a single card where it started.
struct CallLogEntry: Equatable {
    enum Outcome: Equatable { case ended, missed }

    var outcome: Outcome?
    var isVideo: Bool
    var duration: String?
    var callerID: String
    var callerName: String
    var callerAvatar: String?
}

enum CallLog {
    static func parse(_ content: String) -> CallEvent? {
        let text = content.lowercased()
        let isVideo = text.contains("video call")
        if text.hasPrefix("missed"), text.hasSuffix("call") { return .missed(isVideo: isVideo) }
        if text.hasPrefix("call ended") {
            let parts = content.components(separatedBy: "—")
            let duration = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : ""
            return .ended(isVideo: isVideo, duration: duration.isEmpty ? nil : duration)
        }
        if text.range(of: #" started an? (voice |video )?call$"#, options: .regularExpression) != nil {
            return .start(isVideo: isVideo)
        }
        return nil
    }

    /// Pair each call's start and end messages (chronological input). The
    /// end folds into its start's card; an end whose start isn't loaded
    /// stands alone.
    static func build(_ chronological: [ChatMessage]) -> (entries: [String: CallLogEntry], folded: Set<String>, openID: String?) {
        var entries: [String: CallLogEntry] = [:]
        var folded = Set<String>()
        var openID: String?
        for message in chronological where message.isSystem {
            guard let event = parse(message.content) else { continue }
            let outcome: CallLogEntry.Outcome
            let isVideo: Bool
            let lasted: String?
            switch event {
            case let .start(video):
                entries[message.id] = CallLogEntry(
                    outcome: nil,
                    isVideo: video,
                    callerID: message.authorID,
                    callerName: message.authorName,
                    callerAvatar: message.authorAvatar
                )
                openID = message.id
                continue
            case let .ended(video, duration):
                outcome = .ended
                isVideo = video
                lasted = duration
            case let .missed(video):
                outcome = .missed
                isVideo = video
                lasted = nil
            }
            if let open = openID, var start = entries[open] {
                start.outcome = outcome
                start.duration = lasted
                entries[open] = start
                folded.insert(message.id)
                openID = nil
            } else {
                entries[message.id] = CallLogEntry(
                    outcome: outcome,
                    isVideo: isVideo,
                    duration: lasted,
                    callerID: message.authorID,
                    callerName: message.authorName,
                    callerAvatar: message.authorAvatar
                )
            }
        }
        return (entries, folded, openID)
    }

    /// "2m 34s" → 154; nil without a duration.
    static func seconds(_ duration: String?) -> Int? {
        var total: Int?
        for part in (duration ?? "").split(separator: " ") {
            guard let unit = part.last, let amount = Int(part.dropLast()) else { continue }
            switch unit {
            case "m": total = (total ?? 0) + amount * 60
            case "s": total = (total ?? 0) + amount
            default: continue
            }
        }
        return total
    }

    /// "a few seconds", "3 minutes", "2 hours".
    static func lasted(_ duration: String?) -> String? {
        guard let seconds = seconds(duration) else { return nil }
        if seconds < 60 { return ChatStrings.channelCallFewSeconds }
        if seconds < 3600 { return ChatStrings.channelCallMinutes(Int((Double(seconds) / 60).rounded())) }
        return ChatStrings.channelCallHours(Int((Double(seconds) / 3600).rounded()))
    }
}

// MARK: - Message layout

enum MessageLayout {
    /// The chronologically previous message is on another day (or there is none).
    static func startsNewDay(_ item: ChatMessage, previous: ChatMessage?, calendar: Calendar = .current) -> Bool {
        guard let previous, let a = item.date, let b = previous.date else { return true }
        return !calendar.isDate(a, inSameDayAs: b)
    }

    /// One author's messages within five minutes collapse to compact rows.
    static func isCompact(_ item: ChatMessage, previous: ChatMessage?) -> Bool {
        guard let previous, !previous.isSystem, previous.authorID == item.authorID,
              item.parentID == nil, item.replyTo == nil,
              let a = item.date, let b = previous.date
        else { return false }
        let gap = a.timeIntervalSince(b)
        return gap >= 0 && gap < 300
    }

    /// Server messages plus the optimistic ones, oldest first, a call's end folded into its start.
    static func chronological(_ messages: [ChatMessage]) -> [ChatMessage] {
        messages.sorted { DmLogic.time($0.createdAt) < DmLogic.time($1.createdAt) }
    }

    /// A refresh of the newest page: older loaded pages stay, optimistic sends
    /// stay until their server copy arrives.
    static func merge(existing: [ChatMessage], fetched: [ChatMessage], pending: [ChatMessage]) -> [ChatMessage] {
        let fetchedIDs = Set(fetched.map(\.id))
        let oldest = fetched.map { DmLogic.time($0.createdAt) }.min() ?? .infinity
        let older = existing.filter { !$0.pending && !fetchedIDs.contains($0.id) && DmLogic.time($0.createdAt) < oldest }
        return older + fetched + pending
    }
}

// MARK: - Dates

enum ChatDates {
    /// The day separator: Today, Yesterday, the weekday this week, then the date.
    static func dayLabel(_ date: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days == 0 { return CoreStrings.commonToday }
        if days == 1 { return CoreStrings.commonYesterday }
        let style: Date.FormatStyle
        if days > 1, days < 7 {
            style = Date.FormatStyle(locale: locale, calendar: calendar).weekday(.wide)
        } else if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            style = Date.FormatStyle(locale: locale, calendar: calendar).weekday(.wide).day().month(.wide)
        } else {
            style = Date.FormatStyle(locale: locale, calendar: calendar).day().month(.wide).year()
        }
        let label = date.formatted(style)
        return label.prefix(1).uppercased() + label.dropFirst()
    }

    /// A list row's time: today the time, yesterday "Yesterday", this week the weekday, else the date.
    static func listTime(_ text: String?, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date = WeldDate.parse(text) else { return "" }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days <= 0 { return date.formatted(date: .omitted, time: .shortened) }
        if days == 1 { return CoreStrings.commonYesterday }
        if days < 7 { return date.formatted(.dateTime.weekday(.wide)) }
        return date.formatted(date: .numeric, time: .omitted)
    }

    enum ActivityGroup: Equatable {
        case today, yesterday, thisWeek, earlierThisMonth
        case month(Date)
    }

    /// Activity's section for a notification.
    static func activityGroup(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> ActivityGroup {
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days <= 0 { return .today }
        if days == 1 { return .yesterday }
        if days < 7 { return .thisWeek }
        if days < 30 { return .earlierThisMonth }
        return .month(date)
    }

    static func activityGroupLabel(_ group: ActivityGroup) -> String {
        switch group {
        case .today: CoreStrings.commonToday
        case .yesterday: CoreStrings.commonYesterday
        case .thisWeek: ChatStrings.activityThisWeek
        case .earlierThisMonth: ChatStrings.activityEarlierThisMonth
        case let .month(date): date.formatted(.dateTime.month(.wide).year())
        }
    }

    /// Activity's short time: now, 5m, 3h, 2d, else the date.
    static func activityTime(_ date: Date, now: Date = Date()) -> String {
        let seconds = now.timeIntervalSince(date)
        let minutes = Int(seconds / 60)
        let hours = Int(seconds / 3600)
        let days = Int(seconds / 86400)
        if minutes < 1 { return ChatStrings.activityNow }
        if minutes < 60 { return ChatStrings.activityMinutesShort(count: minutes) }
        if hours < 24 { return ChatStrings.activityHoursShort(count: hours) }
        if days < 7 { return ChatStrings.activityDaysShort(count: days) }
        return date.formatted(.dateTime.day(.twoDigits).month(.twoDigits))
    }

    /// Drafts: just now, 5m ago, 3h ago, 2d ago, else the date.
    static func draftTime(_ date: Date, now: Date = Date()) -> String {
        let seconds = now.timeIntervalSince(date)
        let minutes = Int(seconds / 60)
        let hours = Int(seconds / 3600)
        let days = Int(seconds / 86400)
        if minutes < 1 { return ChatStrings.draftsJustNow }
        if minutes < 60 { return ChatStrings.draftsMinutesAgo(count: minutes) }
        if hours < 24 { return ChatStrings.draftsHoursAgo(count: hours) }
        if days < 7 { return ChatStrings.draftsDaysAgo(count: days) }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }

    /// A message's time of day.
    static func time(_ date: Date?) -> String {
        date?.formatted(date: .omitted, time: .shortened) ?? ""
    }

    /// When a thread's last reply came in, after its count: the time today, else the day ("21:45", "20 Nov").
    static func lastReply(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return time(date) }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }
}

// MARK: - Search

enum SearchTab: String, CaseIterable, Identifiable {
    case all, people, photos, videos, links, gifs, audio, docs

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: ChatStrings.searchTabsAll
        case .people: ChatStrings.searchTabsPeople
        case .photos: ChatStrings.searchTabsPhotos
        case .videos: ChatStrings.searchTabsVideos
        case .links: ChatStrings.searchTabsLinks
        case .gifs: ChatStrings.searchTabsGifs
        case .audio: ChatStrings.searchTabsAudio
        case .docs: ChatStrings.searchTabsDocs
        }
    }

    var symbol: String? {
        switch self {
        case .all: nil
        case .people: "person.2"
        case .photos: "photo"
        case .videos: "film"
        case .links: "link"
        case .gifs: "face.smiling"
        case .audio: "music.note"
        case .docs: "doc.text"
        }
    }

    /// Whether a message result belongs to this category (attachments, or a URL for links).
    func matches(_ hit: SearchHitItem) -> Bool {
        let types = hit.attachments.map { $0.mimeType.lowercased() }
        switch self {
        case .all, .people: return true
        case .links: return hit.content.range(of: "https?://", options: [.regularExpression, .caseInsensitive]) != nil
        case .photos: return types.contains { $0.hasPrefix("image/") && $0 != "image/gif" }
        case .gifs: return types.contains("image/gif")
        case .videos: return types.contains { $0.hasPrefix("video/") }
        case .audio: return types.contains { $0.hasPrefix("audio/") }
        case .docs:
            return types.contains { !$0.isEmpty && !$0.hasPrefix("image/") && !$0.hasPrefix("video/") && !$0.hasPrefix("audio/") }
        }
    }
}

enum RecentSearches {
    static let limit = 8

    /// The term first, without duplicates, at most `limit`.
    static func adding(_ term: String, to list: [String]) -> [String] {
        let trimmed = term.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return list }
        return Array(([trimmed] + list.filter { $0 != trimmed }).prefix(limit))
    }
}

// MARK: - Channel names

enum ChannelNames {
    /// Slack's limit.
    static let maxLength = 80

    /// Lowercase words joined by dashes, as the platform names channels.
    static func normalize(_ text: String) -> String {
        var name = text.lowercased()
        name = name.replacingOccurrences(of: #"\s+"#, with: "-", options: .regularExpression)
        name = name.replacingOccurrences(of: #"[^a-z0-9_-]"#, with: "", options: .regularExpression)
        name = name.replacingOccurrences(of: #"-{2,}"#, with: "-", options: .regularExpression)
        return String(name.prefix(maxLength))
    }

    /// Without dashes at either end: "-marketing-" is "marketing".
    static func trimDashes(_ name: String) -> String {
        name.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}

// MARK: - Pins

enum PinDuration: String, CaseIterable, Identifiable {
    case day, week, month, forever

    var id: String { rawValue }

    var label: String {
        switch self {
        case .day: ChatStrings.channelPin24h
        case .week: ChatStrings.channelPin7d
        case .month: ChatStrings.channelPin30d
        case .forever: ChatStrings.channelPinAlways
        }
    }

    /// When the pin goes; nil pins for good.
    func expiresAt(from now: Date = Date()) -> Date? {
        switch self {
        case .day: now.addingTimeInterval(24 * 3600)
        case .week: now.addingTimeInterval(7 * 24 * 3600)
        case .month: now.addingTimeInterval(30 * 24 * 3600)
        case .forever: nil
        }
    }
}

// MARK: - Agents

enum AgentVisuals {
    static let kinds: Set<String> = ["chart", "stats", "table", "records"]

    static func line(_ visual: AgentVisualRef) -> String {
        let kind: String
        switch visual.kind {
        case "chart": kind = ChatStrings.channelVisualKindsChart
        case "stats": kind = ChatStrings.channelVisualKindsStats
        case "table": kind = ChatStrings.channelVisualKindsTable
        default: kind = ChatStrings.channelVisualKindsRecords
        }
        return ChatStrings.channelVisualShown(kind: kind, title: visual.title)
    }
}

// MARK: - Members

enum MemberLogic {
    /// "Owner", "Admin", … as the platform's role label.
    static func roleLabel(_ role: String) -> String {
        switch role {
        case "OWNER": ChatStrings.memberRolesOwner
        case "ADMIN": ChatStrings.memberRolesAdmin
        case "MEMBER": ChatStrings.memberRolesMember
        case "VIEWER": ChatStrings.memberRolesViewer
        default: role.hasPrefix("role_") ? ChatStrings.memberRolesCustom : ChatStrings.memberRolesMember
        }
    }

    static func weekdayLabel(_ day: Weekday) -> String {
        switch day {
        case .monday: ChatStrings.memberWeekdaysMonday
        case .tuesday: ChatStrings.memberWeekdaysTuesday
        case .wednesday: ChatStrings.memberWeekdaysWednesday
        case .thursday: ChatStrings.memberWeekdaysThursday
        case .friday: ChatStrings.memberWeekdaysFriday
        case .saturday: ChatStrings.memberWeekdaysSaturday
        case .sunday: ChatStrings.memberWeekdaysSunday
        }
    }

    /// The local time in a timezone, "14:05"; a dash for an unknown zone.
    static func localTime(_ now: Date, timezone: String) -> String {
        guard let zone = TimeZone(identifier: timezone) else { return "—" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: now)
    }

    /// "GMT+1" for a timezone.
    static func offset(_ now: Date, timezone: String) -> String {
        guard let zone = TimeZone(identifier: timezone) else { return "" }
        let seconds = zone.secondsFromGMT(for: now)
        if seconds == 0 { return "GMT" }
        let hours = seconds / 3600
        let minutes = abs(seconds % 3600) / 60
        return minutes == 0 ? String(format: "GMT%+d", hours) : String(format: "GMT%+d:%02d", hours, minutes)
    }

    /// Hours per week as the API takes it; nil for something that isn't a number.
    static func parseHours(_ text: String) -> Double? {
        Double(text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: "."))
    }

    /// `created 'Q3 plan'` → "Q3 plan".
    static func quotedName(_ description: String) -> String? {
        ChatLogic.firstMatch(#"'([^']+)'"#, in: description) ?? ChatLogic.firstMatch(#""([^"]+)""#, in: description)
    }

    /// `project_task` → "Task"; `statusChanged` → "Status changed".
    static func sentenceCase(_ raw: String) -> String {
        var words = raw.replacingOccurrences(of: #"([a-z0-9])([A-Z])"#, with: "$1 $2", options: .regularExpression)
        words = words.replacingOccurrences(of: "[_-]", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
            .lowercased()
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    static func entityTypeLabel(_ entityType: String) -> String {
        let last = entityType.lowercased().split(whereSeparator: { $0 == "_" || $0 == "-" }).last.map(String.init) ?? entityType
        return sentenceCase(last)
    }

    static func actionLabel(_ action: String) -> String {
        switch action {
        case "created": ChatStrings.memberActivityActionsCreated
        case "updated": ChatStrings.memberActivityActionsUpdated
        case "deleted": ChatStrings.memberActivityActionsDeleted
        case "archived": ChatStrings.memberActivityActionsArchived
        case "status_changed": ChatStrings.memberActivityActionsStatusChanged
        case "assigned": ChatStrings.memberActivityActionsAssigned
        case "escalated": ChatStrings.memberActivityActionsEscalated
        case "priority_changed": ChatStrings.memberActivityActionsPriorityChanged
        case "added": ChatStrings.memberActivityActionsAdded
        case "removed": ChatStrings.memberActivityActionsRemoved
        default: sentenceCase(action).lowercased()
        }
    }

    /// One record of a timeline event: named records get a card each.
    struct RecordCard: Equatable, Identifiable {
        var id: String
        var title: String
        var recordCount: Int
        var entryCount: Int
        var named: Bool
    }

    /// "Ann created 4 × Project": entries grouped by action and record type.
    struct TimelineEvent: Equatable, Identifiable {
        var id: String
        var action: String
        var entityType: String
        var cards: [RecordCard]
        var latest: MemberActivityEntry
        var recordCount: Int
        var entryCount: Int
    }

    struct Day: Equatable, Identifiable {
        var id: String
        var date: Date
        var events: [TimelineEvent]
    }

    /// The days of a member's activity, newest first, each a list of events.
    static func timeline(_ entries: [MemberActivityEntry], calendar: Calendar = .current) -> [Day] {
        var names: [String: String] = [:]
        for entry in entries {
            if names[entry.entityID] == nil, let name = quotedName(entry.description) { names[entry.entityID] = name }
        }
        var byDay: [String: (date: Date, entries: [MemberActivityEntry])] = [:]
        var order: [String] = []
        for entry in entries {
            guard let date = WeldDate.parse(entry.createdAt) else { continue }
            let key = WeldDate.dayString(calendar.startOfDay(for: date))
            if byDay[key] == nil {
                byDay[key] = (date, [])
                order.append(key)
            }
            byDay[key]?.entries.append(entry)
        }
        return order.compactMap { key -> Day? in
            guard let bucket = byDay[key] else { return nil }
            return Day(id: key, date: bucket.date, events: events(bucket.entries, names: names))
        }
        .sorted { $0.date > $1.date }
    }

    static func events(_ entries: [MemberActivityEntry], names: [String: String]) -> [TimelineEvent] {
        var events: [TimelineEvent] = []
        var cardIDs: [String: [String: Set<String>]] = [:]
        var eventIDs: [String: Set<String>] = [:]
        for entry in entries {
            let key = "\(entry.action):\(entry.entityType)"
            if !events.contains(where: { $0.id == key }) {
                events.append(TimelineEvent(id: key, action: entry.action, entityType: entry.entityType, cards: [], latest: entry, recordCount: 0, entryCount: 0))
            }
            guard let index = events.firstIndex(where: { $0.id == key }) else { continue }
            let name = names[entry.entityID]
            let cardKey = name == nil ? "unnamed" : entry.entityID
            if !events[index].cards.contains(where: { $0.id == cardKey }) {
                events[index].cards.append(RecordCard(
                    id: cardKey,
                    title: name ?? entityTypeLabel(entry.entityType),
                    recordCount: 0,
                    entryCount: 0,
                    named: name != nil
                ))
            }
            cardIDs[key, default: [:]][cardKey, default: []].insert(entry.entityID)
            eventIDs[key, default: []].insert(entry.entityID)
            if let card = events[index].cards.firstIndex(where: { $0.id == cardKey }) {
                events[index].cards[card].entryCount += 1
                events[index].cards[card].recordCount = cardIDs[key]?[cardKey]?.count ?? 0
            }
            events[index].recordCount = eventIDs[key]?.count ?? 0
            events[index].entryCount += 1
        }
        return events
    }

    /// The presence dot's colour, as the platform's status dot.
    static func presenceHex(_ status: PresenceStatus) -> UInt32 {
        switch status {
        case .online: 0x22C55E
        case .busy: 0xF97316
        case .dnd: 0xEF4444
        case .away: 0xEAB308
        case .offline: 0x9CA3AF
        }
    }
}

// MARK: - Push

/// Where a tapped notification leads (`NotificationContext`).
enum PushRoute: Equatable {
    case incomingCall
    case conversation(channelID: String, isDM: Bool)
    case none

    static func of(_ values: [String: String]) -> PushRoute {
        let type = values["notificationType"]
        if type == "chat_incoming_call" || type == "chat_call_ring" { return .incomingCall }
        if type == "push_test" { return .none }
        let fromURL = ChatLogic.conversation(fromActionURL: values["actionUrl"])
        if type == "chat_missed_call" {
            guard let fromURL else { return .none }
            return .conversation(channelID: fromURL.channelID, isDM: true)
        }
        let channelID = values["chatChannelId"].flatMap { $0.isEmpty ? nil : $0 }
            ?? values["channelId"].flatMap { $0.isEmpty ? nil : $0 }
            ?? fromURL?.channelID
        guard let channelID else { return .none }
        let isDM = values["actionUrl"]?.contains("/dm/") ?? false
        return .conversation(channelID: channelID, isDM: isDM)
    }
}

/// `weldchat://…` links, as the Expo app's router answered them.
enum DeepLink: Equatable {
    case channel(String)
    case dm(String)
    case user(String)
    case thread(messageID: String, channelID: String)
    case search, records, drafts, saved, settings

    static func parse(_ url: URL) -> DeepLink? {
        guard url.scheme == "weldchat", let host = url.host else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        let first = parts.first
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        switch host {
        case "channel": return first.map(DeepLink.channel)
        case "dm": return first.map(DeepLink.dm)
        case "user": return first.map(DeepLink.user)
        case "thread":
            guard let first, let channel = query.first(where: { $0.name == "channelId" })?.value else { return nil }
            return .thread(messageID: first, channelID: channel)
        case "search": return .search
        case "records": return .records
        case "drafts": return .drafts
        case "later": return .saved
        case "settings": return .settings
        default: return nil
        }
    }
}

// MARK: - Voice messages

enum Waveform {
    static let barCount = 33

    /// `31 * h + code`, wrapped to 32 bits, as the Expo app hashes the URL.
    static func hash(_ text: String) -> Int32 {
        var h: Int32 = 0
        for scalar in text.unicodeScalars {
            h = h &* 31 &+ Int32(truncatingIfNeeded: scalar.value)
        }
        return h
    }

    /// Bar heights (0.25…1) from a seed, the same every time for one message.
    static func bars(seed: Int32, count: Int = barCount) -> [Double] {
        var s = UInt32(bitPattern: seed)
        if s == 0 { s = 1 }
        var out: [Double] = []
        for i in 0..<count {
            s ^= s << 13
            s ^= s >> 17
            s ^= s << 5
            let v = Double(s % 1000) / 1000
            let envelope = 0.5 + 0.5 * sin(Double(i) / Double(count) * .pi)
            out.append(0.25 + 0.75 * v * envelope)
        }
        return out
    }
}
