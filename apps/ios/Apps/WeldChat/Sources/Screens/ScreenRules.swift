import Foundation
import WeldCore

// The rules of the list and create screens (drafts, saved, record chats,
// search, a member, new channel / DM / message), without the screens. Pure,
// so `ScreenRulesTests` covers them.

// MARK: - Drafts and saved

/// A draft as the Drafts screen lists it, with its conversation's name.
struct DraftItem: Identifiable, Equatable {
    let id: String
    var channelID: String
    var channelName: String
    var isDM: Bool
    var content: String
    var updatedAt: String
}

enum SavedRules {
    /// The conversation a draft or a saved message is in: `#name` for a
    /// channel, the name for a DM.
    static func conversationLabel(name: String, isDM: Bool) -> String {
        isDM ? name : "#\(name)"
    }

    /// Newest first.
    static func sortedDrafts(_ drafts: [DraftItem]) -> [DraftItem] {
        drafts.sorted { DmLogic.time($0.updatedAt) > DmLogic.time($1.updatedAt) }
    }

    /// A draft's conversation, from what the app already has: a DM's
    /// display name, or a channel's name and type. Nil when neither list has it.
    static func knownConversation(_ channelID: String, dms: [DmConversation], channels: [ChatChannel]) -> (name: String, isDM: Bool)? {
        if let dm = dms.first(where: { $0.id == channelID }) { return (dm.name, true) }
        if let channel = channels.first(where: { $0.id == channelID }) { return (channel.name, channel.isDM) }
        return nil
    }

    /// A saved message's conversation name: a DM goes by its people, as the
    /// DM list names it; else the bookmark's own channel name.
    static func bookmarkConversation(_ bookmark: ChatBookmark, dms: [DmConversation]) -> String {
        if bookmark.channelType == "dm", let dm = dms.first(where: { $0.id == bookmark.channelID }) { return dm.name }
        if let name = bookmark.channelName, !name.isEmpty { return name }
        return ChatStrings.savedUnknownChannel
    }

    /// The saved message's text in one preview: mentions as names, files dropped.
    static func bookmarkText(_ bookmark: ChatBookmark, names: [String: String]) -> String {
        guard let content = bookmark.messageContent else { return ChatStrings.savedUnavailable }
        return MentionText.plainText(content, names: names).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - Record chats

enum RecordsFilter: String, CaseIterable, Identifiable {
    case following, unread, mentions, all

    var id: String { rawValue }

    var label: String {
        switch self {
        case .following: ChatStrings.recordChatsFiltersFollowing
        case .unread: ChatStrings.recordChatsFiltersUnread
        case .mentions: ChatStrings.recordChatsFiltersMentions
        case .all: ChatStrings.recordChatsFiltersAll
        }
    }
}

enum RecordsRules {
    static let pageSize = 25

    /// What the empty list says: the search, else the filter.
    static func emptyText(filter: RecordsFilter, search: String) -> String {
        if !search.isEmpty { return ChatStrings.recordChatsEmptySearch(query: search) }
        switch filter {
        case .following: return ChatStrings.recordChatsEmptyFollowing
        case .unread: return ChatStrings.recordChatsEmptyUnread
        case .mentions: return ChatStrings.recordChatsEmptyMentions
        case .all: return ChatStrings.recordChatsEmptyAll
        }
    }

    /// The type a link or Home's "Show all" asks for, when it is one.
    static func initialType(_ type: String?) -> String? {
        RecordChatRules.isType(type) ? type : nil
    }

    /// A change from a row's menu or swipe, shown at once. Unfollowing drops
    /// the row unless the filter is All (only All lists chats you don't follow).
    static func apply(_ patch: ConversationPatch, to rows: [RecordChat], id: String, filter: RecordsFilter, now: Date) -> [RecordChat] {
        rows.compactMap { row -> RecordChat? in
            guard row.id == id else { return row }
            var next = row
            if let muted = patch.isMuted { next.isMuted = muted }
            if patch.hasUnread == false {
                next.lastReadAt = WeldDate.timestampString(now)
                next.unreadMentionCount = 0
            }
            if let following = patch.isFollowing {
                next.isFollowing = following
                if !following, filter != .all { return nil }
            }
            return next
        }
    }

    /// A change that needs the server's list: undoing a mark-read, or a
    /// follow put back on a row that already left the list.
    static func needsReload(_ patch: ConversationPatch, rowListed: Bool) -> Bool {
        patch.hasUnread == true || (patch.isFollowing == true && !rowListed)
    }

    /// Bold when followed and asking for attention.
    static func isHighlighted(_ chat: RecordChat) -> Bool {
        chat.isFollowing && (RecordChatRules.isUnread(chat) || RecordChatRules.hasUnreadMentions(chat))
    }

    /// The row's second line: the preview, after the record's type when the
    /// list shows every type.
    static func subtitle(_ chat: RecordChat, showType: Bool) -> String {
        let preview = chat.lastMessagePreview.flatMap { $0.isEmpty ? nil : $0 } ?? ChatStrings.recordChatsNoMessages
        guard showType, RecordChatRules.isType(chat.entityType) else { return preview }
        return ChatStrings.recordChatsTypeAndPreview(type: RecordChatRules.typeLabel(chat.entityType), preview: preview)
    }

    /// Whether a personal event is about the list: a new chat, or one it shows.
    static func isRelevant(event: String, channelID: String?, rows: [RecordChat]) -> Bool {
        if event == "channel_new" { return true }
        guard let channelID else { return false }
        return rows.contains { $0.id == channelID }
    }
}

// MARK: - Search

enum SearchRules {
    /// People whose name or e-mail holds the text, case-insensitively.
    static func people(_ roster: [TeamMember], matching text: String) -> [TeamMember] {
        let needle = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return [] }
        return roster.filter { member in
            (member.name?.lowercased().contains(needle) ?? false) || (member.email?.lowercased().contains(needle) ?? false)
        }
    }

    /// The results a tab shows: People has none, the rest filter the messages.
    static func results(_ hits: [SearchHitItem], tab: SearchTab) -> [SearchHitItem] {
        tab == .people ? [] : hits.filter { tab.matches($0) }
    }

    /// The attachment line of a result: the first file's name, else its type.
    static func attachmentLabel(_ hit: SearchHitItem) -> String? {
        guard let first = hit.attachments.first else { return nil }
        if !first.fileName.isEmpty { return first.fileName }
        return first.mimeType.isEmpty ? ChatStrings.channelAttachment : first.mimeType
    }
}

// MARK: - A member

enum MemberScreenRules {
    enum LoadState: Equatable {
        case loading, ready, notFound, failed
    }

