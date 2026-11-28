import WeldCore
import XCTest
@testable import WeldChat

/// The rules of the list and create screens (Screens/ScreenRules.swift).
final class ScreenRulesTests: XCTestCase {
    // MARK: Fixtures

    /// 2026-03-04 12:00:00 UTC.
    private let base = Date(timeIntervalSince1970: 1_772_625_600)

    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        return calendar
    }

    private func ago(_ seconds: TimeInterval) -> String {
        WeldDate.timestampString(base.addingTimeInterval(-seconds))
    }

    private func member(_ userID: String, name: String?, email: String? = nil, status: String = "ACTIVE") -> TeamMember {
        TeamMember(id: "wm_\(userID)", userID: userID, name: name, email: email, picture: nil, role: "MEMBER", status: status, memberType: "INTERNAL")
    }

    private func channel(_ id: String, name: String? = nil, type: String = "public", last: String? = nil) -> ChatChannel {
        ChatChannel(
            id: id,
            name: name ?? id,
            type: type,
            description: nil,
            topic: nil,
            isArchived: false,
            threadsEnabled: true,
            memberCount: nil,
            lastMessageAt: last,
            lastMessagePreview: nil,
            sectionID: nil,
            entityType: nil,
            entityID: nil,
            entityDisplayName: nil,
            isMuted: false,
            lastReadAt: nil,
            hasReadState: true,
            unreadMentionCount: 0,
            pinnedBy: [],
            members: []
        )
    }

    private func dm(_ id: String, people: [DmPerson], last: String? = nil, name: String? = nil) -> DmConversation {
        DmConversation(
            id: id,
            name: name ?? people.map { $0.displayName }.joined(separator: ", "),
            picture: people.count == 1 ? people[0].picture : nil,
            type: "dm",
            isGroup: people.count > 1,
            otherMembers: people,
            isMuted: false,
            isPinned: false,
            hasUnread: false,
            unreadCount: 0,
            lastMessagePreview: nil,
            lastMessageAt: last,
            isArchived: false
        )
    }

    private func record(_ id: String, type: String = "company", last: String? = nil, read: String? = nil, muted: Bool = false, mentions: Int = 0, following: Bool = true, preview: String? = nil) -> RecordChat {
        RecordChat(
            id: id,
            name: id,
            entityType: type,
            entityID: "ent_\(id)",
            entityDisplayName: nil,
            lastMessageAt: last,
            lastMessagePreview: preview,
            isFollowing: following,
            isMuted: muted,
            lastReadAt: read,
            unreadMentionCount: mentions
        )
    }

    private func bookmark(channelType: String?, channelName: String?, content: String?) -> ChatBookmark {
        ChatBookmark(
            id: "b1",
            messageID: "m1",
            channelID: "d1",
            note: nil,
            createdAt: ago(10),
            messageContent: content,
            messageAuthorName: "Ann",
            channelName: channelName,
            channelType: channelType
        )
    }

    private let ann = DmPerson(userID: "u_ann", name: "Ann", email: "ann@x.test", picture: "https://x.test/ann.png")
    private let bob = DmPerson(userID: "u_bob", name: nil, email: "bob@x.test", picture: nil)

    // MARK: Drafts and saved

    func testDraftsAndSavedNameTheirConversation() {
        XCTAssertEqual(SavedRules.conversationLabel(name: "general", isDM: false), "#general")
        XCTAssertEqual(SavedRules.conversationLabel(name: "Ann", isDM: true), "Ann")

        let dms = [dm("d1", people: [ann])]
        let channels = [channel("c1", name: "general"), channel("c2", name: "dm-raw", type: "dm")]
        XCTAssertEqual(SavedRules.knownConversation("d1", dms: dms, channels: channels)?.name, "Ann")
        XCTAssertEqual(SavedRules.knownConversation("d1", dms: dms, channels: channels)?.isDM, true)
        XCTAssertEqual(SavedRules.knownConversation("c1", dms: dms, channels: channels)?.isDM, false)
        XCTAssertEqual(SavedRules.knownConversation("c2", dms: [], channels: channels)?.isDM, true)
        XCTAssertNil(SavedRules.knownConversation("zz", dms: dms, channels: channels))
    }

    func testDraftsAreNewestFirst() {
        let drafts = [
            DraftItem(id: "a", channelID: "c", channelName: "c", isDM: false, content: "x", updatedAt: ago(600)),
            DraftItem(id: "b", channelID: "c", channelName: "c", isDM: false, content: "y", updatedAt: ago(5)),
        ]
        XCTAssertEqual(SavedRules.sortedDrafts(drafts).map(\.id), ["b", "a"])
    }

    func testASavedMessageReadsItsConversationAndText() {
        let dms = [dm("d1", people: [ann])]
        XCTAssertEqual(SavedRules.bookmarkConversation(bookmark(channelType: "dm", channelName: "dm-raw", content: "x"), dms: dms), "Ann")
        XCTAssertEqual(SavedRules.bookmarkConversation(bookmark(channelType: "public", channelName: "general", content: "x"), dms: dms), "general")
        XCTAssertEqual(SavedRules.bookmarkConversation(bookmark(channelType: "public", channelName: nil, content: "x"), dms: []), ChatStrings.savedUnknownChannel)
        XCTAssertEqual(SavedRules.bookmarkText(bookmark(channelType: nil, channelName: nil, content: " Hi <@u_ann> <@file:f1>"), names: ["u_ann": "Ann"]), "Hi @Ann")
        XCTAssertEqual(SavedRules.bookmarkText(bookmark(channelType: nil, channelName: nil, content: nil), names: [:]), ChatStrings.savedUnavailable)
    }

    // MARK: Record chats

    func testTheEmptyRecordsListSaysWhy() {
        XCTAssertEqual(RecordsRules.emptyText(filter: .unread, search: "acme"), ChatStrings.recordChatsEmptySearch(query: "acme"))
        XCTAssertEqual(RecordsRules.emptyText(filter: .following, search: ""), ChatStrings.recordChatsEmptyFollowing)
        XCTAssertEqual(RecordsRules.emptyText(filter: .unread, search: ""), ChatStrings.recordChatsEmptyUnread)
        XCTAssertEqual(RecordsRules.emptyText(filter: .mentions, search: ""), ChatStrings.recordChatsEmptyMentions)
        XCTAssertEqual(RecordsRules.emptyText(filter: .all, search: ""), ChatStrings.recordChatsEmptyAll)
        XCTAssertEqual(RecordsRules.initialType("task"), "task")
        XCTAssertNil(RecordsRules.initialType("invoice"))
        XCTAssertNil(RecordsRules.initialType(nil))
        XCTAssertEqual(RecordsFilter.allCases.map(\.rawValue), ["following", "unread", "mentions", "all"])
    }

    func testARowChangeShowsAtOnce() {
        let rows = [record("a", last: ago(5), read: ago(50), mentions: 2), record("b")]
        let muted = RecordsRules.apply(ConversationPatch(isMuted: true), to: rows, id: "a", filter: .following, now: base)
        XCTAssertEqual(muted.first?.isMuted, true)
        let read = RecordsRules.apply(ConversationPatch(hasUnread: false), to: rows, id: "a", filter: .following, now: base)
        XCTAssertEqual(read.first?.unreadMentionCount, 0)
        XCTAssertEqual(read.first?.lastReadAt, WeldDate.timestampString(base))

        let unfollowed = RecordsRules.apply(ConversationPatch(isFollowing: false), to: rows, id: "a", filter: .following, now: base)
        XCTAssertEqual(unfollowed.map(\.id), ["b"], "only All lists chats you don't follow")
        let unfollowedInAll = RecordsRules.apply(ConversationPatch(isFollowing: false), to: rows, id: "a", filter: .all, now: base)
        XCTAssertEqual(unfollowedInAll.map(\.id), ["a", "b"])
        XCTAssertEqual(unfollowedInAll.first?.isFollowing, false)
    }

    func testWhenARowChangeNeedsTheServersList() {
        XCTAssertTrue(RecordsRules.needsReload(ConversationPatch(hasUnread: true), rowListed: true), "undoing a mark-read")
        XCTAssertTrue(RecordsRules.needsReload(ConversationPatch(isFollowing: true), rowListed: false), "a follow put back on a row that left")
        XCTAssertFalse(RecordsRules.needsReload(ConversationPatch(isFollowing: true), rowListed: true))
        XCTAssertFalse(RecordsRules.needsReload(ConversationPatch(isMuted: true), rowListed: true))
    }

    func testARecordRowsLook() {
        XCTAssertTrue(RecordsRules.isHighlighted(record("a", last: ago(5))))
        XCTAssertFalse(RecordsRules.isHighlighted(record("a", last: ago(5), following: false)), "only followed chats ask for attention")
        XCTAssertFalse(RecordsRules.isHighlighted(record("a", last: ago(5), read: ago(1))))
        XCTAssertEqual(RecordsRules.subtitle(record("a", preview: "Hello"), showType: false), "Hello")
        XCTAssertEqual(RecordsRules.subtitle(record("a", preview: ""), showType: false), ChatStrings.recordChatsNoMessages)
        XCTAssertEqual(
            RecordsRules.subtitle(record("a", type: "task", preview: "Hello"), showType: true),
            ChatStrings.recordChatsTypeAndPreview(type: ChatStrings.recordChatsTypesTask, preview: "Hello")
        )
    }

    func testWhichPersonalEventsReloadTheRecords() {
        let rows = [record("r1")]
        XCTAssertTrue(RecordsRules.isRelevant(event: "channel_new", channelID: nil, rows: rows))
        XCTAssertTrue(RecordsRules.isRelevant(event: "unread_update", channelID: "r1", rows: rows))
        XCTAssertFalse(RecordsRules.isRelevant(event: "unread_update", channelID: "c9", rows: rows))
        XCTAssertFalse(RecordsRules.isRelevant(event: "mention", channelID: nil, rows: rows))
    }

    // MARK: Search

    func testSearchFindsPeopleByNameOrEmail() {
        let roster = [member("u1", name: "Ann Lee", email: "ann@x.test"), member("u2", name: nil, email: "bob@x.test")]
        XCTAssertEqual(SearchRules.people(roster, matching: "lee").map(\.userID), ["u1"])
        XCTAssertEqual(SearchRules.people(roster, matching: "BOB@").map(\.userID), ["u2"])
        XCTAssertEqual(SearchRules.people(roster, matching: "  ").count, 0)
    }

    func testSearchResultsPerTabAndTheirFileLine() {
        let photo = SearchHitItem(
            id: "h1", content: "", authorName: "Ann", authorAvatar: nil, channelID: "c", channelName: nil, channelType: nil,
            createdAt: ago(5), attachments: [ChatAttachment(id: "a", fileName: "beach.png", fileSize: 1, mimeType: "image/png", url: "https://x.test/b")]
        )
        let text = SearchHitItem(
            id: "h2", content: "hi", authorName: "Ann", authorAvatar: nil, channelID: "c", channelName: nil, channelType: nil,
            createdAt: ago(5), attachments: []
        )
        XCTAssertEqual(SearchRules.results([photo, text], tab: .all).map(\.id), ["h1", "h2"])
        XCTAssertEqual(SearchRules.results([photo, text], tab: .photos).map(\.id), ["h1"])
        XCTAssertTrue(SearchRules.results([photo, text], tab: .people).isEmpty)
        XCTAssertEqual(SearchRules.attachmentLabel(photo), "beach.png")
        XCTAssertNil(SearchRules.attachmentLabel(text))
    }

    func testRecentSearchesStayOnTheDevice() throws {
        let suite = "weldchat.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertEqual(RecentSearchStore.load(defaults), [])
        RecentSearchStore.save(["budget", "plan"], defaults)
        XCTAssertEqual(RecentSearchStore.load(defaults), ["budget", "plan"])
        RecentSearchStore.save([], defaults)
        XCTAssertEqual(RecentSearchStore.load(defaults), [])
    }

    // MARK: A member

    func testTheMemberHeader() {
        let profile = MemberProfileInfo(
            id: "wm1", userID: "u1", name: nil, email: "ann@x.test", picture: nil, role: "MEMBER", status: "ACTIVE",
            title: nil, bio: nil, phone: nil, location: nil, pronouns: nil, links: [], hoursPerWeek: nil,
            workingHours: [:], timezone: "UTC", canEdit: false
        )
        XCTAssertEqual(MemberScreenRules.headerName(profile: profile, state: .ready), "ann@x.test")
        var named = profile
        named.name = "Ann"
        XCTAssertEqual(MemberScreenRules.headerName(profile: named, state: .ready), "Ann")
        var nameless = profile
        nameless.email = nil
        XCTAssertEqual(MemberScreenRules.headerName(profile: nameless, state: .ready), ChatStrings.memberFallbackName)
        XCTAssertEqual(MemberScreenRules.headerName(profile: nil, state: .notFound), ChatStrings.memberNotFoundTitle)
        XCTAssertEqual(MemberScreenRules.headerName(profile: nil, state: .failed), ChatStrings.memberProfileLoadFailedTitle)
        XCTAssertEqual(MemberScreenRules.headerName(profile: nil, state: .loading), "")

        XCTAssertEqual(MemberScreenRules.customStatus(MemberPresence(status: .online, statusText: "Lunch", statusEmoji: "🍔")), "🍔 Lunch")
        XCTAssertEqual(MemberScreenRules.customStatus(MemberPresence(status: .online, statusText: "Lunch", statusEmoji: nil)), "Lunch")
        XCTAssertNil(MemberScreenRules.customStatus(MemberPresence(status: .away, statusText: nil, statusEmoji: nil)))
        XCTAssertNil(MemberScreenRules.customStatus(nil))

        XCTAssertEqual(MemberScreenRules.tabs(isSelf: true), [.overview, .activity], "nothing in common with yourself")
        XCTAssertEqual(MemberScreenRules.tabs(isSelf: false), [.overview, .common, .activity])
    }

    func testWorkingHours() {
        XCTAssertNil(MemberScreenRules.schedule([:]))
        XCTAssertNil(MemberScreenRules.schedule([.monday: DayHoursInfo(isOpen: false, openTime: nil, closeTime: nil, breaks: [])]))
        let monday = DayHoursInfo(isOpen: true, openTime: "09:00", closeTime: "17:00", breaks: [(start: "12:00", end: "12:30")])
        let week = MemberScreenRules.schedule([.monday: monday])
        XCTAssertEqual(week?.map(\.day), Weekday.allCases)
        XCTAssertEqual(
            MemberScreenRules.dayHours(monday),
            "\(ChatStrings.memberHoursRange(open: "09:00", close: "17:00"))  (\(ChatStrings.memberBreaks(1)) 12:00–12:30)"
        )
        XCTAssertEqual(
            MemberScreenRules.dayHours(DayHoursInfo(isOpen: true, openTime: nil, closeTime: "17:00", breaks: [])),
            ChatStrings.memberHoursRange(open: "—", close: "17:00")
        )
        XCTAssertEqual(MemberScreenRules.dayHours(nil), ChatStrings.memberNotWorking)
    }

    func testAnEditIsSavedOnlyWhenItChanged() {
        XCTAssertNil(MemberScreenRules.commit(" Engineer ", previous: "Engineer"))
        XCTAssertEqual(MemberScreenRules.commit(" Lead ", previous: "Engineer"), "Lead")
        XCTAssertEqual(MemberScreenRules.commit("  ", previous: "Engineer"), "", "empty clears the field")
        XCTAssertNil(MemberScreenRules.commit("", previous: nil))
    }

    func testWhatYouHaveInCommon() {
        XCTAssertEqual(MemberScreenRules.capitalizeWords("in progress"), "In Progress")
        XCTAssertEqual(MemberScreenRules.capitalizeWords("in_progress"), "In_progress")
        XCTAssertEqual(MemberScreenRules.capitalizeWords("straße open"), "Straße Open")
        XCTAssertEqual(MemberScreenRules.capitalizeWords(""), "")
        let delegated = CommonConceptsInfo.Task(id: "t1", title: "Ship", status: "open", role: "delegated")
        let own = CommonConceptsInfo.Task(id: "t2", title: "Ship", status: "open", role: "assignee")
        XCTAssertEqual(MemberScreenRules.taskHint(delegated), ChatStrings.memberCommonDelegated(status: "open"))
        XCTAssertEqual(MemberScreenRules.taskHint(own), "open")
        XCTAssertEqual(MemberScreenRules.commonChannelLabel(.init(id: "c", name: "general", type: "public", memberCount: 3)), "# general")
        XCTAssertEqual(MemberScreenRules.commonChannelLabel(.init(id: "d", name: "Ann, Bob", type: "dm", memberCount: 3)), "Ann, Bob")
        let info = CommonConceptsInfo(
            channels: [.init(id: "c", name: "general", type: "public", memberCount: 3)],
            projects: [],
            tasks: [delegated, own],
            crm: [],
            helpdesk: []
        )
        XCTAssertEqual(MemberScreenRules.commonCount(info), 3)
    }

    func testTimelineWording() {
        XCTAssertEqual(MemberScreenRules.dayLabel(base, now: base, calendar: utc), CoreStrings.commonToday)
        XCTAssertEqual(MemberScreenRules.dayLabel(base.addingTimeInterval(-86400), now: base, calendar: utc), CoreStrings.commonYesterday)
        XCTAssertEqual(MemberScreenRules.eventTime(base.addingTimeInterval(-20), now: base, calendar: utc), ChatStrings.memberActivityJustNow)
        XCTAssertEqual(MemberScreenRules.eventTime(base.addingTimeInterval(-600), now: base, calendar: utc), ChatStrings.memberActivityMinutesAgo(count: 10))
        XCTAssertEqual(MemberScreenRules.eventTime(base.addingTimeInterval(-3 * 3600), now: base, calendar: utc), ChatStrings.memberActivityHoursAgo(count: 3))
        XCTAssertEqual(MemberScreenRules.eventTime(base.addingTimeInterval(-86400 - 3600), now: base, calendar: utc), "11:00")

        let entries = [
            MemberActivityEntry(id: "a1", action: "created", entityType: "project", entityID: "p1", description: "Created 'Apollo'", createdAt: ago(60)),
            MemberActivityEntry(id: "a2", action: "created", entityType: "project", entityID: "p2", description: "Created 'Gemini'", createdAt: ago(120)),
        ]
        let created = MemberLogic.events(entries, names: ["p1": "Apollo", "p2": "Gemini"])[0]
        XCTAssertEqual(
            MemberScreenRules.sentence(created, memberName: "Ann"),
            ChatStrings.memberActivitySentence(
                who: "Ann",
                action: ChatStrings.memberActivityActionsCreated.lowercased(),
                what: ChatStrings.memberActivityMany(count: 2, type: "Project")
            )
        )
        XCTAssertEqual(
            MemberScreenRules.sentence(created, memberName: nil),
            ChatStrings.memberActivitySentenceNoName(
                action: ChatStrings.memberActivityActionsCreated.lowercased(),
                what: ChatStrings.memberActivityMany(count: 2, type: "Project")
            )
        )
        XCTAssertEqual(MemberScreenRules.cards(created).map(\.title), ["Apollo", "Gemini"])
        XCTAssertNil(MemberScreenRules.eventRepeats(created))

        let edits = [
            MemberActivityEntry(id: "e1", action: "updated", entityType: "project_task", entityID: "t1", description: "Updated", createdAt: ago(60)),
            MemberActivityEntry(id: "e2", action: "updated", entityType: "project_task", entityID: "t1", description: "Updated", createdAt: ago(90)),
            MemberActivityEntry(id: "e3", action: "updated", entityType: "project_task", entityID: "t1", description: "Updated", createdAt: ago(99)),
        ]
        let updated = MemberLogic.events(edits, names: [:])[0]
        XCTAssertTrue(MemberScreenRules.cards(updated).isEmpty, "an unnamed card would repeat the sentence")
        XCTAssertEqual(MemberScreenRules.eventRepeats(updated), 3)
        XCTAssertEqual(MemberScreenRules.sentence(updated, memberName: nil), ChatStrings.memberActivitySentenceNoName(
            action: ChatStrings.memberActivityActionsUpdated.lowercased(),
            what: "Task"
        ))
    }

    func testCardCountsAndIcons() {
        XCTAssertEqual(MemberScreenRules.cardCount(MemberLogic.RecordCard(id: "x", title: "X", recordCount: 3, entryCount: 3, named: true)), 3)
        XCTAssertEqual(MemberScreenRules.cardCount(MemberLogic.RecordCard(id: "x", title: "X", recordCount: 1, entryCount: 4, named: true)), 4)
        XCTAssertNil(MemberScreenRules.cardCount(MemberLogic.RecordCard(id: "x", title: "X", recordCount: 1, entryCount: 1, named: true)))
        XCTAssertEqual(MemberScreenRules.entitySymbol("project_task"), "checkmark.square", "a project task is a task")
        XCTAssertEqual(MemberScreenRules.entitySymbol("project"), "folder")
        XCTAssertEqual(MemberScreenRules.entitySymbol("crm_company"), "building.2")
        XCTAssertEqual(MemberScreenRules.entitySymbol("widget"), "cube")
    }

    // MARK: New channel, new DM

    func testNewChannelSteps() {
        XCTAssertEqual(NewChannelRules.lastStep(isPrivate: false), 1)
        XCTAssertEqual(NewChannelRules.lastStep(isPrivate: true), 2, "a private channel picks its people")
        XCTAssertEqual(NewChannelRules.finalName("-marketing-"), "marketing")
        XCTAssertFalse(NewChannelRules.canContinue(step: 0, name: "--", creating: false))
        XCTAssertTrue(NewChannelRules.canContinue(step: 0, name: "plan", creating: false))
        XCTAssertFalse(NewChannelRules.canContinue(step: 1, name: "plan", creating: true))
        XCTAssertEqual(NewChannelRules.primaryLabel(step: 0, isPrivate: false, selectedCount: 0), ChatStrings.newChannelNext)
        XCTAssertEqual(NewChannelRules.primaryLabel(step: 1, isPrivate: false, selectedCount: 0), ChatStrings.newChannelCreate)
        XCTAssertEqual(NewChannelRules.primaryLabel(step: 1, isPrivate: true, selectedCount: 2), ChatStrings.newChannelNext)
        XCTAssertEqual(NewChannelRules.primaryLabel(step: 2, isPrivate: true, selectedCount: 0), ChatStrings.newChannelCreate)
        XCTAssertEqual(NewChannelRules.primaryLabel(step: 2, isPrivate: true, selectedCount: 2), ChatStrings.newChannelCreateWithCount(count: 2))
        XCTAssertEqual(NewChannelRules.title(step: 0), ChatStrings.newChannelTitle)
        XCTAssertEqual(NewChannelRules.title(step: 2), ChatStrings.newChannelPeopleTitle)
        XCTAssertTrue(NewChannelRules.isNameTaken(APIError(status: 409, code: nil)))
        XCTAssertFalse(NewChannelRules.isNameTaken(APIError(status: 500, code: nil)))

        let roster = [member("me", name: "Me"), member("u1", name: "Ann", email: "ann@x.test"), member("invited_1", name: nil, email: "new@x.test", status: "PENDING")]
        XCTAssertEqual(NewChannelRules.people(roster, selfID: "me", query: "").map(\.userID), ["u1", "invited_1"])
        XCTAssertEqual(NewChannelRules.people(roster, selfID: "me", query: "ANN").map(\.userID), ["u1"])
    }

    func testNewDmPicksPeopleWhoCanBeMessaged() {
        let roster = [
            member("me", name: "Me"),
            member("u1", name: "Ann", email: "ann@x.test"),
            member("invited_1", name: nil, email: "new@x.test", status: "PENDING"),
            member("pending_clerk_1", name: "Pat", status: "ACTIVE"),
        ]
        XCTAssertEqual(NewDmRules.people(roster, selfID: "me", query: "").map(\.userID), ["u1"], "not yourself, not invitees")
        XCTAssertEqual(NewDmRules.people(roster, selfID: "me", query: "x.test").map(\.userID), ["u1"])
        XCTAssertEqual(NewDmRules.minimum(isGroup: true), 2)
        XCTAssertEqual(NewDmRules.minimum(isGroup: false), 1)
        XCTAssertEqual(NewDmRules.startLabel(selectedCount: 1), ChatStrings.newMessageStart)
        XCTAssertEqual(NewDmRules.startLabel(selectedCount: 3), ChatStrings.newMessageStartWithCount(count: 3))
        XCTAssertEqual(NewDmRules.toggled(["a"], "b"), ["a", "b"])
        XCTAssertEqual(NewDmRules.toggled(["a", "b"], "a"), ["b"])
    }

    // MARK: New message

    func testRecipientsAndTheirKeys() {
        XCTAssertEqual(NewMessageRules.recipient(channel("c1", name: "general")), .channel(id: "c1", name: "general", isPrivate: false))
        XCTAssertEqual(NewMessageRules.recipient(dm("d1", people: [ann])), .person(userID: "u_ann", name: "Ann", picture: "https://x.test/ann.png"), "a 1:1 DM is its person")
        XCTAssertEqual(NewMessageRules.recipient(dm("d1", people: [bob])), .person(userID: "u_bob", name: "bob@x.test", picture: nil))
        let group = NewMessageRules.recipient(dm("d2", people: [ann, bob]))
        XCTAssertEqual(group.id, "dm:d2")
        XCTAssertEqual(MessageRecipient.channel(id: "c1", name: "general", isPrivate: true).label, "#general")
        XCTAssertEqual(MessageRecipient.channel(id: "c1", name: "general", isPrivate: true).id, "channel:c1")
        XCTAssertEqual(NewMessageRules.recipient(member("u1", name: nil, email: "a@x.test")).name, "a@x.test")
    }

    func testRecentMixesConversationsNewestFirst() {
        let channels = (1...8).map { channel("c\($0)", last: ago(Double($0) * 100)) }
        let dms = [dm("d1", people: [ann], last: ago(50)), dm("d2", people: [ann, bob], last: ago(450))]
        let recent = NewMessageRules.recent(channels: channels, dms: dms)
        XCTAssertEqual(recent.count, NewMessageRules.recentCount)
        XCTAssertEqual(recent.map(\.id).prefix(6), ["p:u_ann", "channel:c1", "channel:c2", "channel:c3", "channel:c4", "dm:d2"])
    }

    func testPeopleAndChannelsToPick() {
        let roster = [
            member("me", name: "Me"),
            member("u_ann", name: "Ann"),
            member("u_cat", name: "Cat"),
            member("u_bea", name: "Bea", email: "bea@x.test"),
            member("invited_9", name: "Invitee", status: "PENDING"),
        ]
        let recent: [MessageRecipient] = [.person(userID: "u_ann", name: "Ann", picture: nil), .channel(id: "c1", name: "general", isPrivate: false)]
        XCTAssertEqual(NewMessageRules.people(roster, selfID: "me", query: "", recent: recent).map(\.name), ["Bea", "Cat"], "by name, without Recent")
        XCTAssertEqual(NewMessageRules.people(roster, selfID: "me", query: "@an", recent: recent).map(\.name), ["Ann"], "searching includes Recent")
        XCTAssertEqual(NewMessageRules.people(roster, selfID: "me", query: "bea@", recent: recent).map(\.name), ["Bea"])

        let channels = [channel("c1", name: "general"), channel("c2", name: "design"), channel("c3", name: "dev-ops", type: "private")]
        XCTAssertEqual(NewMessageRules.channels(channels, query: "", recent: recent).map(\.name), ["design", "dev-ops"])
        XCTAssertEqual(NewMessageRules.channels(channels, query: "#de", recent: recent).map(\.name), ["design", "dev-ops"])
        XCTAssertEqual(NewMessageRules.channels(channels, query: "@de", recent: recent).count, 0, "an @ search is for people")
        XCTAssertEqual(NewMessageRules.term("  #Design "), "design")
    }

    func testWhereANewMessageGoes() {
        let picked: [MessageRecipient] = [
            .channel(id: "c1", name: "general", isPrivate: false),
            .person(userID: "u1", name: "Ann", picture: nil),
            .dm(id: "d2", name: "Ann, Bob", people: []),
            .person(userID: "u2", name: "Bob", picture: nil),
        ]
        let plan = NewMessageRules.split(picked)
        XCTAssertEqual(plan.conversations.map(\.id), ["c1", "d2"])
        XCTAssertEqual(plan.conversations.map(\.isDM), [false, true])
        XCTAssertEqual(plan.people, ["u1", "u2"], "the people share one DM")

        var list = NewMessageRules.toggled([], picked[0])
        list = NewMessageRules.toggled(list, picked[1])
        XCTAssertEqual(list.map(\.id), ["channel:c1", "p:u1"])
        list = NewMessageRules.toggled(list, picked[0])
        XCTAssertEqual(list.map(\.id), ["p:u1"])

        XCTAssertFalse(NewMessageRules.canSend(recipients: [], text: "hi", fileCount: 0, sending: false))
        XCTAssertFalse(NewMessageRules.canSend(recipients: picked, text: "  ", fileCount: 0, sending: false))
        XCTAssertTrue(NewMessageRules.canSend(recipients: picked, text: "  ", fileCount: 1, sending: false))
        XCTAssertTrue(NewMessageRules.canSend(recipients: picked, text: "hi", fileCount: 0, sending: false))
        XCTAssertFalse(NewMessageRules.canSend(recipients: picked, text: "hi", fileCount: 0, sending: true))
    }
}
