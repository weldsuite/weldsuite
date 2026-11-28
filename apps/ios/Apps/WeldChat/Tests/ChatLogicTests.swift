import WeldCore
import XCTest
@testable import WeldChat

/// The pure rules in ChatLogic.swift (and the record refresh queue in ChatStore.swift).
final class ChatLogicTests: XCTestCase {
    // MARK: Fixtures

    /// 2026-03-04 12:00:00 UTC.
    private let base = Date(timeIntervalSince1970: 1_772_625_600)

    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        return calendar
    }

    private func iso(_ date: Date) -> String {
        WeldDate.timestampString(date)
    }

    private func ago(_ seconds: TimeInterval) -> String {
        iso(base.addingTimeInterval(-seconds))
    }

    private func channel(
        _ id: String = "ch_1",
        type: String = "public",
        section: String? = nil,
        lastMessageAt: String? = nil,
        lastReadAt: String? = nil,
        hasReadState: Bool = true,
        mentions: Int = 0
    ) -> ChatChannel {
        ChatChannel(
            id: id,
            name: id,
            type: type,
            description: nil,
            topic: nil,
            isArchived: false,
            threadsEnabled: true,
            memberCount: nil,
            lastMessageAt: lastMessageAt,
            lastMessagePreview: nil,
            sectionID: section,
            entityType: nil,
            entityID: nil,
            entityDisplayName: nil,
            isMuted: false,
            lastReadAt: lastReadAt,
            hasReadState: hasReadState,
            unreadMentionCount: mentions,
            pinnedBy: [],
            members: []
        )
    }

    private func record(
        _ id: String,
        type: String = "company",
        last: String? = nil,
        read: String? = nil,
        muted: Bool = false,
        mentions: Int = 0,
        following: Bool = true,
        display: String? = nil
    ) -> RecordChat {
        RecordChat(
            id: id,
            name: "chat-\(id)",
            entityType: type,
            entityID: "ent_\(id)",
            entityDisplayName: display,
            lastMessageAt: last,
            lastMessagePreview: nil,
            isFollowing: following,
            isMuted: muted,
            lastReadAt: read,
            unreadMentionCount: mentions
        )
    }

    private func message(
        _ id: String,
        author: String = "u_ann",
        type: String = "text",
        content: String = "Hi",
        at: String,
        parentID: String? = nil,
        reply: ReplyReference? = nil,
        pending: Bool = false
    ) -> ChatMessage {
        ChatMessage(
            id: id,
            channelID: "ch_1",
            authorID: author,
            authorName: author == "u_ann" ? "Ann" : "Bob",
            authorAvatar: nil,
            authorType: "user",
            content: content,
            type: type,
            parentID: parentID,
            threadReplyCount: 0,
            editedAt: nil,
            isPinned: false,
            hasAttachments: false,
            attachments: [],
            reactions: [:],
            replyTo: reply,
            visuals: [],
            createdAt: at,
            pending: pending
        )
    }

    private func dm(_ id: String, pinned: Bool = false, unread: Bool = false, muted: Bool = false, last: String? = nil) -> DmConversation {
        DmConversation(
            id: id,
            name: id,
            picture: nil,
            type: "dm",
            isGroup: false,
            otherMembers: [],
            isMuted: muted,
            isPinned: pinned,
            hasUnread: unread,
            unreadCount: 0,
            lastMessagePreview: nil,
            lastMessageAt: last,
            isArchived: false
        )
    }

    private func reply(content: String, attachments: Bool = false) -> ReplyReference {
        ReplyReference(
            messageID: "m0",
            rootID: "m0",
            depth: 1,
            authorID: "u_ann",
            authorName: "Ann",
            authorAvatar: nil,
            content: content,
            hasAttachments: attachments
        )
    }

    // MARK: Channels

    func testAChannelIsUnreadWithAMentionOrANewerMessage() {
        XCTAssertTrue(ChatLogic.isChannelUnread(channel(mentions: 1)))
        XCTAssertTrue(ChatLogic.isChannelUnread(channel(lastMessageAt: ago(10), lastReadAt: ago(60))))
        XCTAssertFalse(ChatLogic.isChannelUnread(channel(lastMessageAt: ago(60), lastReadAt: ago(10))))
        XCTAssertTrue(ChatLogic.isChannelUnread(channel(lastMessageAt: ago(60), lastReadAt: nil)), "never read")
        XCTAssertFalse(ChatLogic.isChannelUnread(channel(lastMessageAt: nil)), "no messages")
    }

    func testAChannelWithoutReadStateIsOnlyUnreadByMentions() {
        XCTAssertFalse(ChatLogic.isChannelUnread(channel(lastMessageAt: ago(10), lastReadAt: nil, hasReadState: false)))
        XCTAssertTrue(ChatLogic.isChannelUnread(channel(hasReadState: false, mentions: 2)))
    }

    func testSectionsKeepTheirOrderAndTheRestGoUnderChannels() {
        let sections = [ChatSection(id: "s2", name: "Projects", position: 0), ChatSection(id: "s1", name: "Team", position: 1)]
        let channels = [
            channel("a", section: "s1"),
            channel("b", section: "s2"),
            channel("c"),
            channel("d", section: "gone"),
        ]
        let groups = ChatLogic.groupSections(channels: channels, sections: sections, defaultName: "Channels")
        XCTAssertEqual(groups.map(\.id), ["s2", "s1", ChatLogic.unsectionedID])
        XCTAssertEqual(groups[0].channels.map(\.id), ["b"])
        XCTAssertEqual(groups[1].channels.map(\.id), ["a"])
        XCTAssertEqual(groups[2].channels.map(\.id), ["c", "d"], "no section, or one that is gone")
        XCTAssertEqual(groups[2].name, "Channels")
    }

    func testNextToASectionCalledChannelsTheRestAreOtherChannelsAsOnThePlatform() {
        let sections = [ChatSection(id: "s1", name: "Channels", position: 0)]
        let groups = ChatLogic.groupSections(channels: [channel("c")], sections: sections, defaultName: "Kanalen", otherName: "Overige kanalen")
        XCTAssertEqual(groups.map(\.id), ["s1", ChatLogic.unsectionedID])
        XCTAssertEqual(groups[1].name, "Overige kanalen")
    }

    func testAWorkspaceWithoutSectionsAlwaysHasTheChannelsGroup() {
        let groups = ChatLogic.groupSections(channels: [], sections: [], defaultName: "Channels")
        XCTAssertEqual(groups.map(\.id), [ChatLogic.unsectionedID])
        XCTAssertTrue(groups[0].channels.isEmpty)
    }

    func testActivityHoldsMentionsRepliesAndMissedCallsOnly() {
        XCTAssertTrue(ChatLogic.isActivityItem(category: "weldchat", type: "chat_mention"))
        XCTAssertTrue(ChatLogic.isActivityItem(category: "weldchat", type: "chat_thread_reply"))
        XCTAssertTrue(ChatLogic.isActivityItem(category: "weldchat", type: "chat_missed_call"))
        XCTAssertFalse(ChatLogic.isActivityItem(category: "weldchat", type: "chat_dm"), "a DM's message shows in the DM")
        XCTAssertFalse(ChatLogic.isActivityItem(category: "welddesk", type: "ticket_assigned"), "another app's notification")
        XCTAssertEqual(ChatLogic.activityCategory("chat_thread_reply"), .replies)
        XCTAssertEqual(ChatLogic.activityCategory("chat_missed_call"), .calls)
    }

    func testMentionsOfYouOrEveryoneAreHighlighted() {
        XCTAssertTrue(ChatLogic.mentionsUser("hi <@u_1>", userID: "u_1"))
        XCTAssertTrue(ChatLogic.mentionsUser("hi <@u_1:Ann>", userID: "u_1"))
        XCTAssertTrue(ChatLogic.mentionsUser("all <@everyone>", userID: "u_1"))
        XCTAssertFalse(ChatLogic.mentionsUser("hi <@u_10>", userID: "u_1"))
    }

    func testTheAvatarFallbackIsTheFirstLetterAsOnThePlatform() {
        XCTAssertEqual(ChatAvatar.initial(of: "Gert van den Berg"), "G")
        XCTAssertEqual(ChatAvatar.initial(of: "  ann"), "A")
        XCTAssertEqual(ChatAvatar.initial(of: nil), "?")
    }

    func testNoDefaultGroupWithoutUnsectionedChannels() {
        let sections = [ChatSection(id: "s1", name: "Team", position: 0)]
        let groups = ChatLogic.groupSections(channels: [channel("a", section: "s1")], sections: sections, defaultName: "Channels")
        XCTAssertEqual(groups.map(\.id), ["s1"])
    }

    func testCountLabelCapsAtTheCap() {
        let plural: (Int) -> String = { "\($0) items" }
        let capped: (Int) -> String = { "\($0)+ items" }
        XCTAssertNil(ChatLogic.countLabel(nil, plural: plural, capped: capped))
        XCTAssertEqual(ChatLogic.countLabel(3, cap: 50, plural: plural, capped: capped), "3 items")
        XCTAssertEqual(ChatLogic.countLabel(50, cap: 50, plural: plural, capped: capped), "50+ items")
        XCTAssertEqual(ChatLogic.countLabel(80, plural: plural, capped: capped), "80 items", "no cap")
    }

    // MARK: Reactions, pins, typing, replies

    func testReactionsAddAndRemoveAUser() {
        var reactions = ChatLogic.withReaction([:], emoji: "👍", userID: "u1", add: true)
        XCTAssertEqual(reactions["👍"], ["u1"])
        reactions = ChatLogic.withReaction(reactions, emoji: "👍", userID: "u1", add: true)
        XCTAssertEqual(reactions["👍"], ["u1"], "once per person")
        reactions = ChatLogic.withReaction(reactions, emoji: "👍", userID: "u2", add: true)
        XCTAssertEqual(reactions["👍"], ["u1", "u2"])
        reactions = ChatLogic.withReaction(reactions, emoji: "👍", userID: "u1", add: false)
        XCTAssertEqual(reactions["👍"], ["u2"])
        reactions = ChatLogic.withReaction(reactions, emoji: "👍", userID: "u2", add: false)
        XCTAssertNil(reactions["👍"], "the last one takes the emoji away")
    }

    func testReactionEntriesSkipEmptyOnesInAStableOrder() {
        let entries = ChatLogic.reactionEntries(["🔥": ["u1"], "👍": ["u1", "u2"], "😮": []])
        XCTAssertEqual(entries.map(\.emoji), ["👍", "🔥"].sorted())
        XCTAssertEqual(entries.first { $0.emoji == "👍" }?.users, ["u1", "u2"])
    }

    func testPinnedBarCyclesThroughThePins() {
        XCTAssertEqual(ChatLogic.pinnedPosition(index: 0, count: 3), 0)
        XCTAssertEqual(ChatLogic.pinnedPosition(index: 4, count: 3), 1)
        XCTAssertEqual(ChatLogic.pinnedPosition(index: 2, count: 0), 0)
    }

    func testTypingLabels() {
        let names = ["u1": "Ann", "u2": "Bob", "agt_1": "Helper"]
        XCTAssertNil(ChatLogic.typingLabel([], names: names))
        XCTAssertEqual(ChatLogic.typingLabel(["u1"], names: names), ChatStrings.channelTypingOne(name: "Ann"))
        XCTAssertEqual(ChatLogic.typingLabel(["agt_1"], names: names), ChatStrings.channelAgentWorking(name: "Helper"))
        XCTAssertEqual(ChatLogic.typingLabel(["u1", "u2"], names: names), ChatStrings.channelTypingTwo(name: "Ann", other: "Bob"))
        XCTAssertEqual(ChatLogic.typingLabel(["u1", "u2", "u3"], names: names), ChatStrings.channelTypingMany(name: "Ann", count: 2))
        XCTAssertEqual(ChatLogic.typingLabel(["u9"], names: names), ChatStrings.channelTypingOne(name: ChatStrings.channelSomeone))
    }

    func testAReplyQuoteIsOneLineOrSaysWhatItWas() {
        XCTAssertEqual(ChatLogic.replyQuoteText(reply(content: "Hello\n  <@u1>   there"), names: ["u1": "Ann"]), "Hello @Ann there")
        XCTAssertEqual(ChatLogic.replyQuoteText(reply(content: "<@file:f1>", attachments: true), names: [:]), ChatStrings.channelAttachment)
        XCTAssertEqual(ChatLogic.replyQuoteText(reply(content: "  "), names: [:]), ChatStrings.channelOriginalMessage)
    }

    func testAnOptimisticMessageIsSignedWithTheBestNameKnown() {
        XCTAssertEqual(ChatLogic.optimisticAuthorName(userID: "u1", names: ["u1": "Ann"], fallbacks: ["Person"]), "Ann")
        XCTAssertEqual(ChatLogic.optimisticAuthorName(userID: "u1", names: [:], fallbacks: [nil, "", "Ann B"]), "Ann B")
        XCTAssertEqual(ChatLogic.optimisticAuthorName(userID: nil, names: [:], fallbacks: []), ChatStrings.channelYou)
    }

    // MARK: Links to and from conversations

    func testTheWebAddressOfAConversation() throws {
        let origin = try XCTUnwrap(URL(string: "https://app.weldsuite.eu/"))
        XCTAssertEqual(ChatLogic.conversationWebURL(origin: origin, channelID: "ch_1", isDM: false, peerUserID: nil), "https://app.weldsuite.eu/weldchat/ch_1")
        XCTAssertEqual(ChatLogic.conversationWebURL(origin: origin, channelID: "ch_1", isDM: true, peerUserID: "u2"), "https://app.weldsuite.eu/weldchat/dm/u2")
        XCTAssertEqual(ChatLogic.conversationWebURL(origin: origin, channelID: "ch_1", isDM: true, peerUserID: nil), "https://app.weldsuite.eu/weldchat/dm/group/ch_1")
    }

    func testActivityListsChatNotificationsOnly() {
        XCTAssertTrue(ChatLogic.isChatNotification(category: "weldchat", type: "mention"))
        XCTAssertTrue(ChatLogic.isChatNotification(category: "system", type: "chat_mention"))
        XCTAssertFalse(ChatLogic.isChatNotification(category: "weldmail", type: "new_mail"))
    }

    func testTheConversationOfAnActionURL() {
        XCTAssertEqual(ChatLogic.conversation(fromActionURL: "/weldchat/dm/ch_9")?.channelID, "ch_9")
        XCTAssertEqual(ChatLogic.conversation(fromActionURL: "/weldchat/dm/ch_9")?.isDM, true)
        XCTAssertEqual(ChatLogic.conversation(fromActionURL: "/weldchat/dm/group/ch_8")?.channelID, "ch_8")
        XCTAssertEqual(ChatLogic.conversation(fromActionURL: "/weldchat/dm/group/ch_8")?.isDM, true)
        XCTAssertEqual(ChatLogic.conversation(fromActionURL: "https://x.test/weldchat/ch_1?messageId=m1")?.channelID, "ch_1")
        XCTAssertEqual(ChatLogic.conversation(fromActionURL: "https://x.test/weldchat/ch_1?messageId=m1")?.isDM, false)
        XCTAssertNil(ChatLogic.conversation(fromActionURL: "/weldmail/inbox"))
        XCTAssertNil(ChatLogic.conversation(fromActionURL: nil))
    }

    func testClock() {
        XCTAssertEqual(ChatLogic.clock(0), "0:00")
        XCTAssertEqual(ChatLogic.clock(65), "1:05")
        XCTAssertEqual(ChatLogic.clock(-3), "0:00")
        XCTAssertEqual(ChatLogic.clock(600.9), "10:00")
    }

    // MARK: Direct messages

    func testADmIsNamedAfterTheOtherPeople() {
        let ann = DmPerson(userID: "u1", name: "Ann", email: "ann@x.test", picture: "https://x.test/a.png")
        let bob = DmPerson(userID: "u2", name: nil, email: "bob@x.test", picture: nil)
        let one = DmLogic.conversation(
            id: "d1", type: "dm", storedName: "dm-xyz", otherMembers: [ann], lastMessageAt: nil, lastReadAt: nil,
            pinnedBy: [], currentUserID: "me", isMuted: false, lastMessagePreview: nil, isArchived: false
        )
        XCTAssertEqual(one.name, "Ann")
        XCTAssertEqual(one.picture, "https://x.test/a.png")
        XCTAssertFalse(one.isGroup)
        XCTAssertEqual(one.peerUserID, "u1")

        let group = DmLogic.conversation(
            id: "d2", type: "group_dm", storedName: "", otherMembers: [ann, bob], lastMessageAt: nil, lastReadAt: nil,
            pinnedBy: [], currentUserID: "me", isMuted: false, lastMessagePreview: nil, isArchived: false
        )
        XCTAssertEqual(group.name, "Ann, bob@x.test")
        XCTAssertTrue(group.isGroup)
        XCTAssertNil(group.picture)
        XCTAssertNil(group.peerUserID)

        let empty = DmLogic.conversation(
            id: "d3", type: "dm", storedName: "", otherMembers: [DmPerson(userID: "", name: "Ghost", email: nil, picture: nil)],
            lastMessageAt: nil, lastReadAt: nil, pinnedBy: [], currentUserID: "me", isMuted: false, lastMessagePreview: nil, isArchived: false
        )
        XCTAssertEqual(empty.name, ChatStrings.dmsFallbackName, "members without an id are dropped")
    }

    func testADmIsUnreadAfterItsReadMarkerAndPinnedByTheCaller() {
        let unread = DmLogic.conversation(
            id: "d1", type: "dm", storedName: "x", otherMembers: [], lastMessageAt: ago(10), lastReadAt: ago(60),
            pinnedBy: ["me"], currentUserID: "me", isMuted: false, lastMessagePreview: nil, isArchived: false
        )
        XCTAssertTrue(unread.hasUnread)
        XCTAssertTrue(unread.isPinned)
        let read = DmLogic.conversation(
            id: "d1", type: "dm", storedName: "x", otherMembers: [], lastMessageAt: ago(60), lastReadAt: ago(10),
            pinnedBy: ["someone-else"], currentUserID: "me", isMuted: false, lastMessagePreview: nil, isArchived: false
        )
        XCTAssertFalse(read.hasUnread)
        XCTAssertFalse(read.isPinned)
        let neverRead = DmLogic.conversation(
            id: "d1", type: "dm", storedName: "x", otherMembers: [], lastMessageAt: ago(60), lastReadAt: nil,
            pinnedBy: [], currentUserID: nil, isMuted: false, lastMessagePreview: nil, isArchived: false
        )
        XCTAssertTrue(neverRead.hasUnread)
        XCTAssertFalse(neverRead.isPinned)
    }

    func testDmFiltersThenPinnedFirstThenNewest() {
        let dms = [
            dm("old", last: ago(3000)),
            dm("pinned", pinned: true, last: ago(9000)),
            dm("new", unread: true, last: ago(10)),
            dm("muted", muted: true, last: ago(100)),
        ]
        XCTAssertEqual(DmLogic.sorted(dms, filter: .all).map(\.id), ["pinned", "new", "muted", "old"])
        XCTAssertEqual(DmLogic.sorted(dms, filter: .unread).map(\.id), ["new"])
        XCTAssertEqual(DmLogic.sorted(dms, filter: .favourites).map(\.id), ["pinned"])
        XCTAssertEqual(DmLogic.sorted(dms, filter: .muted).map(\.id), ["muted"])
        XCTAssertEqual(DmLogic.recent(dms).map(\.id), ["new", "muted", "old", "pinned"])
    }

    // MARK: Record chats

    func testRecordChatNameAndUnreadRules() {
        XCTAssertEqual(RecordChatRules.name(entityDisplayName: "Acme", name: "chat"), "Acme")
        XCTAssertEqual(RecordChatRules.name(entityDisplayName: "", name: "chat"), "chat")
        XCTAssertEqual(RecordChatRules.name(entityDisplayName: nil, name: nil), "")
        XCTAssertTrue(RecordChatRules.isType("company"))
        XCTAssertFalse(RecordChatRules.isType("invoice"))
        XCTAssertFalse(RecordChatRules.isType(nil))

        let unread = record("a", last: ago(10), read: ago(60))
        XCTAssertTrue(RecordChatRules.isUnread(unread))
        XCTAssertTrue(RecordChatRules.needsAttention(unread))
        let muted = record("b", last: ago(10), read: ago(60), muted: true)
        XCTAssertTrue(RecordChatRules.hasUnreadMessages(muted))
        XCTAssertFalse(RecordChatRules.isUnread(muted), "muted chats are not unread, as the server counts them")
        XCTAssertFalse(RecordChatRules.needsAttention(muted))
        XCTAssertTrue(RecordChatRules.needsAttention(record("c", muted: true, mentions: 1)))
    }

    func testQuietRecordChats() {
        XCTAssertTrue(RecordChatRules.isQuiet(record("a"), now: base), "no messages")
        XCTAssertTrue(RecordChatRules.isQuiet(record("b", last: ago(31 * 86400), read: ago(30 * 86400)), now: base))
        XCTAssertFalse(RecordChatRules.isQuiet(record("c", last: ago(29 * 86400), read: ago(28 * 86400)), now: base))
        XCTAssertFalse(RecordChatRules.isQuiet(record("d", last: ago(90 * 86400), mentions: 1), now: base), "a mention is never quiet")
    }

    func testRecordChatsSortMentionsThenUnreadThenNewest() {
        let rows = [
            record("read-new", last: ago(5), read: ago(1)),
            record("unread-old", last: ago(500), read: ago(900)),
            record("mention", last: ago(9000), read: ago(9000), mentions: 2),
            record("read-old", last: ago(800), read: ago(700)),
        ]
        XCTAssertEqual(RecordChatRules.sorted(rows).map(\.id), ["mention", "unread-old", "read-new", "read-old"])
    }

    func testHomeGroupsOnePerFollowedTypeWithoutQuietChats() {
        let summary = [
            RecordChatTypeSummary(type: "company", followed: 7, unread: 1, mentions: 0),
            RecordChatTypeSummary(type: "person", followed: 1, unread: 0, mentions: 0),
            RecordChatTypeSummary(type: "task", followed: 0, unread: 0, mentions: 0),
        ]
        let companies = (1...6).map { record("c\($0)", last: ago(Double($0) * 60), read: ago(Double($0) * 60)) }
            + [record("c-unread", last: ago(30), read: ago(90))]
        let rows: [String: [RecordChat]] = [
            "company": companies,
            "person": [record("p-quiet", type: "person")],
            "task": [record("t1", type: "task", last: ago(10))],
        ]
        let groups = RecordChatRules.groups(summary: summary, rows: rows, isCollapsed: { _ in false }, now: base)
        XCTAssertEqual(groups.map(\.type), ["company"], "people are all quiet, tasks not followed")
        XCTAssertEqual(groups[0].rows.count, RecordChatRules.topN)
        XCTAssertEqual(groups[0].rows.first?.id, "c-unread")
        XCTAssertTrue(groups[0].showAll)

        let collapsed = RecordChatRules.groups(summary: summary, rows: rows, isCollapsed: { $0 == "company" }, now: base)
        XCTAssertEqual(collapsed[0].rows.map(\.id), ["c-unread"], "collapsed shows only what is unread")
        XCTAssertFalse(collapsed[0].showAll)
    }

    func testCoversUnreadCountsUnreadChatsAndMentions() {
        let summary = RecordChatTypeSummary(type: "company", followed: 3, unread: 1, mentions: 2)
        XCTAssertFalse(RecordChatRules.coversUnread([record("a", last: ago(5))], summary))
        XCTAssertTrue(RecordChatRules.coversUnread([record("a", last: ago(5)), record("b", mentions: 2)], summary))
    }

    func testUniqueRowsKeepTheFirstCopy() {
        let rows = RecordChatRules.uniqueRows([[record("a"), record("b")], [record("b", mentions: 3), record("c")]])
        XCTAssertEqual(rows.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(rows[1].unreadMentionCount, 0)
    }

    func testChangedSummaryTypes() {
        let before = [
            RecordChatTypeSummary(type: "company", followed: 1, unread: 0, mentions: 0),
            RecordChatTypeSummary(type: "person", followed: 2, unread: 1, mentions: 0),
        ]
        let after = [
            RecordChatTypeSummary(type: "company", followed: 1, unread: 0, mentions: 0),
            RecordChatTypeSummary(type: "person", followed: 2, unread: 0, mentions: 0),
            RecordChatTypeSummary(type: "task", followed: 1, unread: 0, mentions: 0),
        ]
        XCTAssertEqual(RecordChatRules.changedSummaryTypes(before, after), ["person", "task"])
        XCTAssertEqual(RecordChatRules.changedSummaryTypes(nil, after), ["company", "person", "task"])
    }

    func testAPatchMovesTheSummaryCountsWithTheChat() {
        let summary = [RecordChatTypeSummary(type: "company", followed: 2, unread: 1, mentions: 3)]
        let rows: [String: [RecordChat]] = ["company": [record("a", last: ago(5), read: ago(50), mentions: 3), record("b")]]

        let muted = RecordChatRules.patch(summary: summary, rows: rows, id: "a", patch: RecordChatPatch(isMuted: true), now: base)
        XCTAssertEqual(muted.summary?.first?.unread, 0)
        XCTAssertEqual(muted.summary?.first?.mentions, 3)
        XCTAssertEqual(muted.rows["company"]?.first?.isMuted, true)

        let read = RecordChatRules.patch(summary: summary, rows: rows, id: "a", patch: RecordChatPatch(markRead: true), now: base)
        XCTAssertEqual(read.summary?.first?.unread, 0)
        XCTAssertEqual(read.summary?.first?.mentions, 0)
        XCTAssertEqual(read.rows["company"]?.first?.lastReadAt, iso(base))

        let gone = RecordChatRules.patch(summary: summary, rows: rows, id: "a", patch: RecordChatPatch(unfollowed: true), now: base)
        XCTAssertEqual(gone.summary?.first?.followed, 1)
        XCTAssertEqual(gone.rows["company"]?.map(\.id), ["b"])

        let unknown = RecordChatRules.patch(summary: summary, rows: rows, id: "zz", patch: RecordChatPatch(isMuted: true), now: base)
        XCTAssertEqual(unknown.summary, summary)
    }

    func testWhatAPersonalEventMeansForTheGroups() {
        let records: Set<String> = ["r1"]
        let channels: Set<String> = ["c1"]
        XCTAssertEqual(RecordChatRules.refresh(for: nil, channelID: nil, recordChatIDs: records, channelIDs: channels), .summary)
        XCTAssertEqual(RecordChatRules.refresh(for: "channel_new", channelID: "x", recordChatIDs: records, channelIDs: channels), .all)
        XCTAssertEqual(RecordChatRules.refresh(for: "dm_new", channelID: "r1", recordChatIDs: records, channelIDs: channels), RecordChatRules.Refresh.none)
        XCTAssertEqual(RecordChatRules.refresh(for: "unread_update", channelID: "r1", recordChatIDs: records, channelIDs: channels), .all)
        XCTAssertEqual(RecordChatRules.refresh(for: "mention", channelID: "c1", recordChatIDs: records, channelIDs: channels), RecordChatRules.Refresh.none)
        XCTAssertEqual(RecordChatRules.refresh(for: "mention", channelID: "unknown", recordChatIDs: records, channelIDs: channels), .summary)
    }

    func testARecordOpensInItsOwnApp() {
        XCTAssertEqual(RecordChatRules.appLink(type: "company", entityID: "co_1", projectID: nil)?.url.absoluteString, "weldcrm://company/co_1")
        XCTAssertEqual(RecordChatRules.appLink(type: "person", entityID: "pe_1", projectID: nil)?.app, "WeldCRM")
        XCTAssertEqual(RecordChatRules.appLink(type: "project", entityID: "pr_1", projectID: nil)?.url.absoluteString, "weldflow://project/pr_1")
        XCTAssertEqual(RecordChatRules.appLink(type: "task", entityID: "t_1", projectID: "pr_1")?.url.absoluteString, "weldflow://task/pr_1/t_1")
        XCTAssertNil(RecordChatRules.appLink(type: "task", entityID: "t_1", projectID: nil), "a task needs its project")
        XCTAssertNil(RecordChatRules.appLink(type: "domain", entityID: "d_1", projectID: nil))
        XCTAssertEqual(RecordChatRules.app(for: "task"), "WeldFlow")
        XCTAssertNil(RecordChatRules.app(for: "sheet"))
    }

    func testRecordRefreshesCoalesceToTheWidestOne() {
        var queue = RecordRefreshQueue()
        XCTAssertNil(queue.take())
        queue.request(.summary)
        queue.request(.all)
        queue.request(.summary)
        XCTAssertEqual(queue.take(), .all)
        XCTAssertNil(queue.take())
        queue.request(.summary)
        XCTAssertEqual(queue.take(), .summary)
    }

    // MARK: Mentions, files and links

    func testInlineFileTokens() {
        let text = "See <@file:f1> and <@u1> and <@file:f2><@file:f1>"
        XCTAssertEqual(MentionText.fileTokenIDs(text), ["f1", "f2"])
        XCTAssertEqual(MentionText.stripFileTokens(text), "See  and <@u1> and ")
        XCTAssertNil(MentionText.fileTokenID("file:"))
        XCTAssertNil(MentionText.fileTokenID("u1"))
        XCTAssertTrue(MentionText.isAgentID("agt_1"))
        XCTAssertFalse(MentionText.isAgentID("user_1"))
    }

    func testMentionsReadAsNames() {
        XCTAssertEqual(MentionText.label("u1|Ann Lee", names: [:]), "Ann Lee")
        XCTAssertEqual(MentionText.label("agt_1:Helper", names: [:]), "Helper")
        XCTAssertEqual(MentionText.label("u1", names: ["u1": "Ann"]), "Ann")
        XCTAssertEqual(MentionText.label("u9", names: [:]), "unknown")
        XCTAssertEqual(MentionText.plainText("Hi <@u1>, see <@file:f1>!", names: ["u1": "Ann"]), "Hi @Ann, see !")
    }

    func testABodySplitsAtItsKnownFiles() {
        XCTAssertEqual(
            MentionText.blocks("Look\n<@file:a>\nhere", attachmentIDs: ["a"]),
            [.text("Look"), .file("a"), .text("here")]
        )
        XCTAssertEqual(MentionText.blocks("a <@file:zz> b", attachmentIDs: ["a"]), [.text("a  b")], "unknown files are dropped")
        XCTAssertEqual(MentionText.blocks("<@file:a><@file:b>", attachmentIDs: ["a", "b"]), [.file("a"), .file("b")])
        XCTAssertEqual(MentionText.blocks("   ", attachmentIDs: []), [])
    }

    func testTextRunsHoldMentionsAndLinks() throws {
        let url = try XCTUnwrap(URL(string: "https://x.test/a"))
        XCTAssertEqual(
            MentionText.runs("Hi <@u1> see https://x.test/a.", names: ["u1": "Ann"]),
            [.plain("Hi "), .mention("@Ann"), .plain(" see "), .link(text: "https://x.test/a", url: url), .plain(".")]
        )
    }

    func testTheMentionBeingTypedAndItsToken() {
        XCTAssertEqual(MentionText.mentionQuery("Hi @an"), "an")
        XCTAssertEqual(MentionText.mentionQuery("@"), "")
        XCTAssertNil(MentionText.mentionQuery("mail@example"), "an e-mail address is no mention")
        XCTAssertNil(MentionText.mentionQuery("Hi @an there"))
        XCTAssertEqual(MentionText.insertMention("Hi @an", userID: "u1"), "Hi <@u1> ")
        XCTAssertEqual(MentionText.insertMention("no mention", userID: "u1"), "no mention")
    }

    func testLinksLeaveTrailingPunctuationOut() {
        let found = LinkText.find("Go to www.example.com, or (https://x.test/p?q=1).")
        XCTAssertEqual(found.map(\.text), ["www.example.com", "https://x.test/p?q=1"])
        XCTAssertEqual(found.first?.url.absoluteString, "https://www.example.com")
        XCTAssertEqual(LinkText.runs("plain"), [.plain("plain")])
    }

    // MARK: Calls in the conversation

    func testCallMessagesAreRecognised() {
        XCTAssertEqual(CallLog.parse("Ann started a call"), .start(isVideo: false))
        XCTAssertEqual(CallLog.parse("Ann started a video call"), .start(isVideo: true))
        XCTAssertEqual(CallLog.parse("Ann started an voice call"), .start(isVideo: false))
        XCTAssertEqual(CallLog.parse("Call ended — 2m 34s"), .ended(isVideo: false, duration: "2m 34s"))
        XCTAssertEqual(CallLog.parse("Call ended"), .ended(isVideo: false, duration: nil))
        XCTAssertEqual(CallLog.parse("Missed call"), .missed(isVideo: false))
        XCTAssertEqual(CallLog.parse("Missed video call"), .missed(isVideo: true))
        XCTAssertNil(CallLog.parse("Ann joined the channel"))
    }

    func testACallsEndFoldsIntoItsStart() {
        let messages = [
            message("s1", type: "system", content: "Ann started a call", at: ago(300)),
            message("t1", content: "hi", at: ago(200)),
            message("e1", type: "system", content: "Call ended — 1m 5s", at: ago(100)),
            message("e2", author: "u_bob", type: "system", content: "Missed call", at: ago(50)),
            message("s2", type: "system", content: "Ann started a video call", at: ago(10)),
        ]
        let log = CallLog.build(messages)
        XCTAssertEqual(log.entries["s1"]?.outcome, .ended)
        XCTAssertEqual(log.entries["s1"]?.duration, "1m 5s")
        XCTAssertEqual(log.folded, ["e1"])
        XCTAssertEqual(log.entries["e2"]?.outcome, .missed, "an end without its start stands alone")
        XCTAssertNil(log.entries["s2"]?.outcome)
        XCTAssertEqual(log.openID, "s2", "the call still running")
    }

    func testCallDurations() {
        XCTAssertEqual(CallLog.seconds("2m 34s"), 154)
        XCTAssertEqual(CallLog.seconds("45s"), 45)
        XCTAssertEqual(CallLog.seconds("75m"), 4500)
        XCTAssertNil(CallLog.seconds(nil))
        XCTAssertNil(CallLog.seconds(""))
        XCTAssertEqual(CallLog.lasted("30s"), ChatStrings.channelCallFewSeconds)
        XCTAssertEqual(CallLog.lasted("2m 30s"), ChatStrings.channelCallMinutes(3))
        XCTAssertEqual(CallLog.lasted("90m"), ChatStrings.channelCallHours(2))
        XCTAssertNil(CallLog.lasted(nil))
    }

    // MARK: Message layout

    func testDaySeparatorsAndCompactRows() {
        let first = message("m1", at: iso(base))
        let soon = message("m2", at: iso(base.addingTimeInterval(120)))
        let later = message("m3", at: iso(base.addingTimeInterval(400)))
        let other = message("m4", author: "u_bob", at: iso(base.addingTimeInterval(130)))
        let quoted = message("m5", at: iso(base.addingTimeInterval(140)), reply: reply(content: "x"))
        let nextDay = message("m6", at: iso(base.addingTimeInterval(86400)))

        XCTAssertTrue(MessageLayout.startsNewDay(first, previous: nil, calendar: utc))
        XCTAssertFalse(MessageLayout.startsNewDay(soon, previous: first, calendar: utc))
        XCTAssertTrue(MessageLayout.startsNewDay(nextDay, previous: first, calendar: utc))

        XCTAssertTrue(MessageLayout.isCompact(soon, previous: first))
        XCTAssertFalse(MessageLayout.isCompact(later, previous: first), "five minutes apart")
        XCTAssertFalse(MessageLayout.isCompact(other, previous: first), "another author")
        XCTAssertFalse(MessageLayout.isCompact(quoted, previous: first), "a reply shows its quote")
        XCTAssertFalse(MessageLayout.isCompact(soon, previous: message("s", type: "system", at: iso(base))))
    }

    func testARefreshKeepsOlderPagesAndPendingSends() {
        let old = message("old", at: ago(1000))
        let stale = message("stale", at: ago(10))
        let fetched = [message("f1", at: ago(100)), message("f2", at: ago(50))]
        let pending = [message("tmp", at: ago(1), pending: true)]
        let merged = MessageLayout.merge(existing: [old, stale, pending[0]], fetched: fetched, pending: pending)
        XCTAssertEqual(merged.map(\.id), ["old", "f1", "f2", "tmp"], "what's newer than the page and not in it is gone")
        XCTAssertEqual(MessageLayout.chronological([fetched[1], old, fetched[0]]).map(\.id), ["old", "f1", "f2"])
    }

    // MARK: Dates

    func testDayLabelsAndListTimes() {
        XCTAssertEqual(ChatDates.dayLabel(base, now: base, calendar: utc), CoreStrings.commonToday)
        XCTAssertEqual(ChatDates.dayLabel(base.addingTimeInterval(-86400), now: base, calendar: utc), CoreStrings.commonYesterday)
        XCTAssertEqual(ChatDates.listTime(nil, now: base, calendar: utc), "")
        XCTAssertEqual(ChatDates.listTime(ago(86400), now: base, calendar: utc), CoreStrings.commonYesterday)
    }

    func testActivityGroupsAndShortTimes() {
        XCTAssertEqual(ChatDates.activityGroup(base, now: base, calendar: utc), .today)
        XCTAssertEqual(ChatDates.activityGroup(base.addingTimeInterval(-86400), now: base, calendar: utc), .yesterday)
        XCTAssertEqual(ChatDates.activityGroup(base.addingTimeInterval(-3 * 86400), now: base, calendar: utc), .thisWeek)
        XCTAssertEqual(ChatDates.activityGroup(base.addingTimeInterval(-10 * 86400), now: base, calendar: utc), .earlierThisMonth)
        let old = base.addingTimeInterval(-60 * 86400)
        XCTAssertEqual(ChatDates.activityGroup(old, now: base, calendar: utc), .month(old))

        XCTAssertEqual(ChatDates.activityTime(base.addingTimeInterval(-20), now: base), ChatStrings.activityNow)
        XCTAssertEqual(ChatDates.activityTime(base.addingTimeInterval(-300), now: base), ChatStrings.activityMinutesShort(count: 5))
        XCTAssertEqual(ChatDates.activityTime(base.addingTimeInterval(-7200), now: base), ChatStrings.activityHoursShort(count: 2))
        XCTAssertEqual(ChatDates.activityTime(base.addingTimeInterval(-3 * 86400), now: base), ChatStrings.activityDaysShort(count: 3))

        XCTAssertEqual(ChatDates.draftTime(base.addingTimeInterval(-20), now: base), ChatStrings.draftsJustNow)
        XCTAssertEqual(ChatDates.draftTime(base.addingTimeInterval(-600), now: base), ChatStrings.draftsMinutesAgo(count: 10))
        XCTAssertEqual(ChatDates.draftTime(base.addingTimeInterval(-3600 * 5), now: base), ChatStrings.draftsHoursAgo(count: 5))
        XCTAssertEqual(ChatDates.draftTime(base.addingTimeInterval(-86400 * 2), now: base), ChatStrings.draftsDaysAgo(count: 2))
        XCTAssertEqual(ChatDates.time(nil), "")
    }

    // MARK: Search

    func testSearchTabsNarrowByAttachmentOrLink() {
        func hit(_ content: String = "", _ types: [String] = []) -> SearchHitItem {
            SearchHitItem(
                id: UUID().uuidString,
                content: content,
                authorName: "Ann",
                authorAvatar: nil,
                channelID: "ch_1",
                channelName: "general",
                channelType: "public",
                createdAt: iso(base),
                attachments: types.map { ChatAttachment(id: $0, fileName: "f", fileSize: 1, mimeType: $0, url: "https://x.test/f") }
            )
        }
        XCTAssertTrue(SearchTab.all.matches(hit()))
        XCTAssertTrue(SearchTab.links.matches(hit("see HTTPS://x.test")))
        XCTAssertFalse(SearchTab.links.matches(hit("no link")))
        XCTAssertTrue(SearchTab.photos.matches(hit("", ["image/png"])))
        XCTAssertFalse(SearchTab.photos.matches(hit("", ["image/gif"])), "a GIF is a GIF")
        XCTAssertTrue(SearchTab.gifs.matches(hit("", ["image/gif"])))
        XCTAssertTrue(SearchTab.videos.matches(hit("", ["video/mp4"])))
        XCTAssertTrue(SearchTab.audio.matches(hit("", ["audio/mp4"])))
        XCTAssertTrue(SearchTab.docs.matches(hit("", ["application/pdf"])))
        XCTAssertFalse(SearchTab.docs.matches(hit("", ["image/png", "audio/mp4"])))
    }

    func testRecentSearchesPutTheLatestFirstOnce() {
        var list: [String] = []
        list = RecentSearches.adding("  budget ", to: list)
        list = RecentSearches.adding("plan", to: list)
        list = RecentSearches.adding("budget", to: list)
        XCTAssertEqual(list, ["budget", "plan"])
        XCTAssertEqual(RecentSearches.adding("   ", to: list), list)
        for index in 0..<20 { list = RecentSearches.adding("t\(index)", to: list) }
        XCTAssertEqual(list.count, RecentSearches.limit)
        XCTAssertEqual(list.first, "t19")
    }

    // MARK: Channel names, pins, agents

    func testChannelNamesAreLowercaseWordsWithDashes() {
        XCTAssertEqual(ChannelNames.normalize("Plan Budget 2026!"), "plan-budget-2026")
        XCTAssertEqual(ChannelNames.normalize("a  --  b"), "a-b")
        XCTAssertEqual(ChannelNames.normalize(String(repeating: "x", count: 100)).count, ChannelNames.maxLength)
        XCTAssertEqual(ChannelNames.trimDashes("-marketing-"), "marketing")
        XCTAssertEqual(ChannelNames.trimDashes("---"), "")
    }

    func testPinDurations() {
        XCTAssertEqual(PinDuration.day.expiresAt(from: base), base.addingTimeInterval(86400))
        XCTAssertEqual(PinDuration.week.expiresAt(from: base), base.addingTimeInterval(7 * 86400))
        XCTAssertEqual(PinDuration.month.expiresAt(from: base), base.addingTimeInterval(30 * 86400))
        XCTAssertNil(PinDuration.forever.expiresAt(from: base))
    }

    func testAnAgentsVisualIsOneLine() {
        let line = AgentVisuals.line(AgentVisualRef(kind: "chart", title: "Revenue"))
        XCTAssertEqual(line, ChatStrings.channelVisualShown(kind: ChatStrings.channelVisualKindsChart, title: "Revenue"))
        XCTAssertTrue(AgentVisuals.kinds.contains("table"))
        XCTAssertFalse(AgentVisuals.kinds.contains("image"))
    }

    // MARK: Members

    func testRoleLabels() {
        XCTAssertEqual(MemberLogic.roleLabel("OWNER"), ChatStrings.memberRolesOwner)
        XCTAssertEqual(MemberLogic.roleLabel("VIEWER"), ChatStrings.memberRolesViewer)
        XCTAssertEqual(MemberLogic.roleLabel("role_abc"), ChatStrings.memberRolesCustom)
        XCTAssertEqual(MemberLogic.roleLabel("SOMETHING"), ChatStrings.memberRolesMember)
        XCTAssertEqual(MemberLogic.weekdayLabel(.friday), ChatStrings.memberWeekdaysFriday)
    }

    func testLocalTimeAndOffsetOfATimezone() {
        XCTAssertEqual(MemberLogic.localTime(base, timezone: "UTC"), "12:00")
        XCTAssertEqual(MemberLogic.localTime(base, timezone: "Asia/Kolkata"), "17:30")
        XCTAssertEqual(MemberLogic.localTime(base, timezone: "Nowhere/Land"), "—")
        XCTAssertEqual(MemberLogic.offset(base, timezone: "UTC"), "GMT")
        XCTAssertEqual(MemberLogic.offset(base, timezone: "Asia/Kolkata"), "GMT+5:30")
        XCTAssertEqual(MemberLogic.offset(base, timezone: "America/St_Johns"), "GMT-3:30")
        XCTAssertEqual(MemberLogic.offset(base, timezone: "Asia/Tokyo"), "GMT+9")
        XCTAssertEqual(MemberLogic.offset(base, timezone: "Nowhere/Land"), "")
    }

    func testHoursPerWeekAndActivityWording() {
        XCTAssertEqual(MemberLogic.parseHours(" 32,5 "), 32.5)
        XCTAssertEqual(MemberLogic.parseHours("40"), 40)
        XCTAssertNil(MemberLogic.parseHours("lots"))
        XCTAssertEqual(MemberLogic.quotedName("Created task 'Ship the app'"), "Ship the app")
        XCTAssertEqual(MemberLogic.quotedName("Renamed \"Q3\""), "Q3")
        XCTAssertNil(MemberLogic.quotedName("Deleted a task"))
        XCTAssertEqual(MemberLogic.sentenceCase("statusChanged"), "Status changed")
        XCTAssertEqual(MemberLogic.sentenceCase("project_task"), "Project task")
        XCTAssertEqual(MemberLogic.entityTypeLabel("project_task"), "Task")
        XCTAssertEqual(MemberLogic.entityTypeLabel("company"), "Company")
        XCTAssertEqual(MemberLogic.actionLabel("created"), ChatStrings.memberActivityActionsCreated)
        XCTAssertEqual(MemberLogic.actionLabel("priority_changed"), ChatStrings.memberActivityActionsPriorityChanged)
        XCTAssertEqual(MemberLogic.actionLabel("custom_thing"), "custom thing")
    }

    func testTheTimelineGroupsByDayThenActionAndType() {
        let day1 = base
        let day2 = base.addingTimeInterval(-2 * 86400)
        let entries = [
            MemberActivityEntry(id: "a1", action: "created", entityType: "project", entityID: "p1", description: "Created project 'Apollo'", createdAt: iso(day1)),
            MemberActivityEntry(id: "a2", action: "created", entityType: "project", entityID: "p2", description: "Created project 'Gemini'", createdAt: iso(day1.addingTimeInterval(-60))),
            MemberActivityEntry(id: "a3", action: "updated", entityType: "project_task", entityID: "t1", description: "Updated a task", createdAt: iso(day1.addingTimeInterval(-120))),
            MemberActivityEntry(id: "a4", action: "updated", entityType: "project_task", entityID: "t1", description: "Updated a task", createdAt: iso(day1.addingTimeInterval(-180))),
            MemberActivityEntry(id: "a5", action: "deleted", entityType: "company", entityID: "c1", description: "Deleted", createdAt: iso(day2)),
        ]
        let days = MemberLogic.timeline(entries, calendar: utc)
        XCTAssertEqual(days.count, 2)
        XCTAssertEqual(days[0].events.map(\.id), ["created:project", "updated:project_task"], "newest day first")
        let created = days[0].events[0]
        XCTAssertEqual(created.recordCount, 2)
        XCTAssertEqual(created.cards.map(\.title), ["Apollo", "Gemini"])
        XCTAssertTrue(created.cards.allSatisfy(\.named))
        let updated = days[0].events[1]
        XCTAssertEqual(updated.cards.map(\.id), ["unnamed"])
        XCTAssertEqual(updated.cards.first?.title, "Task")
        XCTAssertEqual(updated.recordCount, 1)
        XCTAssertEqual(updated.entryCount, 2)
        XCTAssertEqual(days[1].events.map(\.id), ["deleted:company"])
        XCTAssertEqual(MemberLogic.presenceHex(.online), 0x22C55E)
    }

    // MARK: Push and links

    func testWhereATappedNotificationLeads() {
        XCTAssertEqual(PushRoute.of(["notificationType": "chat_incoming_call"]), .incomingCall)
        XCTAssertEqual(PushRoute.of(["notificationType": "chat_call_ring"]), .incomingCall)
        XCTAssertEqual(PushRoute.of(["notificationType": "push_test", "channelId": "c1"]), PushRoute.none)
        XCTAssertEqual(PushRoute.of(["notificationType": "chat_missed_call", "actionUrl": "/weldchat/dm/d1"]), .conversation(channelID: "d1", isDM: true))
        XCTAssertEqual(PushRoute.of(["notificationType": "chat_missed_call"]), PushRoute.none)
        XCTAssertEqual(PushRoute.of(["chatChannelId": "c1", "channelId": "c2"]), .conversation(channelID: "c1", isDM: false))
        XCTAssertEqual(PushRoute.of(["chatChannelId": "", "channelId": "c2"]), .conversation(channelID: "c2", isDM: false))
        XCTAssertEqual(PushRoute.of(["actionUrl": "/weldchat/dm/d1?messageId=m"]), .conversation(channelID: "d1", isDM: true))
        XCTAssertEqual(PushRoute.of([:]), PushRoute.none)
    }

    func testDeepLinks() throws {
        func link(_ text: String) throws -> DeepLink? { DeepLink.parse(try XCTUnwrap(URL(string: text))) }
        XCTAssertEqual(try link("weldchat://channel/c1"), .channel("c1"))
        XCTAssertEqual(try link("weldchat://dm/d1"), .dm("d1"))
        XCTAssertEqual(try link("weldchat://user/u1"), .user("u1"))
        XCTAssertEqual(try link("weldchat://thread/m1?channelId=c1"), .thread(messageID: "m1", channelID: "c1"))
        XCTAssertNil(try link("weldchat://thread/m1"), "a thread needs its channel")
        XCTAssertEqual(try link("weldchat://later"), .saved)
        XCTAssertEqual(try link("weldchat://records"), .records)
        XCTAssertNil(try link("weldchat://channel"))
        XCTAssertNil(try link("weldmail://channel/c1"))
        XCTAssertNil(try link("weldchat://sso-callback"))
    }

    // MARK: Voice messages

    func testTheWaveformIsTheSameEveryTime() {
        XCTAssertEqual(Waveform.hash(""), 0)
        XCTAssertEqual(Waveform.hash("a"), 97)
        XCTAssertEqual(Waveform.hash("ab"), 97 * 31 + 98)
        let seed = Waveform.hash("https://x.test/voice.m4a")
        let bars = Waveform.bars(seed: seed)
        XCTAssertEqual(bars.count, Waveform.barCount)
        XCTAssertEqual(bars, Waveform.bars(seed: seed))
        XCTAssertTrue(bars.allSatisfy { $0 >= 0.25 && $0 <= 1 })
        XCTAssertEqual(Waveform.bars(seed: 0, count: 5).count, 5)
    }
}
