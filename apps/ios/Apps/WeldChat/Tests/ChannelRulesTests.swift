import WeldCore
import XCTest
@testable import WeldChat

final class ChannelRulesTests: XCTestCase {
    private func message(
        id: String = "m1",
        content: String = "Hello",
        authorName: String = "Ann",
        createdAt: String = "2026-03-01T10:00:00.000Z",
        attachments: [ChatAttachment] = []
    ) -> ChatMessage {
        ChatMessage(
            id: id,
            channelID: "ch_1",
            authorID: "u_ann",
            authorName: authorName,
            authorAvatar: nil,
            authorType: "user",
            content: content,
            type: "text",
            parentID: nil,
            threadReplyCount: 0,
            editedAt: nil,
            isPinned: false,
            hasAttachments: !attachments.isEmpty,
            attachments: attachments,
            reactions: [:],
            replyTo: nil,
            visuals: [],
            createdAt: createdAt
        )
    }

    private func image(_ id: String, url: String, mime: String = "image/png") -> ChatAttachment {
        ChatAttachment(id: id, fileName: "\(id).png", fileSize: 10, mimeType: mime, url: url)
    }

    private func member(_ userID: String, type: String = "user", role: String? = "member", name: String? = nil, icon: String? = nil) -> ChannelMemberInfo {
        ChannelMemberInfo(id: "cm_\(userID)", userID: userID, memberType: type, role: role, isMuted: false, name: name, email: nil, picture: nil, agentIcon: icon)
    }

    private func person(_ userID: String, name: String?, email: String? = nil, status: String = "ACTIVE") -> TeamMember {
        TeamMember(id: "wm_\(userID)", userID: userID, name: name, email: email, picture: nil, role: "MEMBER", status: status, memberType: "INTERNAL")
    }

    private func channel(type: String = "public", name: String = "general", entityDisplayName: String? = nil) -> ChatChannel {
        ChatChannel(
            id: "ch_1",
            name: name,
            type: type,
            description: nil,
            topic: nil,
            isArchived: false,
            threadsEnabled: true,
            memberCount: 2,
            lastMessageAt: nil,
            lastMessagePreview: nil,
            sectionID: nil,
            entityType: type == "entity" ? "company" : nil,
            entityID: type == "entity" ? "co_1" : nil,
            entityDisplayName: entityDisplayName,
            isMuted: false,
            lastReadAt: nil,
            hasReadState: false,
            unreadMentionCount: 0,
            pinnedBy: [],
            members: []
        )
    }

    private func dm(group: Bool, peers: [DmPerson]) -> DmConversation {
        DmConversation(
            id: "dm_1",
            name: peers.map(\.displayName).joined(separator: ", "),
            picture: nil,
            type: group ? "group_dm" : "dm",
            isGroup: group,
            otherMembers: peers,
            isMuted: false,
            isPinned: false,
            hasUnread: false,
            unreadCount: 0,
            lastMessagePreview: nil,
            lastMessageAt: nil,
            isArchived: false
        )
    }

    // MARK: Kind

    func testKindFollowsTheChannelType() {
        XCTAssertEqual(ConversationKind(type: "dm"), .dm)
        XCTAssertEqual(ConversationKind(type: "entity"), .record)
        XCTAssertEqual(ConversationKind(type: "private"), .privateChannel)
        XCTAssertEqual(ConversationKind(type: "public"), .channel)
        XCTAssertEqual(ConversationKind(type: nil), .channel)
    }

    // MARK: Mentions

    func testMentionPickerOffersAgentsFirstThenPeople() {
        let agents = [member("agt_1", type: "agent", name: "Helper"), member("u_x", name: "Not an agent")]
        let people = [person("u_ann", name: "Ann"), person("u_bob", name: "Bob")]
        let candidates = ChannelRules.mentionCandidates(query: "", agents: agents, people: people)
        XCTAssertEqual(candidates.map(\.userID), ["agt_1", "u_ann", "u_bob"])
        XCTAssertTrue(candidates[0].isAgent)
        XCTAssertFalse(candidates[1].isAgent)
    }

