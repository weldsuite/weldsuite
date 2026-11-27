package com.weldsuite.weldchat.calls

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

/** The call pushes and the call screens' rules (the iOS app's CallPayloadTests and CallRulesTests). */
class CallRulesTest {
    private val ring = mapOf(
        "notificationType" to "chat_call_ring",
        "callId" to "call_1",
        "entityId" to "call_1",
        "chatChannelId" to "ch_1",
        "callType" to "video",
        "callerName" to "Ann de Vries",
        "callerAvatar" to "https://example.com/ann.png",
        "declineToken" to "tok.sig",
        "expiresAt" to "1767261600000",
        "server" to "https://app.test.weldsuite.eu",
        "actionUrl" to "/weldchat/dm/ch_1",
    )

    @Test
    fun aRingPushReadsEverything() {
        val push = CallPushes.parse(ring) as? CallPush.Ring ?: error("a ring")
        assertEquals(
            IncomingCall("call_1", "ch_1", CallType.VIDEO, "Ann de Vries", "https://example.com/ann.png", "tok.sig", 1_767_261_600_000),
            push.call,
        )
    }

    @Test
    fun aRingFallsBackToTheEntityIdAndThePlainChannelId() {
        val values = ring - "callId" - "chatChannelId" + ("channelId" to "ch_2") + ("callType" to "something")
        val push = CallPushes.parse(values) as? CallPush.Ring ?: error("a ring")
        assertEquals("call_1", push.call.callId)
        assertEquals("ch_2", push.call.channelId)
        assertEquals(CallType.VOICE, push.call.callType)
    }

    @Test
    fun aRingWithoutAChannelIdReadsTheActionUrl() {
        val push = CallPushes.parse(ring - "chatChannelId") as? CallPush.Ring ?: error("a ring")
        assertEquals("ch_1", push.call.channelId)
    }

    @Test
    fun aRingWithoutAChannelOrWithABadIdIsNoRing() {
        assertNull(CallPushes.parse(ring - "chatChannelId" - "actionUrl"))
        assertNull(CallPushes.parse(ring + ("callId" to "call 1; drop")))
        assertNull(CallPushes.parse(ring + ("notificationType" to "chat_mention")))
    }

    @Test
    fun aCancelKeepsItsReasonOrDefaultsToEnded() {
        assertEquals(
            CallPush.Cancel("call_1", "answered"),
            CallPushes.parse(mapOf("notificationType" to "chat_call_cancel", "callId" to "call_1", "reason" to "answered")),
        )
        assertEquals(CallPush.Cancel("call_1", "ended"), CallPushes.parse(mapOf("notificationType" to "chat_call_cancel", "callId" to "call_1")))
    }

    @Test
    fun theIncomingCallNotificationRings() {
        val call = CallPushes.incomingFromNotification(
            mapOf(
                "notificationType" to "chat_incoming_call",
                "entityId" to "call_2",
                "actionUrl" to "/weldchat/dm/ch_9?messageId=m_1",
                "callType" to "voice",
                "callerName" to "  ",
            ),
        )
        assertEquals("call_2", call?.callId)
        assertEquals("ch_9", call?.channelId)
        assertEquals(CallType.VOICE, call?.callType)
        assertNull("a blank name reads as an unknown caller", call?.callerName)
        assertNull(CallPushes.incomingFromNotification(mapOf("notificationType" to "chat_mention", "entityId" to "x")))
    }

    @Test
    fun theRealtimeRing() {
        val call = CallPushes.fromRealtime(
            buildJsonObject {
                put("callId", "call_3")
                put("channelId", "ch_3")
                put("callType", "video")
                put("callerName", "Bob")
            },
        )
        assertEquals(IncomingCall("call_3", "ch_3", CallType.VIDEO, "Bob"), call)
        assertNull(CallPushes.fromRealtime(buildJsonObject { put("channelId", "ch_3") }))
        assertNull(CallPushes.fromRealtime(JsonPrimitive("nope")))
    }

