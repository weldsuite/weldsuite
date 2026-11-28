import WeldCore
import XCTest
@testable import WeldChat

final class CallRulesTests: XCTestCase {
    private func entry(
        channelType: String? = "dm",
        channelName: String? = "Ann, Bob",
        callType: CallType = .voice,
        direction: String = "incoming",
        outcome: String = "answered",
        counterpart: CallPersonInfo? = CallPersonInfo(userID: "u_ann", name: "Ann", avatar: nil),
        others: [CallPersonInfo] = [CallPersonInfo(userID: "u_ann", name: "Ann", avatar: nil)],
        duration: Int? = nil
    ) -> CallHistoryEntry {
        CallHistoryEntry(
            id: "call_1",
            channelID: "ch_1",
            channelType: channelType,
            channelName: channelName,
            callType: callType,
            status: "ended",
            direction: direction,
            outcome: outcome,
            counterpart: counterpart,
            otherMembers: others,
            duration: duration,
            createdAt: "2026-11-27T09:30:00.000Z"
        )
    }

    func testDurations() {
        XCTAssertEqual(CallRules.duration(5), "0:05")
        XCTAssertEqual(CallRules.duration(65), "1:05")
        XCTAssertEqual(CallRules.duration(3725), "1:02:05")
        XCTAssertEqual(CallRules.timer(42), "00:42")
        XCTAssertEqual(CallRules.timer(725), "12:05")
        XCTAssertEqual(CallRules.timer(4500), "75:00")
        XCTAssertEqual(CallRules.timer(-3), "00:00")
    }

    func testTheTitleIsThePersonThePeopleOrTheChannel() {
        XCTAssertEqual(CallRules.title(entry()), "Ann")
        XCTAssertEqual(CallRules.title(entry(counterpart: nil)), "Ann, Bob", "the DM's name without a counterpart")
        XCTAssertEqual(CallRules.title(entry(channelName: nil, counterpart: nil, others: [])), ChatStrings.callsUnknown)
        let group = entry(others: [
            CallPersonInfo(userID: "u_ann", name: "Ann", avatar: nil),
            CallPersonInfo(userID: "u_bob", name: nil, avatar: nil),
        ])
        XCTAssertTrue(CallRules.isGroupDM(group))
        XCTAssertEqual(CallRules.title(group), "Ann, \(ChatStrings.callsUnknown)")
        XCTAssertEqual(CallRules.title(entry(channelType: "public", channelName: "general")), "#general")
        XCTAssertFalse(CallRules.isDM(entry(channelType: "private")))
    }

    func testHowACallWentFromEitherSide() {
        XCTAssertEqual(CallRules.outcomeLabel(entry(direction: "incoming", outcome: "missed")), ChatStrings.callsMissed)
        XCTAssertEqual(CallRules.outcomeLabel(entry(direction: "outgoing", outcome: "missed")), ChatStrings.callsNoAnswer)
        XCTAssertEqual(CallRules.outcomeLabel(entry(outcome: "declined")), ChatStrings.callsDeclined)
        XCTAssertEqual(CallRules.outcomeLabel(entry(outcome: "ongoing")), ChatStrings.callsOngoing)
        XCTAssertEqual(CallRules.outcomeLabel(entry(direction: "incoming")), ChatStrings.callsIncoming)
        XCTAssertEqual(CallRules.outcomeLabel(entry(direction: "outgoing")), ChatStrings.callsOutgoing)
        XCTAssertTrue(CallRules.isMissedIncoming(entry(direction: "incoming", outcome: "missed")))
        XCTAssertFalse(CallRules.isMissedIncoming(entry(direction: "outgoing", outcome: "missed")))
    }

    func testTheSubtitleAddsTheLengthOfAnAnsweredCall() {
        let answered = entry(callType: .video, direction: "outgoing", outcome: "answered", duration: 65)
        XCTAssertEqual(
            CallRules.subtitle(answered),
            CallRules.joined([ChatStrings.callsOutgoing, ChatStrings.callsVideoCall, "1:05"])
        )
        let missed = entry(direction: "incoming", outcome: "missed", duration: 30)
        XCTAssertEqual(CallRules.subtitle(missed), CallRules.joined([ChatStrings.callsMissed, ChatStrings.callsVoiceCall]))
    }

    func testJoinedFoldsEveryPart() {
        XCTAssertEqual(CallRules.joined([]), "")
        XCTAssertEqual(CallRules.joined(["a"]), "a")
        XCTAssertEqual(
            CallRules.joined(["a", "b", "c"]),
            ChatStrings.callBarTitle(name: ChatStrings.callBarTitle(name: "a", status: "b"), status: "c")
        )
    }

