import WeldCore
import XCTest
@testable import WeldMail

private let utc: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .current
    calendar.firstWeekday = 2
    return calendar
}()

private func date(_ text: String) -> Date {
    ISO8601DateFormatter().date(from: text) ?? Date(timeIntervalSince1970: 0)
}

private func message(
    _ id: String,
    sent: String = "2026-11-27T09:00:00Z",
    thread: String? = nil,
    read: Bool = false,
    starred: Bool = false,
    attachments: Bool = false,
    labels: [String] = [],
    from: MailAddress? = MailAddress("grace@example.com", name: "Grace"),
    to: [MailAddress] = [],
    cc: [MailAddress] = []
) -> MailMessage {
    MailMessage(
        id: id,
        accountID: "mail_1",
        smtpMessageID: "<\(id)@example.com>",
        threadID: thread,
        from: from,
        to: to,
        cc: cc,
        subject: "Invoice",
        sentDate: sent,
        createdAt: sent,
        isRead: read,
        isStarred: starred,
        hasAttachments: attachments,
        labels: labels
    )
}

final class WeldMailTests: XCTestCase {
    func testTheAppHasAName() {
        XCTAssertFalse(MailStrings.appName.isEmpty)
    }
}

final class MailLogicTests: XCTestCase {
    private let now = date("2026-11-27T10:00:00Z")

    func testLabelRowsFoldIntoFolderCountsAndCustomLabels() {
        let state = MailLogic.processLabels([
            LabelRow(id: "l1", name: "Inbox", slug: "INBOX", color: nil, isSystem: true, count: 3),
            LabelRow(id: "l2", name: "Inbox", slug: "inbox", color: nil, isSystem: true, count: 2),
            LabelRow(id: "l3", name: "Clients", slug: "clients", color: "#3B82F6", isSystem: false, count: 1),
            LabelRow(id: "l4", name: "clients", slug: "clients-2", color: nil, isSystem: false, count: 4),
            LabelRow(id: "l5", name: "Muted", slug: "MUTED", color: nil, isSystem: true, count: 9),
        ])
        XCTAssertEqual(state.systemCounts["INBOX"], 5)
        XCTAssertEqual(state.custom.count, 1)
        XCTAssertEqual(state.custom.first?.count, 5)
        XCTAssertEqual(state.custom.first?.color, "#3B82F6")
    }

    func testOnlyTheMailboxsOwnLabelsShowOnARow() {
        XCTAssertEqual(MailLogic.displayLabels(["INBOX", "Clients", "STARRED"]), ["Clients"])
    }

    func testALabelsOwnColourIsReadFromItsHex() {
        XCTAssertEqual(MailLogic.parseHex("#3B82F6"), 0x3B82F6)
        XCTAssertNil(MailLogic.parseHex("not a colour"))
        XCTAssertNil(MailLogic.parseHex(nil))
    }

    func testMessagesGroupAsThePlatformsListWithPinnedFirst() {
        // Friday 27 November 2026; the week started on Monday the 23rd.
        let list = [
            message("a", sent: "2026-11-27T08:00:00Z"),
            message("b", sent: "2026-11-26T23:30:00Z"),
            message("c", sent: "2026-11-23T10:00:00Z"),
            message("d", sent: "2026-11-18T10:00:00Z"),
            message("f", sent: "2026-11-05T10:00:00Z"),
            message("g", sent: "2026-10-01T10:00:00Z"),
            message("h", sent: "2025-12-24T10:00:00Z"),
            message("e", sent: "2026-10-02T10:00:00Z", labels: ["INBOX", "PINNED"]),
        ]
        let sections = MailLogic.sections(list, now: now, calendar: utc)
        XCTAssertEqual(sections.map(\.group.kind), [.pinned, .today, .yesterday, .weekday, .lastWeek, .weeksAgo, .month, .monthYear])
        XCTAssertEqual(sections[3].group.day, date("2026-11-23T00:00:00Z"))
        XCTAssertEqual(sections[5].group.weeks, 3)
        XCTAssertEqual(sections[6].group.day, date("2026-10-01T00:00:00Z"))
        XCTAssertEqual(sections[7].group.day, date("2025-12-01T00:00:00Z"))
        XCTAssertEqual(sections.first?.messages.map(\.id), ["e"])
    }

