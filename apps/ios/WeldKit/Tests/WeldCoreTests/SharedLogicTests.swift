import XCTest
@testable import WeldCore

/// The realtime, push and formatting helpers the apps share.
final class SharedLogicTests: XCTestCase {
    func testRealtimeBaseDropsTheWsSuffixAndFallsBackToTheServer() {
        let server = URL(string: "https://app.weldsuite.eu")!
        XCTAssertEqual(realtimeBase("wss://app.test.weldsuite.eu/ws", server: server).absoluteString, "wss://app.test.weldsuite.eu")
        XCTAssertEqual(realtimeBase("wss://rt.example.com/", server: server).absoluteString, "wss://rt.example.com")
        XCTAssertEqual(realtimeBase(nil, server: server).absoluteString, "wss://app.weldsuite.eu")
        XCTAssertEqual(realtimeBase("  ", server: server).absoluteString, "wss://app.weldsuite.eu")
    }

    func testATopicMatchesItselfAndItsChildren() {
        XCTAssertTrue(realtimeTopic("ticket", matches: "ticket"))
        XCTAssertTrue(realtimeTopic("ticket.tkt_1", matches: "ticket"))
        XCTAssertFalse(realtimeTopic("tickets", matches: "ticket"))
        XCTAssertFalse(realtimeTopic("ticket", matches: "ticket.tkt_1"))
    }

    func testAPushPayloadReadsTheDataObjectAndSkipsEmptyValues() {
        let payload = PushPayload(userInfo: [
            "aps": ["alert": ["title": "Hi"]],
            "data": ["notificationType": "chat_dm", "entityId": "", "chatChannelId": "ch_1", "badge": 3],
        ])
        XCTAssertEqual(payload.notificationType, "chat_dm")
        XCTAssertNil(payload.entityID)
        XCTAssertEqual(payload["chatChannelId"], "ch_1")
        XCTAssertEqual(payload["badge"], "3")
    }

    func testAPushPayloadWithoutDataReadsTheTopLevel() {
        let payload = PushPayload(userInfo: ["aps": ["badge": 1], "notificationType": "ticket_assigned", "server": "https://app.weldsuite.eu"])
        XCTAssertEqual(payload.notificationType, "ticket_assigned")
        XCTAssertEqual(payload.server, "https://app.weldsuite.eu")
        XCTAssertNil(payload["aps"])
    }

    func testTimestampsAndDaysParse() {
        XCTAssertEqual(WeldDate.parse("2026-11-27T09:30:00.000Z")?.timeIntervalSince1970, 1_795_771_800)
        XCTAssertEqual(WeldDate.parse("2026-11-27T09:30:00Z")?.timeIntervalSince1970, 1_795_771_800)
        XCTAssertNotNil(WeldDate.parse("2026-11-27"))
        XCTAssertNil(WeldDate.parse(""))
        XCTAssertNil(WeldDate.parse("not a date"))
        let day = WeldDate.day("2026-11-27T23:59:00Z")!
        XCTAssertEqual(WeldDate.dayString(day), "2026-11-27")
    }

    func testMoneyParsesDecimalStringsAndWritesTwoDecimals() {
        XCTAssertEqual(Money.parse("1250.50"), Decimal(string: "1250.5"))
        XCTAssertNil(Money.parse("abc"))
        XCTAssertNil(Money.parse(nil))
        XCTAssertEqual(Money.apiString(Decimal(string: "12.345")!), "12.35")
        XCTAssertEqual(Money.apiString(Decimal(10)), "10.00")
    }

    func testErrorMessagesFollowTheFailure() {
        XCTAssertEqual(apiErrorMessage(APIError(status: nil, code: nil)), CoreStrings.errorsOffline)
        XCTAssertEqual(apiErrorMessage(APIError(status: 403, code: nil)), CoreStrings.errorsForbidden)
        XCTAssertEqual(apiErrorMessage(APIError(status: 404, code: nil)), CoreStrings.errorsNotFound)
        XCTAssertEqual(apiErrorMessage(APIError(status: 500, code: nil)), CoreStrings.errorsGeneric)
        XCTAssertEqual(apiErrorMessage(nil), CoreStrings.errorsGeneric)
    }

    func testALoadStateIsAFirstLoadUntilDataOrAnErrorArrives() {
        XCTAssertTrue(LoadState<[Int]>().isFirstLoad)
        XCTAssertFalse(LoadState(data: [1]).isFirstLoad)
        XCTAssertFalse(LoadState<[Int]>(error: APIError(status: nil, code: nil)).isFirstLoad)
    }
}
