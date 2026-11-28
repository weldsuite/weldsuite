package com.weldsuite.weldchat.calls

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.temporal.ChronoUnit
import java.util.Locale

/** A voice or a video call, as the server names them. */
enum class CallType(val wire: String) {
    VOICE("voice"),
    VIDEO("video");

    companion object {
        /** Anything but `video` is a voice call, as the server's own default. */
        fun of(wire: String?): CallType = if (wire == "video") VIDEO else VOICE
    }
}

/** Who a call is with, for the call screen: the person of a DM, or a channel's name. */
data class CallPeer(val name: String? = null, val avatar: String? = null, val isDirect: Boolean = false)

/** A call running in a channel, for its "Join" button. */
data class ActiveChannelCall(val callId: String, val callType: CallType)

/** A ring waiting for an answer: from the realtime socket, the server's recovery, or a push. */
data class IncomingCall(
    val callId: String,
    val channelId: String,
    val callType: CallType,
    /** Null when the ring didn't say who is calling. */
    val callerName: String?,
    val callerAvatar: String? = null,
    /** The ring's signed token, for declining without a session (`/public/chat-calls/decline`). */
    val declineToken: String? = null,
    /** When the ring stops, in epoch milliseconds. */
    val expiresAt: Long? = null,
)

/** A joined call, as the call screen shows it. */
data class CallSession(
    val callId: String,
    val channelId: String,
    val callType: CallType,
    /** The video provider's join token (LiveKit's on the Kubernetes editions). */
    val token: String,
    /** A 1:1 call: the "Calling …" screen, ringback and the peer-gone hang-up. */
    val isDirect: Boolean = false,
    val peerName: String? = null,
    val peerAvatar: String? = null,
    /** Joined by answering a ring: the caller is already there, so no ringback. */
    val answered: Boolean = false,
)

enum class CallStatus { IDLE, RINGING_INCOMING, CONNECTING, CONNECTED }

/** What the server's native call pushes ask for (`chat_call_ring`, `chat_call_cancel`). */
sealed interface CallPush {
    data class Ring(val call: IncomingCall) : CallPush

    data class Cancel(val callId: String, val reason: String) : CallPush
}

/** The server's call pushes and ring payloads (`lib/call-push.ts`, `lib/incoming-call-bridge.ts`). */
object CallPushes {
    const val RING = "chat_call_ring"
    const val CANCEL = "chat_call_cancel"

    /** The ordinary "Incoming call" push, sent to devices without a call token. */
    const val INCOMING = "chat_incoming_call"

    private val ID = Regex("^[A-Za-z0-9_-]+$")
    private val CHANNEL_IN_URL = Regex("/weldchat/(?:dm/)?([^/?#]+)")

    fun isId(value: String?): Boolean = value != null && ID.matches(value)

    /** A ring or a cancel from a data-only push, or null for anything else. */
    fun parse(values: Map<String, String>): CallPush? {
        val callId = values.text("callId") ?: values.text("entityId")
        if (!isId(callId) || callId == null) return null
        return when (values["notificationType"]) {
            CANCEL -> CallPush.Cancel(callId, values.text("reason") ?: "ended")
            RING -> {
                val channelId = values.text("chatChannelId") ?: values.text("channelId")
                    ?: channelIdFromActionUrl(values["actionUrl"])
                if (!isId(channelId) || channelId == null) return null
                CallPush.Ring(
                    IncomingCall(
                        callId = callId,
                        channelId = channelId,
                        callType = CallType.of(values["callType"]),
                        callerName = values.text("callerName"),
                        callerAvatar = values.text("callerAvatar"),
                        declineToken = values.text("declineToken"),
                        expiresAt = values.text("expiresAt")?.toLongOrNull(),
                    ),
                )
            }
            else -> null
        }
    }

    /** A tapped "Incoming call" push (`chat_incoming_call`) as a ring, or null when it's incomplete. */
    fun incomingFromNotification(values: Map<String, String>): IncomingCall? {
        if (values["notificationType"] != INCOMING) return null
        val callId = values.text("entityId") ?: return null
        if (!isId(callId)) return null
        val channelId = values.text("chatChannelId") ?: values.text("channelId") ?: channelIdFromActionUrl(values["actionUrl"])
        if (!isId(channelId) || channelId == null) return null
        return IncomingCall(
            callId = callId,
            channelId = channelId,
            callType = CallType.of(values["callType"]),
            callerName = values.text("callerName"),
            callerAvatar = values.text("callerAvatar"),
        )
    }