    func testAScheduledSendGetsItsOwnDayAndRowsReadTheirDateAsThePlatform() {
        let upcoming = MailLogic.dateGroup("2026-12-03T09:00:00Z", now: now, calendar: utc)
        XCTAssertEqual(upcoming.kind, .upcoming)
        XCTAssertEqual(upcoming.day, date("2026-12-03T00:00:00Z"))
        XCTAssertEqual(MailLogic.dateGroup("2026-11-27T18:00:00Z", now: now, calendar: utc).kind, .today)
        XCTAssertEqual(MailLogic.dateStyle(date("2026-11-27T01:00:00Z"), now: now, calendar: utc), .time)
        XCTAssertEqual(MailLogic.dateStyle(date("2026-01-02T01:00:00Z"), now: now, calendar: utc), .day)
        XCTAssertEqual(MailLogic.dateStyle(date("2025-12-31T01:00:00Z"), now: now, calendar: utc), .dayYear)
    }

    func testOwnMailNamesItsRecipientsAndTheConversationEndsWithTheNewest() {
        XCTAssertTrue(MailLogic.isOutgoingFolder("sent"))
        XCTAssertFalse(MailLogic.isOutgoingFolder("INBOX"))
        XCTAssertEqual(
            MailLogic.recipientNames([MailAddress("jane@example.com", name: "Jane Doe"), MailAddress("bob@example.com")]),
            "Jane Doe, bob@example.com"
        )
        XCTAssertNil(MailLogic.recipientNames([]))
        let sent = message("m", to: [MailAddress("me@weld.test")], cc: [MailAddress("sanne.bakker@example.com")])
        XCTAssertEqual(MailLogic.recipientsLine(sent, selfAddresses: ["ME@weld.test"], me: "me"), ["me", "Sanne Bakker"])
        let older = message("x", sent: "2026-11-26T09:00:00Z")
        let newer = message("y", sent: "2026-11-27T09:00:00Z")
        XCTAssertEqual(MailLogic.conversation(older, others: [newer, older]).map(\.id), ["x", "y"])
        XCTAssertTrue(MailLogic.isImportant(message("i", labels: ["IMPORTANT"])))
    }

    func testAPinIsTheServersPinnedLabel() {
        XCTAssertTrue(MailLogic.isPinned(message("p", labels: ["pinned"])))
        XCTAssertFalse(MailLogic.isPinned(message("q", labels: ["INBOX"])))
        XCTAssertEqual(MailLogic.withPinned(["INBOX"], on: true), ["INBOX", "PINNED"])
        XCTAssertEqual(MailLogic.withPinned(["INBOX", "PINNED"], on: true), ["INBOX", "PINNED"])
        XCTAssertEqual(MailLogic.withPinned(["INBOX", "PINNED"], on: false), ["INBOX"])
        // The pin is a system label: never a chip on the row.
        XCTAssertEqual(MailLogic.displayLabels(["PINNED"]), [])
    }

    func testTheQuickFiltersPickTheirMessages() {
        let list = [
            message("a", read: true),
            message("b"),
            message("c", read: true, labels: ["STARRED"]),
            message("d", read: true, attachments: true),
        ]
        XCTAssertEqual(MailLogic.filter(list, .unread).map(\.id), ["b"])
        XCTAssertEqual(MailLogic.filter(list, .starred).map(\.id), ["c"])
        XCTAssertEqual(MailLogic.filter(list, .attachments).map(\.id), ["d"])
    }

    func testThreadCountsCountTheLoadedMessagesOfAThread() {
        let counted = MailLogic.withThreadCounts([message("a", thread: "t"), message("b", thread: "t"), message("c")])
        XCTAssertEqual(counted.map(\.threadCount), [2, 2, 1])
    }