    func testOnlyADMRingFromSomeoneElseWaitingForThePersonIsRecovered() {
        func call(_ id: String, type: String?, initiator: String?, count: Int, status: String = "ringing") -> ActiveCallSummary {
            ActiveCallSummary(
                channelID: "ch_\(id)",
                callID: id,
                callType: .voice,
                status: status,
                participantCount: count,
                initiatorID: initiator,
                initiatorName: "Ann",
                channelType: type
            )
        }
        let calls = [
            call("huddle", type: "public", initiator: "u_ann", count: 1),
            call("mine", type: "dm", initiator: "u_me", count: 1),
            call("answered", type: "dm", initiator: "u_ann", count: 2),
            call("old-api", type: nil, initiator: "u_ann", count: 1),
            call("ended", type: "dm", initiator: "u_ann", count: 1, status: "ended"),
            call("ringing", type: "dm", initiator: "u_ann", count: 1),
        ]
        XCTAssertEqual(CallRules.recoverableRing(calls, selfID: "u_me")?.callID, "ringing")
        XCTAssertNil(CallRules.recoverableRing(Array(calls.prefix(5)), selfID: "u_me"))
    }

    func testAnAnsweredCallIsWithTheCallerInTheRoom() {
        let participants = [
            CallParticipantInfo(userID: "u_me", name: "Me", avatar: nil, leftAt: nil),
            CallParticipantInfo(userID: "u_gone", name: "Gone", avatar: nil, leftAt: "2026-11-27T09:00:00.000Z"),
            CallParticipantInfo(userID: "u_ann", name: "Ann", avatar: "https://example.com/a.png", leftAt: nil),
        ]
        let peer = CallRules.peerOfAnsweredCall(callerName: nil, callerAvatar: nil, participants: participants, selfID: "u_me")
        XCTAssertEqual(peer.name, "Ann")
        XCTAssertEqual(peer.avatar, "https://example.com/a.png")
        let fromRing = CallRules.peerOfAnsweredCall(callerName: "Bob", callerAvatar: "b.png", participants: [], selfID: "u_me")
        XCTAssertEqual(fromRing.name, "Bob")
        XCTAssertEqual(fromRing.avatar, "b.png")
    }

    func testRecentsTimes() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "Europe/Amsterdam"))
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 11, day: 27, hour: 15)))
        let earlier = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 11, day: 27, hour: 9)))
        let yesterday = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 11, day: 26, hour: 22)))
        let thisWeek = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 11, day: 24, hour: 10)))
        let older = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: 2, hour: 10)))
        XCTAssertEqual(CallRules.time(earlier, now: now, calendar: calendar), earlier.formatted(date: .omitted, time: .shortened))
        XCTAssertEqual(CallRules.time(yesterday, now: now, calendar: calendar), CoreStrings.commonYesterday)
        XCTAssertEqual(CallRules.time(thisWeek, now: now, calendar: calendar), thisWeek.formatted(.dateTime.weekday(.wide)))
        XCTAssertEqual(CallRules.time(older, now: now, calendar: calendar), older.formatted(date: .numeric, time: .omitted))
    }

    func testWhatTheCallScreenSaysUnderTheName() {
        XCTAssertEqual(CallRules.connectingLabel(isDirect: true, answered: false, peerName: "Ann"), ChatStrings.callCalling(name: "Ann"))
        XCTAssertEqual(CallRules.connectingLabel(isDirect: true, answered: false, peerName: nil), ChatStrings.callCallingSomeone)
        XCTAssertEqual(CallRules.connectingLabel(isDirect: true, answered: true, peerName: "Ann"), ChatStrings.callConnecting)
        XCTAssertEqual(CallRules.connectingLabel(isDirect: false, answered: false, peerName: "#general"), ChatStrings.callConnecting)

        XCTAssertEqual(CallRules.statusLabel(answered: false, reconnecting: true, peerJoined: true, seconds: 5), ChatStrings.callReconnecting)
        XCTAssertEqual(CallRules.statusLabel(answered: false, reconnecting: false, peerJoined: true, seconds: 65), "01:05")
        XCTAssertEqual(CallRules.statusLabel(answered: false, reconnecting: false, peerJoined: false, seconds: 0), ChatStrings.callRinging)
        XCTAssertEqual(CallRules.statusLabel(answered: true, reconnecting: false, peerJoined: false, seconds: 0), ChatStrings.callConnecting)
    }

    func testCallTypesReadTheServersWord() {
        XCTAssertEqual(CallType(wire: "video"), .video)
        XCTAssertEqual(CallType(wire: "voice"), .voice)
        XCTAssertEqual(CallType(wire: nil), .voice)
        XCTAssertEqual(CallType(wire: "screen"), .voice)
    }
}
