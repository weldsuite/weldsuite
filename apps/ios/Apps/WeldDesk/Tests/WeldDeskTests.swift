import WeldDeskAPI
import XCTest
@testable import WeldDesk

final class WeldDeskTests: XCTestCase {
    func testTheAppHasAName() {
        XCTAssertFalse(DeskStrings.appName.isEmpty)
    }
}

final class DeskLogicTests: XCTestCase {
    private func conversation(
        name: String? = nil,
        email: String? = nil,
        title: String? = nil,
        preview: String? = nil,
        waiting: Bool = false,
        lastMessageAt: Date? = nil,
        updatedAt: Date? = Date(timeIntervalSince1970: 1_000)
    ) -> DeskConversation {
        DeskConversation(
            id: "dconv_1",
            number: 42,
            title: title,
            state: .open,
            channel: .messenger,
            channelValue: "messenger",
            visitorID: nil,
            name: name,
            email: email,
            assigneeID: nil,
            waitingSince: waiting ? Date(timeIntervalSince1970: 500) : nil,
            lastMessageAt: lastMessageAt,
            updatedAt: updatedAt,
            lastMessagePreview: preview
        )
    }

    private func message(_ id: String, at seconds: TimeInterval?) -> DeskMessage {
        DeskMessage(
            id: id,
            createdAt: seconds.map { Date(timeIntervalSince1970: $0) },
            conversationID: "dconv_1",
            kind: .message,
            body: id,
            authorType: .visitor,
            authorID: nil,
            attachments: [],
            eventType: nil,
            rating: nil
        )
    }

    func testTheInboxFiltersBecomeTheQuery() {
        var query = InboxQuery()
        query.assignee = .mine
        query.sort = .oldest
        query.search = "  #42 "
        XCTAssertEqual(DeskLogic.inboxRequest(query, userID: "user_1"), InboxRequest(state: "open", assigneeID: "user_1", unassigned: nil, q: "#42", sort: "oldest"))
        var closed = InboxQuery()
        closed.state = .closed
        closed.assignee = .unassigned
        XCTAssertEqual(DeskLogic.inboxRequest(closed, userID: "user_1"), InboxRequest(state: "closed", assigneeID: nil, unassigned: true, q: nil, sort: "newest"))
        var mine = InboxQuery()
        mine.assignee = .mine
        XCTAssertNil(DeskLogic.inboxRequest(mine, userID: nil).assigneeID)
        XCTAssertEqual(InboxSort.waitingLongest.rawValue, "waiting_longest")
    }

    func testTheSortChipStepsThroughEveryOrder() {
        XCTAssertEqual(InboxSort.newest.next, .waitingLongest)
        XCTAssertEqual(InboxSort.waitingLongest.next, .oldest)
        XCTAssertEqual(InboxSort.oldest.next, .newest)
    }

    func testARowShowsTheCustomerAndTheLastMessage() {
        XCTAssertEqual(DeskLogic.rowTitle(conversation(name: "Ann", email: "ann@example.test")), "Ann")
        XCTAssertEqual(DeskLogic.rowTitle(conversation(name: " ", email: "ann@example.test")), "ann@example.test")
        XCTAssertNil(DeskLogic.rowTitle(conversation()))
        XCTAssertEqual(DeskLogic.rowSubtitle(conversation(title: "Order", preview: "Hello")), "Hello")
        XCTAssertEqual(DeskLogic.rowSubtitle(conversation(email: "a@b.test", title: "Order")), "Order")
        XCTAssertEqual(DeskLogic.rowSubtitle(conversation(email: "a@b.test")), "a@b.test")
        XCTAssertEqual(DeskLogic.rowSubtitle(conversation()), "")
        XCTAssertEqual(DeskLogic.numberLabel(conversation(title: "Order")), "#42 · Order")
        XCTAssertEqual(DeskLogic.numberLabel(conversation()), "#42")
        XCTAssertEqual(DeskLogic.threadTitle(conversation()), "#42")
        XCTAssertTrue(conversation(waiting: true).isWaiting)
        let last = Date(timeIntervalSince1970: 2_000)
        XCTAssertEqual(DeskLogic.rowTime(conversation(lastMessageAt: last)), last)
        XCTAssertEqual(DeskLogic.rowTime(conversation()), Date(timeIntervalSince1970: 1_000))
    }