    func testARefreshKeepsThePagesAlreadyScrolledTo() {
        let first = [message("n1", sent: "2026-11-27T09:00:00Z"), message("n2", sent: "2026-11-27T08:00:00Z")]
        let older = [message("o1", sent: "2026-11-20T08:00:00Z")]
        let kept = MailLogic.mergeFirstPage(previous: first + older, firstPage: first, firstPageCursor: "n2", previousCursor: "o1", previousKnown: true)
        XCTAssertEqual(kept.messages.map(\.id), ["n1", "n2", "o1"])
        XCTAssertEqual(kept.cursor, "o1")
        // A list from the offline cache has no known place: the page replaces it.
        let fresh = MailLogic.mergeFirstPage(previous: older, firstPage: first, firstPageCursor: "n2", previousCursor: nil, previousKnown: false)
        XCTAssertEqual(fresh.messages.map(\.id), ["n1", "n2"])
        XCTAssertEqual(fresh.cursor, "n2")
    }

    func testAPageAppendsWithoutRepeats() {
        XCTAssertEqual(MailLogic.appendPage([message("a"), message("b")], [message("b"), message("c")]).map(\.id), ["a", "b", "c"])
    }

    func testTheNextMessageFollowsTheListOrder() {
        XCTAssertEqual(MailLogic.nextID(["a", "b", "c"], after: "a"), "b")
        XCTAssertNil(MailLogic.nextID(["a", "b"], after: "b"))
        XCTAssertNil(MailLogic.nextID(["a"], after: "x"))
    }

    func testAddressesSplitOnCommasAndSemicolons() {
        XCTAssertEqual(MailLogic.splitAddresses(" a@b.com, c@d.com;e@f.com "), ["a@b.com", "c@d.com", "e@f.com"])
        XCTAssertEqual(MailLogic.committedAddress("bob@x.com,"), "bob@x.com")
        XCTAssertNil(MailLogic.committedAddress("bob@x.com"))
        XCTAssertEqual(MailLogic.withPending(["a@b.com"], typed: "typed@x.com"), ["a@b.com", "typed@x.com"])
    }

    func testAReplyGoesToTheSenderAndThreads() {
        var original = message(
            "m1",
            from: MailAddress("grace@example.com", name: "Grace"),
            to: [MailAddress("me@acme.com"), MailAddress("bob@example.com")],
            cc: [MailAddress("carol@example.com"), MailAddress("ME@acme.com")]
        )
        original.references = ["<older@x>"]
        let reply = MailLogic.prefill(original, mode: .reply, selfAddresses: ["me@acme.com"], unknownSender: "Unknown")
        XCTAssertEqual(reply.to, ["grace@example.com"])
        XCTAssertEqual(reply.subject, "Re: Invoice")
        XCTAssertEqual(reply.inReplyTo, "<m1@example.com>")
        XCTAssertEqual(reply.references, ["<older@x>", "<m1@example.com>"])

        let all = MailLogic.prefill(original, mode: .replyAll, selfAddresses: ["me@acme.com"], unknownSender: "Unknown")
        XCTAssertEqual(all.to, ["grace@example.com", "bob@example.com"])
        XCTAssertEqual(all.cc, ["carol@example.com"])

        var forwarded = original
        forwarded.subject = "Fwd: Invoice"
        let forward = MailLogic.prefill(forwarded, mode: .forward, selfAddresses: [], unknownSender: "Unknown")
        XCTAssertTrue(forward.to.isEmpty)
        XCTAssertEqual(forward.subject, "Fwd: Invoice")
        XCTAssertNil(forward.inReplyTo)
    }

    func testAReplyToOnesOwnMailGoesToItsRecipients() {
        let sent = message("m2", from: MailAddress("me@acme.com"), to: [MailAddress("bob@example.com")])
        XCTAssertEqual(MailLogic.prefill(sent, mode: .reply, selfAddresses: ["me@acme.com"], unknownSender: "Unknown").to, ["bob@example.com"])
    }

    func testANameWithACommaIsNeverTwoRecipients() {
        XCTAssertEqual(MailLogic.addresses([MailAddress("\"Doe, Jane\" <jane@x.com>")]), ["jane@x.com"])
    }