    @Test
    fun theChannelOfAnActionUrl() {
        assertEquals("ch_1", CallPushes.channelIdFromActionUrl("/weldchat/ch_1"))
        assertEquals("ch_2", CallPushes.channelIdFromActionUrl("/weldchat/dm/ch_2"))
        assertEquals("ch_3", CallPushes.channelIdFromActionUrl("/weldchat/ch_3?messageId=m"))
        assertNull(CallPushes.channelIdFromActionUrl("/weldcrm/company/1"))
        assertNull(CallPushes.channelIdFromActionUrl(null))
    }

    @Test
    fun aRingSurvivesTheNotificationsExtras() {
        val push = CallPushes.parse(ring) as? CallPush.Ring ?: error("a ring")
        val extras = CallPushes.toExtras(push.call)
        assertEquals("ch_1", extras["channelId"])
        assertEquals("1767261600000", extras["expiresAt"])
        assertEquals(push.call, CallPushes.fromExtras(extras))
        assertNull(CallPushes.fromExtras(extras - "callId"))
    }

    @Test
    fun theLiveKitServerComesFromTheConfig() {
        assertEquals("wss://video.example.eu", CallRules.liveKitUrl("livekit", "wss://video.example.eu/"))
        assertEquals("https://video.example.eu", CallRules.liveKitUrl("livekit", " https://video.example.eu "))
        assertNull(CallRules.liveKitUrl("realtimekit", "wss://video.example.eu"))
        assertNull(CallRules.liveKitUrl("livekit", null))
        assertNull(CallRules.liveKitUrl("livekit", "ftp://video.example.eu"))
        assertEquals("https://video.example.eu", CallRules.liveKitUrl(" LiveKit ", "https://video.example.eu"))
        assertNull(CallRules.liveKitUrl(null, "wss://video.example.eu"))
        assertNull(CallRules.liveKitUrl("livekit", "wss://"))
    }

    @Test
    fun timersAndDurations() {
        assertEquals("0:05", CallRules.duration(5))
        assertEquals("1:05", CallRules.duration(65))
        assertEquals("1:02:05", CallRules.duration(3725))
        assertEquals("00:42", CallRules.timer(42))
        assertEquals("12:05", CallRules.timer(725))
        assertEquals("75:00", CallRules.timer(4500))
        assertEquals("00:00", CallRules.timer(-3))
    }

    private fun entry(
        channelType: String? = "dm",
        channelName: String? = "Ann, Bob",
        direction: String = "incoming",
        outcome: String = "answered",
        counterpart: CallPersonInfo? = CallPersonInfo("u_ann", "Ann", null),
        others: List<CallPersonInfo> = listOf(CallPersonInfo("u_ann", "Ann", null)),
        id: String = "call_1",
    ) = CallHistoryEntry(
        id = id,
        channelId = "ch_1",
        channelType = channelType,
        channelName = channelName,
        callType = CallType.VOICE,
        status = "ended",
        direction = direction,
        outcome = outcome,
        counterpart = counterpart,
        otherMembers = others,
        duration = null,
        createdAt = Instant.parse("2026-11-27T09:30:00Z"),
    )

    @Test
    fun theTitleIsThePersonThePeopleOrTheChannel() {
        assertEquals("Ann", CallRules.title(entry(), "Unknown"))
        assertEquals("the DM's name without a counterpart", "Ann, Bob", CallRules.title(entry(counterpart = null), "Unknown"))
        assertEquals("Unknown", CallRules.title(entry(channelName = null, counterpart = null, others = emptyList()), "Unknown"))
        val group = entry(others = listOf(CallPersonInfo("u_ann", "Ann", null), CallPersonInfo("u_bob", null, null)))
        assertTrue(CallRules.isGroupDm(group))
        assertEquals("Ann, Unknown", CallRules.title(group, "Unknown"))
        assertEquals("#general", CallRules.title(entry(channelType = "public", channelName = "general"), "Unknown"))
        assertFalse(CallRules.isDm(entry(channelType = "private")))
    }