    /** `/weldchat/dm/ch_1` or `/weldchat/ch_1?messageId=…` → `ch_1`. */
    fun channelIdFromActionUrl(actionUrl: String?): String? =
        actionUrl?.let { CHANNEL_IN_URL.find(it)?.groupValues?.get(1) }

    /** A ring as notification extras, and back: for the Answer / Decline intents. */
    fun toExtras(call: IncomingCall): Map<String, String> = buildMap {
        put("callId", call.callId)
        put("channelId", call.channelId)
        put("callType", call.callType.wire)
        call.callerName?.let { put("callerName", it) }
        call.callerAvatar?.let { put("callerAvatar", it) }
        call.declineToken?.let { put("declineToken", it) }
        call.expiresAt?.let { put("expiresAt", it.toString()) }
    }

    fun fromExtras(values: Map<String, String>): IncomingCall? {
        val callId = values.text("callId")
        val channelId = values.text("channelId")
        if (!isId(callId) || !isId(channelId) || callId == null || channelId == null) return null
        return IncomingCall(
            callId = callId,
            channelId = channelId,
            callType = CallType.of(values["callType"]),
            callerName = values.text("callerName"),
            callerAvatar = values.text("callerAvatar"),
            declineToken = values.text("declineToken"),
            expiresAt = values.text("expiresAt")?.toLongOrNull(),
        )
    }

    /** A realtime `call_incoming` event's data as a ring. */
    fun fromRealtime(data: JsonElement): IncomingCall? {
        val values = (data as? JsonObject)?.strings() ?: return null
        val callId = values.text("callId")
        val channelId = values.text("channelId")
        if (!isId(callId) || !isId(channelId) || callId == null || channelId == null) return null
        return IncomingCall(
            callId = callId,
            channelId = channelId,
            callType = CallType.of(values["callType"]),
            callerName = values.text("callerName"),
            callerAvatar = values.text("callerAvatar"),
        )
    }

    private fun Map<String, String>.text(key: String): String? = this[key]?.trim()?.takeIf { it.isNotEmpty() }
}

/** The string fields of a JSON object. */
internal fun JsonObject.strings(): Map<String, String> =
    entries.mapNotNull { (key, value) -> (value as? JsonPrimitive)?.contentOrNull?.let { key to it } }.toMap()

/** A string field of a realtime event's data. */
internal fun JsonElement.field(key: String): String? =
    ((this as? JsonObject)?.get(key) as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }

/** The pure rules of the call screens. */
object CallRules {
    /** Remote people have to stay this long before the call counts as answered. */
    const val ANSWER_LATCH_MS = 600L

    /** A 1:1 call waits this long for the other person to come back before hanging up. */
    const val PEER_GONE_GRACE_MS = 10_000L

    /** A call that never connects is dropped after this long. */
    const val CONNECTING_TIMEOUT_MS = 30_000L

    /** Ring for this long when the push says nothing; the server cancels well before. */
    const val DEFAULT_RING_MS = 60_000L

    /**
     * The ring to recover after the app was away: a DM call someone else
     * started that only they are in, still ringing or live (the backend's
     * rule for who gets rung).
     */
    fun recoveryCandidate(calls: List<ActiveCallSummary>, userId: String): ActiveCallSummary? = calls.firstOrNull { call ->
        call.channelType == "dm" &&
            !call.initiatorId.isNullOrEmpty() &&
            call.initiatorId != userId &&
            call.participantCount <= 1 &&
            (call.status == "ringing" || call.status == "active")
    }

    /**
     * Who an answered ring is with: the caller listed by the join (they are
     * in the room already), else what the ring said.
     */
    fun peerOfAnsweredCall(ring: IncomingCall, participants: List<CallParticipantInfo>, selfId: String?): CallPeer {
        val caller = participants.firstOrNull { it.userId != selfId && it.leftAt == null }
        return CallPeer(
            name = caller?.name?.takeIf { it.isNotBlank() } ?: ring.callerName,
            avatar = caller?.avatar?.takeIf { it.isNotBlank() } ?: ring.callerAvatar,
            isDirect = true,
        )
    }