    func testHtmlBodiesCarryTheQuoteAsHtml() {
        let prefill = ComposePrefill(mode: .reply, quotedBody: "Bob <bob@x.com>\nhi")
        let suffix = MailLogic.quotedSuffix(prefill, label: "Original message", from: "From: x", subject: "Subject: y")
        let payload = MailLogic.sendPayload(
            to: ["a@b.com"], cc: [], bcc: [], subject: " ", text: "Hi", html: "<p>Hi</p>", quotedSuffix: suffix,
            attachments: [], idempotencyKey: "snd_1", inReplyTo: "<m1@x>", references: ["<m1@x>"], noSubject: "(No subject)"
        )
        XCTAssertEqual(payload.subject, "(No subject)")
        XCTAssertNil(payload.body)
        XCTAssertTrue(payload.htmlBody?.contains("Bob &lt;bob@x.com&gt;<br>hi") == true)
        XCTAssertNil(payload.cc)
        XCTAssertEqual(payload.references, ["<m1@x>"])

        let plain = MailLogic.sendPayload(
            to: ["a@b.com"], cc: [], bcc: [], subject: "S", text: "Hi", html: "", quotedSuffix: "",
            attachments: [], idempotencyKey: nil, inReplyTo: nil, references: [], noSubject: "(No subject)"
        )
        XCTAssertEqual(plain.body, "Hi")
        XCTAssertNil(plain.htmlBody)
        XCTAssertNil(plain.references)
    }

    func testAMailWithNothingToReadAsksFirst() {
        XCTAssertTrue(MailLogic.hasNoBody(text: "  ", quotedSuffix: "", attachmentCount: 0))
        XCTAssertFalse(MailLogic.hasNoBody(text: "", quotedSuffix: "", attachmentCount: 1))
        XCTAssertFalse(MailLogic.hasNoBody(text: "", quotedSuffix: "quote", attachmentCount: 0))
    }

    func testSendLaterChoicesStayInTheScheduleWindow() {
        let evening = date("2026-11-27T22:30:00Z")
        let presets = MailLogic.sendLaterPresets(now: evening, calendar: utc)
        XCTAssertEqual(presets.count, 4)
        XCTAssertEqual(utc.component(.hour, from: presets[2].date), 9)
        XCTAssertTrue(MailLogic.isWithinScheduleWindow(now.addingTimeInterval(60), now: now))
        XCTAssertFalse(MailLogic.isWithinScheduleWindow(now.addingTimeInterval(-60), now: now))
        XCTAssertFalse(MailLogic.isWithinScheduleWindow(now.addingTimeInterval(366 * 86_400), now: now))
    }

    func testSnoozeChoicesAreAnHourFourHoursTomorrowAndMonday() {
        let friday = date("2026-11-27T10:00:00Z")
        let presets = MailLogic.snoozePresets(now: friday, calendar: utc).map(\.date)
        XCTAssertEqual(presets[0], friday.addingTimeInterval(3_600))
        XCTAssertEqual(presets[1], friday.addingTimeInterval(4 * 3_600))
        XCTAssertEqual(presets[2], date("2026-11-28T08:00:00Z"))
        XCTAssertEqual(presets[3], date("2026-11-30T08:00:00Z"))
        // On a Monday, "next Monday" is a week later.
        let monday = date("2026-11-30T10:00:00Z")
        XCTAssertEqual(MailLogic.snoozePresets(now: monday, calendar: utc)[3].date, date("2026-12-07T08:00:00Z"))
    }

    func testSubscriptionsKnowHowTheyCanBeLeft() {
        let link = MailSubscription(id: "s", accountID: "a", senderEmail: "news@x.com", lastReceivedAt: "2026-11-01T00:00:00Z", active: true, unsubscribeURL: "https://x")
        XCTAssertTrue(MailLogic.canUnsubscribe(link))
        XCTAssertTrue(MailLogic.isLinkOnly(link))
        var oneClick = link
        oneClick.oneClick = true
        XCTAssertFalse(MailLogic.isLinkOnly(oneClick))
        XCTAssertEqual(MailLogic.subscription(in: [link], for: " NEWS@x.com "), link)
        var after = link
        after.active = false
        after.unsubscribedAt = "2026-10-01T00:00:00Z"
        XCTAssertTrue(MailLogic.stillSending(after))
        XCTAssertTrue(MailLogic.matches(link, query: "NEWS"))
    }