    func testAMessageIsReplacedByIdOrAddedInTimeOrder() {
        let merged = DeskLogic.merge([message("a", at: 1), message("c", at: 3)], message("b", at: 2))
        XCTAssertEqual(merged.map(\.id), ["a", "b", "c"])
        let undated = DeskLogic.merge(merged, message("d", at: nil))
        XCTAssertEqual(undated.map(\.id), ["a", "b", "c", "d"])
        let edited = DeskMessage(id: "b", createdAt: Date(timeIntervalSince1970: 2), conversationID: "dconv_1", kind: .note, body: "edited", authorType: .agent, authorID: "u", attachments: [], eventType: nil, rating: nil)
        let replaced = DeskLogic.merge(merged, edited)
        XCTAssertEqual(replaced.count, 3)
        XCTAssertEqual(replaced[1].body, "edited")
    }

    func testTheAssigneeIsYouATeammateOrNobody() {
        let members = [DeskMember(userID: "user_2", name: "Bob", email: "bob@example.test", picture: nil)]
        XCTAssertEqual(DeskLogic.assigneeLabel(assigneeID: nil, userID: "user_1", members: members), .unassigned)
        XCTAssertEqual(DeskLogic.assigneeLabel(assigneeID: "user_1", userID: "user_1", members: nil), .you)
        XCTAssertEqual(DeskLogic.assigneeLabel(assigneeID: "user_2", userID: "user_1", members: members), .teammate("Bob"))
        XCTAssertEqual(DeskLogic.assigneeLabel(assigneeID: "user_3", userID: "user_1", members: members), .someone)
        XCTAssertEqual(DeskLogic.assigneeLabel(assigneeID: "user_2", userID: "user_1", members: nil), .someone)
    }

    func testTheRosterIsNamedAndSearchable() {
        XCTAssertEqual(DeskLogic.member(userID: "u1", name: "Ann", email: "ann@x.test", picture: " "), DeskMember(userID: "u1", name: "Ann", email: "ann@x.test", picture: nil))
        XCTAssertEqual(DeskLogic.member(userID: "u1", name: " ", email: "ann@x.test", picture: nil)?.name, "ann@x.test")
        XCTAssertEqual(DeskLogic.member(userID: "u1", name: nil, email: nil, picture: nil)?.name, "u1")
        XCTAssertNil(DeskLogic.member(userID: "", name: "Ann", email: nil, picture: nil))
        let members = [
            DeskMember(userID: "u1", name: "Ann Agent", email: "ann@x.test", picture: nil),
            DeskMember(userID: "u2", name: "Bob", email: "bob@y.test", picture: nil),
        ]
        XCTAssertEqual(DeskLogic.filterMembers(members, search: " ANN ").map(\.userID), ["u1"])
        XCTAssertEqual(DeskLogic.filterMembers(members, search: "y.test").map(\.userID), ["u2"])
        XCTAssertEqual(DeskLogic.filterMembers(members, search: "").count, 2)
    }

    func testFileSizesReadLikeTheExpoApp() {
        XCTAssertEqual(DeskLogic.formatFileSize(nil), "")
        XCTAssertEqual(DeskLogic.formatFileSize(0), "")
        XCTAssertEqual(DeskLogic.formatFileSize(512), "512 B")
        XCTAssertEqual(DeskLogic.formatFileSize(1024), "1 KB")
        XCTAssertEqual(DeskLogic.formatFileSize(1536), "1.5 KB")
        XCTAssertEqual(DeskLogic.formatFileSize(1_468_006), "1.4 MB")
        XCTAssertEqual(DeskLogic.formatFileSize(12 * 1024 * 1024), "12 MB")
    }