    /// The header: the person's name, or what went wrong loading them.
    static func headerName(profile: MemberProfileInfo?, state: LoadState) -> String {
        if let profile {
            if let name = profile.name, !name.isEmpty { return name }
            if let email = profile.email, !email.isEmpty { return email }
            return ChatStrings.memberFallbackName
        }
        switch state {
        case .notFound: return ChatStrings.memberNotFoundTitle
        case .failed: return ChatStrings.memberProfileLoadFailedTitle
        case .loading, .ready: return ""
        }
    }

    /// The custom status under the name: emoji and text, when either is set.
    static func customStatus(_ presence: MemberPresence?) -> String? {
        guard let presence, presence.statusText != nil || presence.statusEmoji != nil else { return nil }
        let text = "\(presence.statusEmoji ?? "") \(presence.statusText ?? "")".trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : text
    }

    /// Nothing is "in common" with yourself, so that tab is left out.
    static func tabs(isSelf: Bool) -> [MemberTab] {
        isSelf ? [.overview, .activity] : [.overview, .common, .activity]
    }

    /// The week, when at least one day is a working day.
    static func schedule(_ hours: [Weekday: DayHoursInfo]) -> [(day: Weekday, hours: DayHoursInfo?)]? {
        guard Weekday.allCases.contains(where: { hours[$0]?.isOpen == true }) else { return nil }
        return Weekday.allCases.map { (day: $0, hours: hours[$0]) }
    }

    /// "09:00 – 17:00  (1 break 12:00–12:30)", or "Not working".
    static func dayHours(_ hours: DayHoursInfo?) -> String {
        guard let hours, hours.isOpen else { return ChatStrings.memberNotWorking }
        let range = ChatStrings.memberHoursRange(open: hours.openTime ?? "—", close: hours.closeTime ?? "—")
        guard !hours.breaks.isEmpty else { return range }
        let breaks = hours.breaks.map { "\($0.start)–\($0.end)" }.joined(separator: ", ")
        return "\(range)  (\(ChatStrings.memberBreaks(hours.breaks.count)) \(breaks))"
    }

    /// The edited value as the API takes it, nil when nothing changed.
    static func commit(_ draft: String, previous: String?) -> String? {
        let next = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return next == (previous ?? "").trimmingCharacters(in: .whitespacesAndNewlines) ? nil : next
    }