    func testPushIdsAreCheckedBeforeUse() {
        let target = MailLogic.notificationTarget(["emailId": "msg_1", "emailAccountId": "mail_2", "subject": "Hello\u{0}there", "fromName": "Grace"])
        XCTAssertEqual(target?.emailID, "msg_1")
        XCTAssertEqual(target?.accountID, "mail_2")
        XCTAssertEqual(target?.subject, "Hello there")
        XCTAssertNil(MailLogic.notificationTarget(["emailId": "../../etc", "emailAccountId": "a b"]))
        XCTAssertEqual(MailLogic.notificationTarget(["entityType": "email", "entityId": "msg_9"])?.emailID, "msg_9")
    }

    func testAttachmentsAreKnownByTheirExtension() {
        XCTAssertEqual(MailLogic.attachmentKind("invoice.PDF"), .pdf)
        XCTAssertEqual(MailLogic.attachmentKind("README"), .file)
        XCTAssertEqual(MailLogic.extensionLabel("a.xlsx"), "XLSX")
        XCTAssertEqual(MailLogic.extensionLabel("a.verylong"), "")
        XCTAssertEqual(MailLogic.fileSize(2048), "2 KB")
        XCTAssertEqual(MailLogic.fileSize(1_572_864), "1.5 MB")
        XCTAssertFalse(MailLogic.safeFileName("../etc/passwd").contains("/"))
        XCTAssertEqual(MailLogic.safeFileName("..."), "attachment")
    }

    func testAnIdempotencyKeyFitsTheServersLimit() {
        let key = MailLogic.idempotencyKey(nowMillis: 1_700_000_000_000) { _ in 35 }
        XCTAssertEqual(key, "snd_1700000000000_zzzzzzzz")
        XCTAssertLessThanOrEqual(key.count, 64)
    }
}

final class MailRulesTests: XCTestCase {
    // MARK: Search

    func testSearchFiltersApplyOnThePhone() {
        let now = date("2026-11-27T12:00:00Z")
        let list = [
            message("mine", from: MailAddress("me@acme.com"), to: [MailAddress("bob@x.com")]),
            message("theirs", sent: "2026-11-26T08:00:00Z", to: [MailAddress("me@acme.com")]),
            message("old", sent: "2026-01-02T08:00:00Z", read: true, attachments: true),
        ]
        let own = ["ME@acme.com"]
        XCTAssertEqual(SearchLogic.apply(list, filters: SearchFilters(fromMe: true), own: own, now: now, calendar: utc).map(\.id), ["mine"])
        XCTAssertEqual(SearchLogic.apply(list, filters: SearchFilters(toMe: true), own: own, now: now, calendar: utc).map(\.id), ["theirs"])
        XCTAssertEqual(SearchLogic.apply(list, filters: SearchFilters(date: .yesterday), own: own, now: now, calendar: utc).map(\.id), ["theirs"])
        XCTAssertEqual(SearchLogic.apply(list, filters: SearchFilters(attachment: true, unread: false), own: own, now: now, calendar: utc).map(\.id), ["old"])
        XCTAssertEqual(SearchLogic.apply(list, filters: SearchFilters(date: .thisYear), own: own, now: now, calendar: utc).count, 3)
        XCTAssertFalse(SearchFilters().isActive)
        XCTAssertTrue(SearchFilters(label: "SENT").isActive)
    }

    func testTheWeekStartsOnMonday() {
        let friday = date("2026-11-27T12:00:00Z")
        XCTAssertTrue(SearchLogic.inRange("2026-11-23T00:30:00Z", .thisWeek, now: friday, calendar: utc))
        XCTAssertFalse(SearchLogic.inRange("2026-11-22T23:30:00Z", .thisWeek, now: friday, calendar: utc))
        XCTAssertFalse(SearchLogic.inRange("not a date", .today, now: friday, calendar: utc))
    }

    func testMatchesIgnoreCaseAndNeverOverlap() {
        let text = "Invoice invoice"
        XCTAssertEqual(SearchLogic.matches(text, "INV").map { String(text[$0]) }, ["Inv", "inv"])
        XCTAssertEqual(SearchLogic.matches("aaaa", "aa").count, 2)
        XCTAssertTrue(SearchLogic.matches("text", "  ").isEmpty)
    }

    // MARK: Contacts

    private func person(_ id: String, _ email: String?, first: String? = nil, last: String? = nil) -> MailContact {
        MailContact(id: id, email: email, firstName: first, lastName: last)
    }

