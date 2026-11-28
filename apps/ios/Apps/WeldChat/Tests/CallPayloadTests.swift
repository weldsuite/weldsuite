import WeldCore
import XCTest
@testable import WeldChat

final class CallPayloadTests: XCTestCase {
    private let ringData: [String: String] = [
        "notificationType": "chat_call_ring",
        "callId": "call_1",
        "entityId": "call_1",
        "chatChannelId": "ch_1",
        "callType": "video",
        "callerName": "Ann de Vries",
        "callerAvatar": "https://example.com/ann.png",
        "declineToken": "tok.sig",
        "expiresAt": "1767261600000",
        "server": "https://app.test.weldsuite.eu",
        "actionUrl": "/weldchat/dm/ch_1",
    ]

    func testARingPushReadsTheRenamedChannelAndEverythingElse() {
        guard case let .ring(ring)? = CallPayloads.parseCallPush(ringData) else {
            return XCTFail("a ring")
        }
        XCTAssertEqual(ring.callID, "call_1")
        XCTAssertEqual(ring.channelID, "ch_1")
        XCTAssertEqual(ring.callType, .video)
        XCTAssertEqual(ring.callerName, "Ann de Vries")
        XCTAssertEqual(ring.callerAvatar, "https://example.com/ann.png")
        XCTAssertEqual(ring.declineToken, "tok.sig")
        XCTAssertEqual(ring.expiresAt, 1_767_261_600_000)
        XCTAssertEqual(ring.server, "https://app.test.weldsuite.eu")
    }

    func testARingFallsBackToTheEntityIdAndTheActionURL() {
        var data = ringData
        data["callId"] = nil
        data["chatChannelId"] = nil
        data["callType"] = "something"
        guard case let .ring(ring)? = CallPayloads.parseCallPush(data) else {
            return XCTFail("a ring")
        }
        XCTAssertEqual(ring.callID, "call_1")
        XCTAssertEqual(ring.channelID, "ch_1")
        XCTAssertEqual(ring.callType, .voice)
    }

    func testARingWithoutAChannelOrWithABadIdIsNoRing() {
        var noChannel = ringData
        noChannel["chatChannelId"] = nil
        noChannel["actionUrl"] = nil
        XCTAssertNil(CallPayloads.parseCallPush(noChannel))

        var badID = ringData
        badID["callId"] = "call 1; drop"
        XCTAssertNil(CallPayloads.parseCallPush(badID))

        var other = ringData
        other["notificationType"] = "chat_mention"
        XCTAssertNil(CallPayloads.parseCallPush(other))
    }

    func testACancelKeepsItsReasonOrDefaultsToEnded() {
        XCTAssertEqual(
            CallPayloads.parseCallPush(["notificationType": "chat_call_cancel", "callId": "call_1", "reason": "answered"]),
            .cancel(callID: "call_1", reason: "answered")
        )
        XCTAssertEqual(
            CallPayloads.parseCallPush(["notificationType": "chat_call_cancel", "callId": "call_1"]),
            .cancel(callID: "call_1", reason: "ended")
        )
    }

    func testTheIncomingCallNotificationRings() {
        let ring = CallPayloads.incoming(fromNotification: [
            "notificationType": "chat_incoming_call",
            "entityId": "call_2",
            "actionUrl": "/weldchat/dm/ch_9?messageId=m_1",
            "callType": "voice",
            "callerName": "  ",
        ])
        XCTAssertEqual(ring?.callID, "call_2")
        XCTAssertEqual(ring?.channelID, "ch_9")
        XCTAssertEqual(ring?.callType, .voice)
        XCTAssertNil(ring?.callerName, "a blank name reads as an unknown caller")
        XCTAssertNil(CallPayloads.incoming(fromNotification: ["notificationType": "chat_mention", "entityId": "x"]))
    }

    func testTheRealtimeRing() {
        let ring = CallPayloads.incoming(fromEvent: [
            "callId": "call_3",
            "channelId": "ch_3",
            "callType": "video",
            "callerName": "Bob",
        ])
        XCTAssertEqual(ring?.callID, "call_3")
        XCTAssertEqual(ring?.channelID, "ch_3")
        XCTAssertEqual(ring?.callType, .video)
        XCTAssertEqual(ring?.callerName, "Bob")
        XCTAssertNil(CallPayloads.incoming(fromEvent: ["channelId": "ch_3"]))
    }

    func testTheChannelOfAnActionURL() {
        XCTAssertEqual(CallPayloads.channelID(fromActionURL: "/weldchat/ch_1"), "ch_1")
        XCTAssertEqual(CallPayloads.channelID(fromActionURL: "/weldchat/dm/ch_2"), "ch_2")
        XCTAssertEqual(CallPayloads.channelID(fromActionURL: "/weldchat/ch_3?messageId=m"), "ch_3")
        XCTAssertNil(CallPayloads.channelID(fromActionURL: "/weldcrm/company/1"))
        XCTAssertNil(CallPayloads.channelID(fromActionURL: nil))
    }

    func testANativePayloadComesBackAsTheSameRing() throws {
        guard case let .ring(ring)? = CallPayloads.parseCallPush(ringData) else {
            return XCTFail("a ring")
        }
        let native = CallPayloads.nativePayload(ring)
        XCTAssertEqual(native["channelId"], "ch_1")
        XCTAssertEqual(native["expiresAt"], "1767261600000")
        XCTAssertEqual(CallPayloads.incoming(fromNative: native), ring)
    }

    func testTheCallKitUUIDIsStablePerCall() {
        let first = callKitUUID(for: "call_1")
        XCTAssertEqual(first, callKitUUID(for: "call_1"))
        XCTAssertNotEqual(first, callKitUUID(for: "call_2"))
        // A name-based UUID: version 5, RFC 4122 variant.
        XCTAssertEqual(first.uuid.6 >> 4, 5)
        XCTAssertEqual(first.uuid.8 >> 6, 2)
    }

    func testTheLiveKitServerComesFromTheConfig() {
        XCTAssertEqual(CallRules.liveKitURL(provider: "livekit", url: "wss://video.example.eu/"), "wss://video.example.eu")
        XCTAssertEqual(CallRules.liveKitURL(provider: " LiveKit ", url: "https://video.example.eu"), "https://video.example.eu")
        XCTAssertNil(CallRules.liveKitURL(provider: "realtimekit", url: "wss://video.example.eu"))
        XCTAssertNil(CallRules.liveKitURL(provider: nil, url: "wss://video.example.eu"))
        XCTAssertNil(CallRules.liveKitURL(provider: "livekit", url: nil))
        XCTAssertNil(CallRules.liveKitURL(provider: "livekit", url: "ftp://video.example.eu"))
        XCTAssertNil(CallRules.liveKitURL(provider: "livekit", url: "wss://"))
    }
}