    func testMentionPickerMatchesNameOrEmailIgnoringCase() {
        let people = [person("u_ann", name: "Ann Lee", email: "ann@example.test"), person("u_bob", name: "Bob", email: "robert@example.test")]
        XCTAssertEqual(ChannelRules.mentionCandidates(query: "LEE", agents: [], people: people).map(\.userID), ["u_ann"])
        XCTAssertEqual(ChannelRules.mentionCandidates(query: "robert", agents: [], people: people).map(\.userID), ["u_bob"])
        XCTAssertTrue(ChannelRules.mentionCandidates(query: "zed", agents: [], people: people).isEmpty)
    }

    func testMentionPickerCapsAgentsAndPeople() {
        let agents = (0..<7).map { member("agt_\($0)", type: "agent", name: "Agent \($0)") }
        let people = (0..<12).map { person("u_\($0)", name: "Person \($0)") }
        let candidates = ChannelRules.mentionCandidates(query: "", agents: agents, people: people)
        XCTAssertEqual(candidates.filter(\.isAgent).count, ChannelRules.mentionAgentLimit)
        XCTAssertEqual(candidates.filter { !$0.isAgent }.count, ChannelRules.mentionPeopleLimit)
    }

    func testMentionPickerSkipsAgentsWithoutAName() {
        let agents = [member("agt_1", type: "agent", name: nil)]
        XCTAssertTrue(ChannelRules.mentionCandidates(query: "", agents: agents, people: []).isEmpty)
    }

    // MARK: Copy and photos

    func testCopyIsOfferedOnlyForText() {
        XCTAssertTrue(ChannelRules.canCopy(message(content: "Hi")))
        XCTAssertFalse(ChannelRules.canCopy(message(content: "<@file:att_1>")))
        XCTAssertFalse(ChannelRules.canCopy(message(content: "  ")))
    }

    func testCopiedTextShowsMentionsAsNames() {
        let text = ChannelRules.copyText(message(content: "Hi <@u_bob> <@file:att_1>"), names: ["u_bob": "Bob"])
        XCTAssertEqual(text, "Hi @Bob")
    }

    func testViewerGetsEveryPhotoOldestFirstOnce() {
        let older = message(id: "m1", createdAt: "2026-03-01T09:00:00.000Z", attachments: [image("a", url: "https://x.test/a.png")])
        let newer = message(
            id: "m2",
            authorName: "Bob",
            createdAt: "2026-03-01T10:00:00.000Z",
            attachments: [
                image("b", url: "https://x.test/b.png"),
                image("doc", url: "https://x.test/doc.pdf", mime: "application/pdf"),
                image("a2", url: "https://x.test/a.png"),
            ]
        )
        let images = ChannelRules.images([newer, older])
        XCTAssertEqual(images.map(\.url), ["https://x.test/a.png", "https://x.test/b.png"])
        XCTAssertEqual(images.last?.authorName, "Bob")
    }

    // MARK: Header and composer

    func testDisplayNamePrefersTheRecordThenTheRoute() {
        XCTAssertEqual(ChannelRules.displayName(channel: channel(type: "entity", name: "company-co_1", entityDisplayName: "Acme"), routeName: "x"), "Acme")
        XCTAssertEqual(ChannelRules.displayName(channel: channel(name: "general"), routeName: "old"), "general")
        XCTAssertEqual(ChannelRules.displayName(channel: nil, routeName: "From the list"), "From the list")
        XCTAssertEqual(ChannelRules.displayName(channel: nil, routeName: nil), "")
    }

    func testPlaceholderIsNeutralUntilTheNameIsKnown() {
        XCTAssertEqual(ChannelRules.placeholder(kind: .channel, name: ""), ChatStrings.composerMessageDm)
        XCTAssertEqual(ChannelRules.placeholder(kind: .dm, name: "Ann"), ChatStrings.composerMessageDm)
        XCTAssertEqual(ChannelRules.placeholder(kind: .channel, name: "general"), ChatStrings.composerMessageChannel(name: "general"))
        XCTAssertEqual(ChannelRules.placeholder(kind: .record, name: "Acme"), ChatStrings.recordChatsMessagePlaceholder(name: "Acme"))
    }

    func testPresenceIsActiveOnlyForActiveMembers() {
        XCTAssertEqual(ChannelRules.presenceSubtitle(status: "ACTIVE"), ChatStrings.channelActiveNow)
        XCTAssertEqual(ChannelRules.presenceSubtitle(status: "PENDING"), ChatStrings.channelOffline)
        XCTAssertNil(ChannelRules.presenceSubtitle(status: nil))
    }