    func testOnlyTheExactAddressIsTheSender() {
        let people = [person("p1", "grace.h@example.com"), person("p2", "Grace@Example.com")]
        XCTAssertEqual(ContactLogic.exactMatch(people, email: " grace@example.com ")?.id, "p2")
        XCTAssertNil(ContactLogic.exactMatch(people, email: "ada@example.com"))
        let placeholder = ContactLogic.placeholder("ada@example.com")
        XCTAssertEqual(placeholder.firstName, "ada")
        XCTAssertEqual(placeholder.id, "ada@example.com")
    }

    func testANameEditSplitsAtTheFirstSpace() {
        XCTAssertEqual(ContactLogic.change(.name, "Ada King Lovelace"), ContactLogic.Change(firstName: "Ada", lastName: "King Lovelace"))
        XCTAssertEqual(ContactLogic.change(.name, "Ada"), ContactLogic.Change(firstName: "Ada", lastName: ""))
        XCTAssertEqual(ContactLogic.change(.phone, "+31 6"), ContactLogic.Change(phone: "+31 6"))
        XCTAssertEqual(ContactLogic.change(.address, "x"), ContactLogic.Change())
    }

    func testOnlyDigitsGoIntoACallLink() {
        XCTAssertEqual(ContactLogic.dialable("+31 (6) 1234-5678"), "+31612345678")
        XCTAssertEqual(ContactLogic.dialable("12,34#"), "1234")
        XCTAssertTrue(ContactLogic.isEmail(" ada@example.com "))
        XCTAssertFalse(ContactLogic.isEmail("ada@example"))
        XCTAssertEqual(ContactLogic.displayName(person("p", nil, first: "Ada", last: "King")), "Ada King")
        XCTAssertNil(ContactLogic.value(person("p", " "), .email))
    }

    // MARK: New mailboxes

    func testAnAddressKeepsOnlyWhatAMailboxNameMayHold() {
        XCTAssertEqual(AddAccountLogic.cleanAddress("Ada.K-1_x @é!"), "ada.k-1_x")
        XCTAssertEqual(AddAccountLogic.check(Availability(available: true, reason: nil)), .available)
        XCTAssertEqual(AddAccountLogic.check(Availability(available: false, reason: "reserved")), .unavailable("reserved"))
        XCTAssertEqual(AddAccountLogic.check(Availability(available: false, reason: nil)), .unavailable("taken"))
    }

    // MARK: Links

    func testLinksOpenTheirScreens() {
        XCTAssertEqual(URL(string: "weldmail://message/msg_1").flatMap(MailLinkRoute.of), .message("msg_1"))
        XCTAssertNil(URL(string: "weldmail://message/..%2F..").flatMap(MailLinkRoute.of))
        XCTAssertEqual(
            URL(string: "weldmail://compose?to=a@b.com,c@d.com&subject=Hi").flatMap(MailLinkRoute.of),
            .compose(to: ["a@b.com", "c@d.com"], subject: "Hi")
        )
        XCTAssertEqual(URL(string: "weldmail://subscriptions").flatMap(MailLinkRoute.of), .subscriptions)
        XCTAssertNil(URL(string: "https://message/msg_1").flatMap(MailLinkRoute.of))
    }

    // MARK: Send errors

    func testASendingLimitSaysWhichAndWhen() {
        let now = date("2026-11-27T10:00:00Z")
        let alert = SendErrors.describe(
            code: "SENDING_LIMITED",
            details: SendErrorDetails(limit: 500, window: "day", retryAfter: "2026-11-27T10:25:00Z", suggestWeldReach: true),
            now: now,
            locale: Locale(identifier: "en_US_POSIX")
        )
        XCTAssertEqual(alert?.title, MailStrings.sendErrorDailyTitle)
        XCTAssertEqual(alert?.lines.count, 4)
        XCTAssertEqual(alert?.lines[1], MailStrings.sendErrorLimitPerDay(limit: "500"))
        XCTAssertEqual(alert?.lines[2], MailStrings.sendErrorRetryWhen(when: MailStrings.sendErrorWhenMinutes(25)))
        XCTAssertNil(SendErrors.describe(code: nil, details: SendErrorDetails(), now: now))
        XCTAssertNil(SendErrors.describe(code: "SOMETHING_NEW", details: SendErrorDetails(), now: now))
        XCTAssertNil(SendErrors.describe(code: "PARTIALLY_SENT", details: SendErrorDetails(), now: now))
    }

