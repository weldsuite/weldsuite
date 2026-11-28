package com.weldsuite.weldchat.calls

import org.weldsuite.api.weldchat.apis.DefaultApi
import org.weldsuite.api.weldchat.models.ActiveCall
import org.weldsuite.api.weldchat.models.Call
import org.weldsuite.api.weldchat.models.CallHistoryItem
import org.weldsuite.api.weldchat.models.CallParticipant
import org.weldsuite.api.weldchat.models.CallPerson
import org.weldsuite.api.weldchat.models.StartCallInput
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.WeldDate
import org.weldsuite.core.api.apiCall
import java.time.Instant

/** A ringing or live call in one of the caller's channels (`listActiveCalls`). */
data class ActiveCallSummary(
    val channelId: String,
    val callId: String,
    val callType: CallType,
    val status: String,
    val participantCount: Int,
    val initiatorId: String?,
    val initiatorName: String?,
    /** Only DM rings ring; channel calls are joined from their channel. */
    val channelType: String?,
)

data class CallParticipantInfo(val userId: String, val name: String?, val avatar: String?, val leftAt: String?)

/** A call (`getCall`, `getActiveCallInChannel`). */
data class CallInfo(
    val id: String,
    val channelId: String,
    val callType: CallType,
    val status: String,
    val participants: List<CallParticipantInfo>,
)

data class CallPersonInfo(val userId: String, val name: String?, val avatar: String?)

/** A call of the caller's history (`listCallHistory`). */
data class CallHistoryEntry(
    val id: String,
    val channelId: String,
    val channelType: String?,
    val channelName: String?,
    val callType: CallType,
    val status: String,
    /** `incoming` or `outgoing`. */
    val direction: String,
    /** `ongoing`, `answered`, `missed` or `declined`. */
    val outcome: String,
    val counterpart: CallPersonInfo?,
    val otherMembers: List<CallPersonInfo>,
    /** Seconds, once the call ended. */
    val duration: Int?,
    val createdAt: Instant?,
)

data class CallHistoryPage(val items: List<CallHistoryEntry>, val cursor: String?)

/** What joining (or starting and joining) a call hands back. */
data class CallJoin(
    val callId: String,
    val channelId: String?,
    val callType: CallType?,
    val token: String,
    val participants: List<CallParticipantInfo>,
)

/**
 * The call operations of `weldchat.yaml`. The generated types are mapped
 * here and nowhere else, so a rename in the generated client stays in this
 * file.
 */
class CallApi(private val env: AppEnvironment) {
    private val api: DefaultApi get() = env.api.create()

    suspend fun active(): List<ActiveCallSummary> = apiCall { api.listActiveCalls() }.data.map(::summary)

    suspend fun activeIn(channelId: String): CallInfo? = apiCall { api.getActiveCallInChannel(channelId) }.data?.let(::info)

    suspend fun get(callId: String): CallInfo? = apiCall { api.getCall(callId) }.data?.let(::info)

    suspend fun history(cursor: String?, limit: Int = PAGE_SIZE): CallHistoryPage {
        val page = apiCall { api.listCallHistory(limit = limit, cursor = cursor) }
        return CallHistoryPage(page.data.map(::entry), page.pagination.cursor.takeIf { page.pagination.hasMore })
    }

    suspend fun startAndJoin(channelId: String, type: CallType): CallJoin {
        val input = StartCallInput(
            channelId = channelId,
            callType = if (type == CallType.VIDEO) StartCallInput.CallType.VIDEO else StartCallInput.CallType.VOICE,
        )
        val started = apiCall { api.startAndJoinCall(input) }.data
        return CallJoin(
            callId = started.callId,
            channelId = channelId,
            // Joining a call already running there: its own type wins.
            callType = started.callType?.let(CallType::of),
            token = started.authToken,
            participants = started.participants.orEmpty().map(::participant),
        )
    }

    suspend fun join(callId: String): CallJoin {
        val joined = apiCall { api.joinCall(callId) }.data
        return CallJoin(
            callId = joined.callId,
            channelId = joined.channelId,
            callType = CallType.of(joined.callType),
            token = joined.authToken,
            participants = joined.participants.orEmpty().map(::participant),
        )
    }

    suspend fun leave(callId: String) {
        apiCall { api.leaveCall(callId) }
    }

    suspend fun decline(callId: String) {
        apiCall { api.declineCall(callId) }
    }

    companion object {
        const val PAGE_SIZE = 30

        internal fun summary(call: ActiveCall) = ActiveCallSummary(
            channelId = call.channelId,
            callId = call.callId,
            callType = CallType.of(call.callType),
            status = call.status,
            participantCount = call.participantCount,
            initiatorId = call.initiatorId,
            initiatorName = call.initiatorName,
            channelType = call.channelType,
        )

        internal fun info(call: Call) = CallInfo(
            id = call.id,
            channelId = call.channelId,
            callType = CallType.of(call.callType),
            status = call.status,
            participants = call.participants.orEmpty().map(::participant),
        )

        internal fun participant(participant: CallParticipant) = CallParticipantInfo(
            userId = participant.userId,
            name = participant.userName,
            avatar = participant.userAvatar,
            leftAt = participant.leftAt,
        )

        internal fun person(person: CallPerson) = CallPersonInfo(person.userId, person.name, person.avatar)

        internal fun entry(item: CallHistoryItem) = CallHistoryEntry(
            id = item.id,
            channelId = item.channelId,
            channelType = item.channelType,
            channelName = item.channelName,
            callType = CallType.of(item.callType),
            status = item.status,
            direction = item.direction,
            outcome = item.outcome,
            counterpart = item.counterpart?.let(::person),
            otherMembers = item.otherMembers.orEmpty().map(::person),
            duration = item.duration,
            createdAt = WeldDate.parse(item.createdAt),
        )
    }
}