    /** 65 → "01:05", the running call's timer. */
    fun timer(totalSeconds: Long): String {
        val seconds = totalSeconds.coerceAtLeast(0)
        return "%02d:%02d".format(Locale.ROOT, seconds / 60, seconds % 60)
    }

    /** 65 → "1:05", 3725 → "1:02:05": how long a call in the history lasted. */
    fun duration(totalSeconds: Int): String {
        val seconds = totalSeconds.coerceAtLeast(0)
        val h = seconds / 3600
        val m = (seconds % 3600) / 60
        val s = seconds % 60
        return if (h > 0) "%d:%02d:%02d".format(Locale.ROOT, h, m, s) else "%d:%02d".format(Locale.ROOT, m, s)
    }

    /** The LiveKit server of `/config.json`'s `videoProvider` and `videoUrl`; null when there is none to join. */
    fun liveKitUrl(provider: String?, url: String?): String? {
        // No provider named is RealtimeKit (Global), whose tokens LiveKit can't use.
        if (provider?.trim()?.lowercase() != "livekit") return null
        val server = url?.trim()?.trimEnd('/') ?: return null
        return server.takeIf { Regex("^(wss?|https?)://.+", RegexOption.IGNORE_CASE).matches(it) }
    }

    /** Phone-style recents: the time today, "Yesterday", the weekday this week, else the date. */
    fun recentsTime(
        instant: Instant,
        yesterday: String,
        now: Instant = Instant.now(),
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): String {
        val day: LocalDate = instant.atZone(zone).toLocalDate()
        val today = now.atZone(zone).toLocalDate()
        val days = ChronoUnit.DAYS.between(day, today)
        val at = instant.atZone(zone)
        return when {
            days <= 0L -> at.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale))
            days == 1L -> yesterday
            days < 7L -> at.format(DateTimeFormatter.ofPattern("EEEE", locale))
            else -> at.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT).withLocale(locale))
        }
    }

    /** A DM call: the person or people; else the channel. */
    fun isDm(item: CallHistoryEntry): Boolean = item.channelType == "dm"

    fun isGroupDm(item: CallHistoryEntry): Boolean = isDm(item) && item.otherMembers.size > 1

    /** The person (DM), the people (group DM) or `#channel` the call was with. */
    fun title(item: CallHistoryEntry, unknown: String): String = when {
        isGroupDm(item) -> item.otherMembers.joinToString(", ") { it.name?.takeIf(String::isNotBlank) ?: unknown }
        isDm(item) -> item.counterpart?.name?.takeIf { it.isNotBlank() } ?: item.channelName?.takeIf { it.isNotBlank() } ?: unknown
        else -> "#${item.channelName.orEmpty()}"
    }

    /** How a call went, from the caller of the history's side. */
    enum class Outcome { ONGOING, MISSED, NO_ANSWER, DECLINED, INCOMING, OUTGOING }

    fun outcome(item: CallHistoryEntry): Outcome {
        val incoming = item.direction == "incoming"
        return when (item.outcome) {
            "ongoing" -> Outcome.ONGOING
            "missed" -> if (incoming) Outcome.MISSED else Outcome.NO_ANSWER
            "declined" -> Outcome.DECLINED
            else -> if (incoming) Outcome.INCOMING else Outcome.OUTGOING
        }
    }

    /** Red like a phone's recents: a call that rang you and you never picked up. */
    fun isMissedIncoming(item: CallHistoryEntry): Boolean = item.outcome == "missed" && item.direction == "incoming"

    /** Ongoing calls get their own Join rows, so they leave the history list. */
    fun recent(history: List<CallHistoryEntry>, active: List<ActiveCallSummary>): List<CallHistoryEntry> {
        val live = active.map { it.callId }.toSet()
        return history.filter { it.id !in live }
    }

    /** A further page, each call once. */
    fun appendPage(current: List<CallHistoryEntry>, page: List<CallHistoryEntry>): List<CallHistoryEntry> {
        val seen = current.map { it.id }.toSet()
        return current + page.filter { it.id !in seen }
    }
}