    func testRetryTimesRoundUp() {
        let now = date("2026-11-27T10:00:00Z")
        XCTAssertEqual(SendErrors.whenText("2026-11-27T09:00:00Z", now: now), MailStrings.sendErrorWhenMoment)
        XCTAssertEqual(SendErrors.whenText("2026-11-27T11:30:00Z", now: now), MailStrings.sendErrorWhenHours(2))
        XCTAssertEqual(SendErrors.whenText("2026-11-28T10:00:00Z", now: now), MailStrings.sendErrorWhenTomorrow)
        XCTAssertEqual(SendErrors.whenText("2026-11-30T09:00:00Z", now: now), MailStrings.sendErrorWhenDays(3))
        XCTAssertNil(SendErrors.whenText("soon", now: now))
    }

    func testALongRecipientListIsShortened() {
        XCTAssertEqual(SendErrors.list(["a", "b"]), "a, b")
        XCTAssertEqual(SendErrors.list(["a", "b", "c", "d", "e"]), "a, b, c " + MailStrings.commonAndMore(2))
    }

    // MARK: Email HTML

    func testScriptsHandlersAndScriptLinksAreStripped() {
        let dirty = #"<p onclick="x()">Hi</p><script>alert(1)</script><a href=" javascript:alert(1)">x</a><iframe src="https://e"></iframe><form><input></form>"#
        let clean = EmailHTML.sanitize(dirty)
        XCTAssertFalse(clean.lowercased().contains("<script"))
        XCTAssertFalse(clean.contains("onclick"))
        XCTAssertFalse(clean.contains("iframe"))
        XCTAssertFalse(clean.contains("<form"))
        XCTAssertTrue(clean.contains("href=\"#"))
        XCTAssertTrue(EmailHTML.document("<p>x</p>").contains("Content-Security-Policy"))
    }

    func testAWholeDocumentKeepsItsStylesAndBody() {
        let html = ##"<html><head><style>p{}</style><title>t</title></head><body bgcolor="#eee" style="margin:0"><p>Body</p></body></html>"##
        XCTAssertEqual(EmailHTML.unwrap(html), ##"<style>p{}</style><div bgcolor="#eee" style="margin:0"><p>Body</p></div>"##)
        XCTAssertEqual(EmailHTML.unwrap("<p>plain</p>"), "<p>plain</p>")
        XCTAssertEqual(EmailHTML.trimTrailingEmpty("<p>Hi</p><div><br></div><br>&nbsp; "), "<p>Hi</p>")
    }

    func testLinksNeverLoadInTheFrame() {
        XCTAssertTrue(EmailHTML.isInlineDocumentLoad("https://email.local/", loaded: true))
        XCTAssertTrue(EmailHTML.isInlineDocumentLoad("https://email.local/#top", loaded: true))
        XCTAssertFalse(EmailHTML.isInlineDocumentLoad("https://email.local@evil.com/", loaded: true))
        XCTAssertTrue(EmailHTML.isInlineDocumentLoad("about:blank", loaded: true))
        XCTAssertTrue(EmailHTML.isInlineDocumentLoad("data:text/html,x", loaded: false))
        XCTAssertFalse(EmailHTML.isInlineDocumentLoad("data:text/html,x", loaded: true))
        XCTAssertEqual(EmailHTML.linkAction("HTTPS://example.com"), .browser)
        XCTAssertEqual(EmailHTML.linkAction("mailto:a@b.com"), .system)
        XCTAssertEqual(EmailHTML.linkAction("intent://x"), .block)
    }
}

@MainActor
final class OutboxTests: XCTestCase {
    private func update(_ id: String, _ message: String, _ patch: FlagPatch) -> OutboxOp {
        .update(id, message: message, patch: patch, now: 0)
    }