    func testOnlyWebLinksOpenAndImagesShowAsThumbnails() {
        XCTAssertNotNil(DeskLogic.openableURL(" https://files.example.test/a.png"))
        XCTAssertNotNil(DeskLogic.openableURL("HTTP://x.test"))
        XCTAssertNil(DeskLogic.openableURL("javascript:alert(1)"))
        XCTAssertNil(DeskLogic.openableURL("file:///etc/passwd"))
        XCTAssertNil(DeskLogic.openableURL(nil))
        XCTAssertTrue(DeskLogic.isImage("IMAGE/PNG"))
        XCTAssertFalse(DeskLogic.isImage("application/pdf"))
        XCTAssertFalse(DeskLogic.isImage(nil))
    }

    func testAReplysFilesFollowTheServersRules() {
        XCTAssertNil(DeskLogic.attachmentProblem(contentType: "image/jpeg", size: 1000))
        XCTAssertNil(DeskLogic.attachmentProblem(contentType: "application/pdf", size: nil))
        XCTAssertEqual(DeskLogic.attachmentProblem(contentType: "image/jpeg", size: DeskLogic.maxAttachmentBytes + 1), .tooLarge)
        XCTAssertEqual(DeskLogic.attachmentProblem(contentType: "video/mp4", size: 10), .typeNotAllowed)
        XCTAssertEqual(DeskLogic.attachmentProblem(contentType: nil, size: 10), .typeNotAllowed)
    }

    func testAnUploadIsOneFilePart() throws {
        let body = DeskStore.multipart(PickedFile(name: "a\"b.png", contentType: "image/png", data: Data("PNG".utf8)), boundary: "XYZ")
        let text = try XCTUnwrap(String(data: body, encoding: .utf8))
        XCTAssertEqual(text, "--XYZ\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a_b.png\"\r\nContent-Type: image/png\r\n\r\nPNG\r\n--XYZ--\r\n")
    }

    func testANotificationOpensItsConversation() {
        XCTAssertEqual(DeskLogic.conversationID(fromPush: ["conversationId": "dconv_1"]), "dconv_1")
        XCTAssertEqual(DeskLogic.conversationID(fromPush: ["entityType": "desk_conversation", "entityId": "dconv_2"]), "dconv_2")
        XCTAssertEqual(DeskLogic.conversationID(fromPush: ["actionUrl": "/welddesk/inbox/dconv_3"]), "dconv_3")
        XCTAssertEqual(DeskLogic.conversationID(fromPush: ["actionUrl": "https://app.weldsuite.eu/welddesk/inbox/dconv_4/?x=1"]), "dconv_4")
        XCTAssertNil(DeskLogic.conversationID(fromPush: ["entityType": "ticket", "entityId": "tkt_1", "ticketId": "tkt_1"]))
        XCTAssertNil(DeskLogic.conversationID(fromPush: ["actionUrl": "/welddesk/tickets/tkt_1"]))
        XCTAssertEqual(DeskLogic.route(forPush: ["conversationId": "dconv_1"]), .conversation("dconv_1"))
        XCTAssertEqual(DeskLogic.route(forPush: ["ticketId": "tkt_1"]), .inbox)
    }

    func testTheExpoAppsLinksOpenTheSameScreens() {
        XCTAssertEqual(DeskLogic.route(forLink: "welddesk://conversation/dconv_1"), .conversation("dconv_1"))
        XCTAssertEqual(DeskLogic.route(forLink: "welddesk://settings"), .settings)
        XCTAssertEqual(DeskLogic.route(forLink: "welddesk://"), .inbox)
        XCTAssertEqual(DeskLogic.route(forLink: "welddesk://inbox"), .inbox)
        XCTAssertNil(DeskLogic.route(forLink: "welddesk://sso-callback?code=x"))
        XCTAssertNil(DeskLogic.route(forLink: "https://example.test/conversation/1"))
        XCTAssertNil(DeskLogic.route(forLink: "welddesk://conversation"))
    }

    func testTheRoomsBaseIsTheRealtimeServiceWithoutWs() {
        let server = URL(string: "https://app.weldsuite.eu")!
        XCTAssertEqual(DeskLogic.realtimeBase("wss://rt.weldsuite.eu/ws/", server: server).absoluteString, "wss://rt.weldsuite.eu")
        XCTAssertEqual(DeskLogic.realtimeBase(nil, server: server).absoluteString, "wss://app.weldsuite.eu")
        XCTAssertEqual(DeskLogic.realtimeBase("  ", server: server).absoluteString, "wss://app.weldsuite.eu")
    }