    /// "in progress" → "In Progress", as the platform's hints read.
    static func capitalizeWords(_ text: String) -> String {
        var out = ""
        var atWordStart = true
        for character in text {
            let isWordCharacter = character.isLetter || character.isNumber || character == "_"
            if atWordStart, isWordCharacter {
                out += character.uppercased()
            } else {
                out.append(character)
            }
            atWordStart = !isWordCharacter
        }
        return out
    }

    /// A task's hint: its status, and "delegated" when it is.
    static func taskHint(_ task: CommonConceptsInfo.Task) -> String {
        task.role == "delegated" ? ChatStrings.memberCommonDelegated(status: task.status) : task.status
    }

    /// A shared conversation's name: `# name` for a channel, the name for a DM.
    static func commonChannelLabel(_ channel: CommonConceptsInfo.Channel) -> String {
        channel.type == "dm" ? channel.name : "# \(channel.name)"
    }

    static func commonCount(_ info: CommonConceptsInfo) -> Int {
        info.channels.count + info.projects.count + info.tasks.count + info.crm.count + info.helpdesk.count
    }

    /// A timeline day: Today, Yesterday, else "Monday, March 2".
    static func dayLabel(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return CoreStrings.commonToday }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return CoreStrings.commonYesterday
        }
        return date.formatted(.dateTime.weekday(.wide).month(.wide).day())
    }

    /// An event's time: "just now", "5 min ago", "3h ago" today, else "14:05".
    static func eventTime(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard calendar.isDate(date, inSameDayAs: now) else {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = calendar.timeZone
            formatter.dateFormat = "HH:mm"
            return formatter.string(from: date)
        }
        let minutes = Int(now.timeIntervalSince(date) / 60)
        if minutes < 1 { return ChatStrings.memberActivityJustNow }
        if minutes < 60 { return ChatStrings.memberActivityMinutesAgo(count: minutes) }
        return ChatStrings.memberActivityHoursAgo(count: minutes / 60)
    }

    /// "Ann created 4 × Project", or without the name.
    static func sentence(_ event: MemberLogic.TimelineEvent, memberName: String?) -> String {
        let type = MemberLogic.entityTypeLabel(event.entityType)
        let what = event.recordCount > 1 ? ChatStrings.memberActivityMany(count: event.recordCount, type: type) : type
        let action = MemberLogic.actionLabel(event.action).lowercased()
        if let memberName, !memberName.isEmpty {
            return ChatStrings.memberActivitySentence(who: memberName, action: action, what: what)
        }
        return ChatStrings.memberActivitySentenceNoName(action: action, what: what)
    }

    /// The record cards worth showing: the named ones (an unnamed card would
    /// only repeat the sentence, and the app has no changed fields to add).
    static func cards(_ event: MemberLogic.TimelineEvent) -> [MemberLogic.RecordCard] {
        event.cards.filter(\.named)
    }

    /// "×N" after the sentence: the same records touched more than once, with no card to say so.
    static func eventRepeats(_ event: MemberLogic.TimelineEvent) -> Int? {
        guard cards(event).isEmpty, event.entryCount > event.recordCount else { return nil }
        return event.entryCount
    }

    /// The chip on a card: several records, or one record touched several times.
    static func cardCount(_ card: MemberLogic.RecordCard) -> Int? {
        if card.recordCount > 1 { return card.recordCount }
        let repeats = card.entryCount / max(card.recordCount, 1)
        return repeats > 1 ? repeats : nil
    }

    /// The SF Symbol for a timeline record type, matched on a keyword
    /// (`project_task` is a task, so the generic project match comes last).
    static func entitySymbol(_ entityType: String) -> String {
        let key = entityType.lowercased()
        let table: [([String], String)] = [
            (["task", "checklist"], "checkmark.square"),
            (["label", "tag"], "tag"),
            (["member", "user", "person", "contact", "customer"], "person"),
            (["company", "account", "organization"], "building.2"),
            (["deal", "opportunity", "lead"], "briefcase"),
            (["ticket", "conversation"], "ticket"),
            (["email", "message"], "envelope"),
            (["meeting", "session", "event"], "calendar"),
            (["page", "document", "note"], "doc.text"),
            (["order"], "cart"),
            (["product"], "shippingbox"),
            (["project"], "folder"),
        ]
        return table.first { keywords, _ in keywords.contains { key.contains($0) } }?.1 ?? "cube"
    }

    static let noteLimit = 1500
}

enum MemberTab: String, CaseIterable, Identifiable {
    case overview, common, activity