    func testFlagChangesMergeAndADeleteWins() {
        var ops = OutboxRules.collapse([], update("1", "m", FlagPatch(isRead: true)))
        ops = OutboxRules.collapse(ops, update("2", "m", FlagPatch(isStarred: true)))
        XCTAssertEqual(ops.count, 1)
        XCTAssertEqual(ops.first?.patch, FlagPatch(isRead: true, isStarred: true))
        ops = OutboxRules.collapse(ops, .archive("3", message: "m", now: 0))
        ops = OutboxRules.collapse(ops, .archive("4", message: "m", now: 0))
        XCTAssertEqual(ops.count, 2)
        ops = OutboxRules.collapse(ops, .delete("5", message: "m", now: 0))
        XCTAssertEqual(ops.map(\.id), ["5"])
        // Nothing queues for a message being deleted; sends always queue.
        XCTAssertEqual(OutboxRules.collapse(ops, update("6", "m", FlagPatch(isRead: false))), ops)
        let send = OutboxOp.send("7", account: "mail_1", payload: SendPayload(to: ["a@b.com"], subject: "Hi"), now: 0)
        XCTAssertEqual(OutboxRules.collapse(ops, send).count, 2)
    }

    func testTheLatestSnoozeChoiceWins() {
        var ops = OutboxRules.collapse([], .snooze("1", message: "m", account: "a", until: "2026-12-01T08:00:00Z", now: 0))
        ops = OutboxRules.collapse(ops, .unsnooze("2", message: "m", account: "a", now: 0))
        XCTAssertEqual(ops.map(\.id), ["2"])
    }

    func testTheQueueIsLaidOverTheList() {
        let list = [message("a"), message("b"), message("c"), message("d")]
        let ops: [OutboxOp] = [
            update("1", "a", FlagPatch(isRead: true)),
            .archive("2", message: "b", now: 0),
            .delete("3", message: "c", now: 0),
            .snooze("4", message: "d", account: "acc", until: "2026-12-01T08:00:00Z", now: 0),
        ]
        let inbox = OutboxRules.overlay(list, ops, label: "INBOX")
        XCTAssertEqual(inbox.map(\.id), ["a"])
        XCTAssertEqual(inbox.first?.isRead, true)
        XCTAssertEqual(OutboxRules.overlay(list, ops, label: "archive").map(\.id), ["a", "b"])
        XCTAssertEqual(OutboxRules.overlay(list, ops, label: "SNOOZED").map(\.id), ["a", "d"])
    }

    func testAReplayKeepsWhatCouldNotGoOutYet() async {
        struct Busy: Error {}
        struct Refused: Error {}
        let ops = ["ok", "busy", "refused", "offline", "later"].map { update($0, "m-\($0)", FlagPatch(isRead: true)) }
        let replay = await OutboxRules.replay(ops, run: { op in
            switch op.id {
            case "busy": throw Busy()
            case "refused": throw Refused()
            case "offline": throw URLError(.notConnectedToInternet)
            default: return
            }
        }, classify: { error in
            if error is URLError { return .network }
            if error is Busy { return .transient }
            return .rejected
        })
        XCTAssertEqual(replay.succeeded, 1)
        XCTAssertEqual(replay.dropped, 1)
        let meanwhile = update("new", "f", FlagPatch(isStarred: true))
        let next = replay.applied(to: ops + [meanwhile], before: ops)
        XCTAssertEqual(next.map(\.id), ["busy", "offline", "later", "new"])
        XCTAssertEqual(next.first?.attempts, 1)
        // An op that failed too often is dropped without being sent.
        var worn = update("worn", "g", FlagPatch(isRead: true))
        worn.attempts = OutboxRules.maxAttempts
        let dropped = await OutboxRules.replay([worn], run: { _ in XCTFail("sent") }, classify: { _ in .transient })
        XCTAssertEqual(dropped.dropped, 1)
    }

    func testAFailureIsSortedForTheQueue() {
        XCTAssertEqual(MailStore.classify(APIError(status: nil, code: nil)), .network)
        XCTAssertEqual(MailStore.classify(APIError(status: 503, code: nil)), .transient)
        XCTAssertEqual(MailStore.classify(APIError(status: 401, code: nil)), .transient)
        XCTAssertEqual(MailStore.classify(APIError(status: 404, code: nil)), .rejected)
        XCTAssertEqual(MailStore.classify(SendFailure(status: 422, code: "INVALID_RECIPIENTS", message: nil, details: SendErrorDetails())), .rejected)
    }
}