    func testTheRoomTracksVisitorsTypingAndOnline() {
        var state = RoomState.reduce(RoomState(), type: "connected", fields: .init(presence: ["user_1", "visitor:v1"]))
        XCTAssertTrue(state.visitorOnline)
        state = RoomState.reduce(state, type: "typing", fields: .init(userID: "visitor:v1", userName: "Ann", isTyping: true))
        state = RoomState.reduce(state, type: "typing", fields: .init(userID: "user_2", userName: "Bob", isTyping: true))
        XCTAssertEqual(state.visitorsTyping, ["Ann"])
        state = RoomState.reduce(state, type: "typing", fields: .init(userID: "visitor:v1", isTyping: false))
        XCTAssertEqual(state.visitorsTyping, [])
        state = RoomState.reduce(state, type: "presence:leave", fields: .init(userID: "visitor:v1"))
        XCTAssertFalse(state.visitorOnline)
        state = RoomState.reduce(state, type: "presence:join", fields: .init(userID: "visitor:v2"))
        XCTAssertTrue(state.visitorOnline)
        XCTAssertEqual(RoomState.reduce(state, type: "message", fields: .init(userID: "visitor:v2")), state)
    }

    func testRoomMessagesAreReadFromTheirJSON() {
        let join = RoomState.fields(of: ["type": "presence:join", "member": ["userId": "visitor:v1", "userName": "Ann"]])
        XCTAssertEqual(join.userID, "visitor:v1")
        XCTAssertEqual(join.userName, "Ann")
        let typing = RoomState.fields(of: ["type": "typing", "userId": "visitor:v1", "userName": "Ann", "isTyping": true])
        XCTAssertTrue(typing.isTyping)
        let connected = RoomState.fields(of: ["type": "connected", "presence": [["userId": "a"], ["userId": "visitor:b"]]])
        XCTAssertEqual(connected.presence, ["a", "visitor:b"])
    }

    func testTypingIsSentAtMostEveryThreeSecondsAndStoppedOnce() {
        var throttle = TypingThrottle()
        XCTAssertFalse(throttle.stop())
        XCTAssertTrue(throttle.keystroke(now: 10))
        XCTAssertFalse(throttle.keystroke(now: 11))
        XCTAssertFalse(throttle.keystroke(now: 13))
        XCTAssertTrue(throttle.keystroke(now: 13.001))
        XCTAssertTrue(throttle.stop())
        XCTAssertFalse(throttle.stop())
        XCTAssertTrue(throttle.keystroke(now: 13.5))
    }

    func testServerValuesAreReadLeniently() {
        XCTAssertEqual(ConversationState(server: "closed"), .closed)
        XCTAssertEqual(ConversationState(server: "pending"), .open)
        XCTAssertEqual(DeskChannel(server: "email"), .email)
        XCTAssertEqual(DeskChannel(server: "telegram"), .other)
        XCTAssertEqual(MessageKind(server: "event"), .event)
        XCTAssertEqual(AuthorType(server: "workflow"), .system)
    }
}