    func testPeerOfADmComesFromItsMembersThenTheRoster() {
        let ann = DmPerson(userID: "u_ann", name: "Ann", email: nil, picture: nil)
        let bob = DmPerson(userID: "u_bob", name: "Bob", email: nil, picture: nil)
        XCTAssertEqual(ChannelRules.peerUserID(dm: dm(group: false, peers: [ann]), name: "Ann", roster: []), "u_ann")
        XCTAssertNil(ChannelRules.peerUserID(dm: dm(group: true, peers: [ann, bob]), name: "Ann, Bob", roster: []))
        XCTAssertEqual(ChannelRules.peerUserID(dm: nil, name: "Bob", roster: [person("u_bob", name: "Bob")]), "u_bob")
        XCTAssertNil(ChannelRules.peerUserID(dm: nil, name: "", roster: [person("u_bob", name: "Bob")]))
    }

    // MARK: Permissions

    func testOwnersManageButCannotLeave() {
        let members = [member("u_me", role: "owner")]
        let permissions = ChannelRules.permissions(members: members, userID: "u_me")
        XCTAssertTrue(permissions.isOwner)
        XCTAssertTrue(permissions.canManage)
        XCTAssertFalse(permissions.canLeave)
        XCTAssertTrue(permissions.showActions)
    }

    func testAdminsManageAndLeaveMembersOnlyLeave() {
        let admin = ChannelRules.permissions(members: [member("u_me", role: "admin")], userID: "u_me")
        XCTAssertTrue(admin.canManage)
        XCTAssertTrue(admin.canLeave)
        let plain = ChannelRules.permissions(members: [member("u_me", role: "member")], userID: "u_me")
        XCTAssertFalse(plain.canManage)
        XCTAssertTrue(plain.canLeave)
    }

    func testOutsidersSeeNoActions() {
        let permissions = ChannelRules.permissions(members: [member("u_other", role: "owner")], userID: "u_me")
        XCTAssertFalse(permissions.showActions)
    }

    // MARK: Calls and pins

    func testJoinIsOfferedForACallYouAreNotIn() {
        let call = ActiveChannelCall(callID: "call_1", callType: .video)
        XCTAssertEqual(ChannelRules.joinableCall(active: call, inCallID: nil), call)
        XCTAssertEqual(ChannelRules.joinableCall(active: call, inCallID: "call_2"), call)
        XCTAssertNil(ChannelRules.joinableCall(active: call, inCallID: "call_1"))
        XCTAssertNil(ChannelRules.joinableCall(active: nil, inCallID: nil))
    }

    func testCallPeerNamesThePersonOrTheChannel() {
        XCTAssertEqual(ChannelRules.callPeer(kind: .dm, name: "Ann", picture: "https://x.test/a.png"), CallPeer(name: "Ann", avatar: "https://x.test/a.png", isDirect: true))
        XCTAssertEqual(ChannelRules.callPeer(kind: .channel, name: "general", picture: nil), CallPeer(name: "#general"))
        XCTAssertEqual(ChannelRules.callPeer(kind: .record, name: "Acme", picture: nil), CallPeer(name: "Acme"))
        XCTAssertEqual(ChannelRules.callPeer(kind: .privateChannel, name: "", picture: nil), CallPeer(name: nil))
    }

    func testAtMostThreePins() {
        XCTAssertTrue(ChannelRules.canPin(pinnedCount: 2))
        XCTAssertFalse(ChannelRules.canPin(pinnedCount: 3))
    }

    // MARK: Invites

    func testInviteOffersPeopleNotInTheChannel() {
        let roster = [person("u_ann", name: "Ann"), person("u_bob", name: "Bob", email: "bob@example.test"), person("u_cy", name: nil, email: "cy@example.test")]
        XCTAssertEqual(ChannelRules.invitable(roster: roster, memberIDs: ["u_ann"], search: "").map(\.userID), ["u_bob", "u_cy"])
        XCTAssertEqual(ChannelRules.invitable(roster: roster, memberIDs: [], search: " CY@ ").map(\.userID), ["u_cy"])
        XCTAssertTrue(ChannelRules.invitable(roster: roster, memberIDs: ["u_ann", "u_bob", "u_cy"], search: "").isEmpty)
    }
}