    @Test
    fun howACallWentFromEitherSide() {
        assertEquals(CallRules.Outcome.MISSED, CallRules.outcome(entry(direction = "incoming", outcome = "missed")))
        assertEquals(CallRules.Outcome.NO_ANSWER, CallRules.outcome(entry(direction = "outgoing", outcome = "missed")))
        assertEquals(CallRules.Outcome.DECLINED, CallRules.outcome(entry(outcome = "declined")))
        assertEquals(CallRules.Outcome.ONGOING, CallRules.outcome(entry(outcome = "ongoing")))
        assertEquals(CallRules.Outcome.INCOMING, CallRules.outcome(entry(direction = "incoming")))
        assertEquals(CallRules.Outcome.OUTGOING, CallRules.outcome(entry(direction = "outgoing")))
        assertTrue(CallRules.isMissedIncoming(entry(direction = "incoming", outcome = "missed")))
        assertFalse(CallRules.isMissedIncoming(entry(direction = "outgoing", outcome = "missed")))
    }

    @Test
    fun onlyADmRingFromSomeoneElseWaitingForThePersonIsRecovered() {
        fun call(id: String, type: String?, initiator: String?, count: Int, status: String = "ringing") =
            ActiveCallSummary("ch_$id", id, CallType.VOICE, status, count, initiator, "Ann", type)
        val calls = listOf(
            call("huddle", "public", "u_ann", 1),
            call("mine", "dm", "u_me", 1),
            call("answered", "dm", "u_ann", 2),
            call("old-api", null, "u_ann", 1),
            call("ended", "dm", "u_ann", 1, status = "ended"),
            call("ringing", "dm", "u_ann", 1),
        )
        assertEquals("ringing", CallRules.recoveryCandidate(calls, "u_me")?.callId)
        assertNull(CallRules.recoveryCandidate(calls.take(5), "u_me"))
    }

    @Test
    fun anAnsweredCallIsWithTheCallerInTheRoom() {
        val participants = listOf(
            CallParticipantInfo("u_me", "Me", null, null),
            CallParticipantInfo("u_gone", "Gone", null, "2026-11-27T09:00:00.000Z"),
            CallParticipantInfo("u_ann", "Ann", "https://example.com/a.png", null),
        )
        val incoming = IncomingCall("call_1", "ch_1", CallType.VOICE, null)
        assertEquals(CallPeer("Ann", "https://example.com/a.png", isDirect = true), CallRules.peerOfAnsweredCall(incoming, participants, "u_me"))
        val fromRing = CallRules.peerOfAnsweredCall(incoming.copy(callerName = "Bob", callerAvatar = "b.png"), emptyList(), "u_me")
        assertEquals(CallPeer("Bob", "b.png", isDirect = true), fromRing)
    }

    @Test
    fun recentsAndPages() {
        val history = listOf(entry(id = "a"), entry(id = "b"))
        val active = listOf(ActiveCallSummary("ch_1", "a", CallType.VOICE, "active", 2, "u_ann", "Ann", "dm"))
        assertEquals(listOf("b"), CallRules.recent(history, active).map { it.id })
        assertEquals(listOf("a", "b", "c"), CallRules.appendPage(history, listOf(entry(id = "b"), entry(id = "c"))).map { it.id })
    }

    @Test
    fun recentsTimesReadLikeAPhone() {
        val zone = ZoneId.of("Europe/Amsterdam")
        val now = Instant.parse("2026-11-27T14:00:00Z")
        assertEquals("Yesterday", CallRules.recentsTime(Instant.parse("2026-11-26T21:00:00Z"), "Yesterday", now, zone, Locale.ENGLISH))
        assertEquals("Tuesday", CallRules.recentsTime(Instant.parse("2026-11-24T09:00:00Z"), "Yesterday", now, zone, Locale.ENGLISH))
        assertTrue(CallRules.recentsTime(Instant.parse("2026-11-27T08:00:00Z"), "Yesterday", now, zone, Locale.ENGLISH).contains("9:00"))
    }

    @Test
    fun callTypesReadTheServersWord() {
        assertEquals(CallType.VIDEO, CallType.of("video"))
        assertEquals(CallType.VOICE, CallType.of("voice"))
        assertEquals(CallType.VOICE, CallType.of(null))
        assertEquals(CallType.VOICE, CallType.of("screen"))
    }
}