    var id: String { rawValue }

    var label: String {
        switch self {
        case .overview: ChatStrings.memberTabsOverview
        case .common: ChatStrings.memberTabsCommon
        case .activity: ChatStrings.memberTabsActivity
        }
    }

    var symbol: String {
        switch self {
        case .overview: "chart.bar.doc.horizontal"
        case .common: "person.2"
        case .activity: "waveform.path.ecg"
        }
    }
}

// MARK: - New channel, new DM

enum NewChannelRules {
    /// Step 0 the name, 1 public or private and the category, 2 the people of a private channel.
    static func lastStep(isPrivate: Bool) -> Int {
        isPrivate ? 2 : 1
    }

    /// The name sent: without dashes at either end.
    static func finalName(_ name: String) -> String {
        ChannelNames.trimDashes(name)
    }

    static func canContinue(step: Int, name: String, creating: Bool) -> Bool {
        step == 0 ? !finalName(name).isEmpty : !creating
    }

    /// Next, then Create, or "Create (3)" with people picked for a private channel.
    static func primaryLabel(step: Int, isPrivate: Bool, selectedCount: Int) -> String {
        guard step == lastStep(isPrivate: isPrivate) else { return ChatStrings.newChannelNext }
        return isPrivate && selectedCount > 0 ? ChatStrings.newChannelCreateWithCount(count: selectedCount) : ChatStrings.newChannelCreate
    }

    static func title(step: Int) -> String {
        switch step {
        case 1: ChatStrings.newChannelVisibilityLabel
        case 2: ChatStrings.newChannelPeopleTitle
        default: ChatStrings.newChannelTitle
        }
    }

    /// Everyone but the caller, matched on name or e-mail.
    static func people(_ roster: [TeamMember], selfID: String, query: String) -> [TeamMember] {
        let others = roster.filter { $0.userID != selfID }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return others }
        return others.filter { ($0.name?.lowercased().contains(needle) ?? false) || ($0.email?.lowercased().contains(needle) ?? false) }
    }

    /// A name that is taken comes back as 409: the name has to change.
    static func isNameTaken(_ error: Error) -> Bool {
        (error as? APIError)?.status == 409
    }
}

enum NewDmRules {
    /// A group needs at least two people.
    static func minimum(isGroup: Bool) -> Int {
        isGroup ? 2 : 1
    }

    /// Everyone but the caller and invitees who haven't joined (chat-api
    /// refuses a DM before then), matched on name or e-mail.
    static func people(_ roster: [TeamMember], selfID: String, query: String) -> [TeamMember] {
        let others = roster.filter { $0.userID != selfID && !$0.isPendingInvitee }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return others }
        return others.filter { ($0.name?.lowercased().contains(needle) ?? false) || ($0.email?.lowercased().contains(needle) ?? false) }
    }

    static func startLabel(selectedCount: Int) -> String {
        selectedCount > 1 ? ChatStrings.newMessageStartWithCount(count: selectedCount) : ChatStrings.newMessageStart
    }

    static func toggled(_ selected: [String], _ userID: String) -> [String] {
        selected.contains(userID) ? selected.filter { $0 != userID } : selected + [userID]
    }
}

// MARK: - New message

/// Who a new message goes to: a channel, an existing (group) DM, or a person.
enum MessageRecipient: Equatable, Identifiable {
    case channel(id: String, name: String, isPrivate: Bool)
    case dm(id: String, name: String, people: [DmPerson])
    case person(userID: String, name: String, picture: String?)

    var id: String {
        switch self {
        case let .channel(id, _, _): "channel:\(id)"
        case let .dm(id, _, _): "dm:\(id)"
        case let .person(userID, _, _): "p:\(userID)"
        }
    }

    var name: String {
        switch self {
        case let .channel(_, name, _): name
        case let .dm(_, name, _): name
        case let .person(_, name, _): name
        }
    }

    /// How the chip and the row read it: `#name` for a channel.
    var label: String {
        if case let .channel(_, name, _) = self { return "#\(name)" }
        return name
    }
}

enum NewMessageRules {
    static let recentCount = 10
    static let resultCount = 20

    static func recipient(_ channel: ChatChannel) -> MessageRecipient {
        .channel(id: channel.id, name: channel.name, isPrivate: channel.isPrivate)
    }

    static func recipient(_ member: TeamMember) -> MessageRecipient {
        .person(userID: member.userID, name: member.name ?? member.email ?? "?", picture: member.picture)
    }