/// The server's answers, as the generated client decodes them, mapped to the app's models.
final class DeskStoreMappingTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testAPageOfTheInboxMapsEveryField() throws {
        let page = try decode(Components.Schemas.DeskConversationList.self, #"""
        {"data":[{"id":"dconv_1","createdAt":"2026-11-27T08:00:00.000Z","updatedAt":"2026-11-27T09:00:00.000Z",
          "conversationNumber":42,"title":"Order","state":"open","channel":"messenger","visitorId":"vis_1",
          "name":"Ann","email":null,"contactId":null,"assigneeId":null,"priority":null,"tags":[],
          "waitingSince":"2026-11-27T08:30:00.000Z","lastMessageAt":"2026-11-27T08:30:00.000Z",
          "lastMessagePreview":"Where is my order?","isMajorIncident":false},
         {"id":"dconv_2","createdAt":"2026-11-26T08:00:00.000Z","updatedAt":"2026-11-26T09:00:00.000Z",
          "conversationNumber":43,"title":null,"state":"closed","channel":"telegram","visitorId":null,
          "name":null,"email":"c@example.test","contactId":null,"assigneeId":"user_1","priority":"high",
          "waitingSince":null,"lastMessageAt":null,"lastMessagePreview":null}],
         "pagination":{"totalCount":2,"hasMore":true,"cursor":"30"}}
        """#)
        let first = DeskStore.conversation(page.data[0])
        XCTAssertEqual(first.number, 42)
        XCTAssertEqual(first.state, .open)
        XCTAssertEqual(first.channel, .messenger)
        XCTAssertNotNil(first.waitingSince)
        let second = DeskStore.conversation(page.data[1])
        XCTAssertEqual(second.state, .closed)
        XCTAssertEqual(second.channel, .other)
        XCTAssertEqual(second.channelValue, "telegram")
        XCTAssertEqual(second.assigneeID, "user_1")
        XCTAssertNil(second.waitingSince)
        XCTAssertEqual(page.pagination.cursor, "30")
    }

    func testAThreadMapsMessagesAttachmentsAndEvents() throws {
        let response = try decode(Components.Schemas.DeskConversationDetailResponse.self, #"""
        {"data":{"id":"dconv_1","createdAt":"2026-11-27T08:00:00.000Z","updatedAt":"2026-11-27T09:00:00.000Z",
          "conversationNumber":42,"title":null,"state":"open","channel":"email","name":null,"email":"a@b.test",
          "customFields":{},
          "messages":[
            {"id":"m1","createdAt":"2026-11-27T08:30:00.000Z","conversationId":"dconv_1","kind":"message",
             "body":null,"authorType":"visitor","authorId":"vis_1",
             "attachments":[{"name":"photo.png","url":"https://f.test/p.png","contentType":"image/png","filesize":2048,"width":640,"height":480},
                            {"name":"broken","contentType":"text/plain","filesize":null}],
             "metadata":null},
            {"id":"m2","createdAt":"2026-11-27T08:31:00.000Z","conversationId":"dconv_1","kind":"event",
             "body":null,"authorType":"system","authorId":null,"attachments":null,
             "metadata":{"eventType":"rated","rating":4,"ratingComment":null}}]}}
        """#)
        let detail = DeskStore.detail(response.data)
        XCTAssertEqual(detail.conversation.email, "a@b.test")
        XCTAssertEqual(detail.messages.count, 2)
        let photo = detail.messages[0]
        XCTAssertEqual(photo.authorType, .visitor)
        // An attachment without a URL can't be opened, so it's left out.
        XCTAssertEqual(photo.attachments, [DeskAttachment(name: "photo.png", url: "https://f.test/p.png", contentType: "image/png", size: 2048, width: 640, height: 480)])
        let rated = detail.messages[1]
        XCTAssertEqual(rated.kind, .event)
        XCTAssertEqual(rated.eventType, "rated")
        XCTAssertEqual(rated.rating, 4)
    }

    func testHubEventsCarryTheRecord() {
        let message = Data(#"{"id":"m3","createdAt":"2026-11-27T08:32:00.000Z","conversationId":"dconv_1","kind":"note","body":"VIP","authorType":"agent","authorId":"user_1","attachments":null,"metadata":null}"#.utf8)
        XCTAssertEqual(DeskStore.message(fromEvent: message)?.kind, .note)
        XCTAssertNil(DeskStore.message(fromEvent: Data("{}".utf8)))
        let conversation = Data(#"{"id":"dconv_1","createdAt":"2026-11-27T08:00:00Z","updatedAt":"2026-11-27T09:00:00Z","conversationNumber":42,"state":"closed","channel":"email"}"#.utf8)
        XCTAssertEqual(DeskStore.conversation(fromEvent: conversation)?.state, .closed)
        XCTAssertNil(DeskStore.conversation(fromEvent: message))
    }
}