    /// A 1:1 DM is its person; a group DM stays a conversation.
    static func recipient(_ dm: DmConversation) -> MessageRecipient {
        if !dm.isGroup, let peer = dm.otherMembers.first {
            return .person(userID: peer.userID, name: peer.name ?? peer.email ?? dm.name, picture: peer.picture)
        }
        return .dm(id: dm.id, name: dm.name, people: dm.otherMembers)
    }

    /// The latest conversations, DMs and channels together.
    static func recent(channels: [ChatChannel], dms: [DmConversation]) -> [MessageRecipient] {
        var items: [(at: TimeInterval, recipient: MessageRecipient)] = []
        for dm in dms {
            items.append((at: DmLogic.time(dm.lastMessageAt), recipient: recipient(dm)))
        }
        for channel in channels {
            items.append((at: DmLogic.time(channel.lastMessageAt), recipient: recipient(channel)))
        }
        // Stable: equal times keep DMs before channels, as listed.
        let ordered = items.enumerated().sorted { a, b in
            a.element.at != b.element.at ? a.element.at > b.element.at : a.offset < b.offset
        }
        return ordered.prefix(recentCount).map { $0.element.recipient }
    }

    /// The query without a leading `#` or `@`, lowercased.
    static func term(_ query: String) -> String {
        var text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if let first = text.first, first == "#" || first == "@" { text.removeFirst() }
        return text.lowercased()
    }

    /// Searching: the people that match. Otherwise everyone not already in
    /// Recent, by name. Never the caller or an invitee who hasn't joined.
    static func people(_ roster: [TeamMember], selfID: String, query: String, recent: [MessageRecipient]) -> [MessageRecipient] {
        let others = roster.filter { $0.userID != selfID && !$0.isPendingInvitee }
        let needle = term(query)
        if !needle.isEmpty {
            return Array(others
                .filter { ($0.name?.lowercased().contains(needle) ?? false) || ($0.email?.lowercased().contains(needle) ?? false) }
                .prefix(resultCount)
                .map(recipient))
        }
        let inRecent = Set(recent.map(\.id))
        return others.map(recipient)
            .filter { !inRecent.contains($0.id) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /// Searching: the channels that match (none for an `@` search). Otherwise
    /// every channel not already in Recent, by name.
    static func channels(_ channels: [ChatChannel], query: String, recent: [MessageRecipient]) -> [MessageRecipient] {
        let needle = term(query)
        if !needle.isEmpty {
            if query.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("@") { return [] }
            return Array(channels.filter { $0.name.lowercased().contains(needle) }.prefix(resultCount).map(recipient))
        }
        let inRecent = Set(recent.map(\.id))
        return channels.map(recipient)
            .filter { !inRecent.contains($0.id) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /// Tapping a recipient again takes it out.
    static func toggled(_ list: [MessageRecipient], _ recipient: MessageRecipient) -> [MessageRecipient] {
        list.contains { $0.id == recipient.id } ? list.filter { $0.id != recipient.id } : list + [recipient]
    }

    /// Where the message goes: each channel and conversation, and one DM for
    /// all the people picked.
    static func split(_ recipients: [MessageRecipient]) -> (conversations: [(id: String, isDM: Bool, key: String)], people: [String]) {
        var conversations: [(id: String, isDM: Bool, key: String)] = []
        var people: [String] = []
        for recipient in recipients {
            switch recipient {
            case let .channel(id, _, _): conversations.append((id: id, isDM: false, key: recipient.id))
            case let .dm(id, _, _): conversations.append((id: id, isDM: true, key: recipient.id))
            case let .person(userID, _, _): people.append(userID)
            }
        }
        return (conversations, people)
    }

    static func canSend(recipients: [MessageRecipient], text: String, fileCount: Int, sending: Bool) -> Bool {
        !recipients.isEmpty && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || fileCount > 0) && !sending
    }
}

// MARK: - Recent searches on this device

/// The last searches, kept on the device as the Expo app kept them.
enum RecentSearchStore {
    private static let key = "weldchat.recentSearches"

    static func load(_ defaults: UserDefaults = .standard) -> [String] {
        guard let data = defaults.data(forKey: key),
              let list = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        return Array(list.prefix(RecentSearches.limit))
    }

    static func save(_ list: [String], _ defaults: UserDefaults = .standard) {
        if list.isEmpty {
            defaults.removeObject(forKey: key)
        } else if let data = try? JSONEncoder().encode(list) {
            defaults.set(data, forKey: key)
        }
    }
}
