package com.weldsuite.welddesk

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.realtime.RealtimeState
import org.weldsuite.core.realtime.WeldSocket
import org.weldsuite.core.realtime.string

/**
 * A conversation's realtime room (`/ws/conversation/<id>`), joined while the
 * thread is open, for what the workspace hub doesn't carry: the visitor
 * typing, the visitor's presence, and the agent's own typing signal. The
 * timeline itself stays live through the hub. Built on the core's
 * [WeldSocket], which reconnects and closes in the background on its own.
 */
class ConversationRoom(
    private val env: AppEnvironment,
    private val scope: CoroutineScope,
    baseUrl: String,
    conversationId: String,
) {
    private val stateFlow = MutableStateFlow(RoomState())
    val state: StateFlow<RoomState> = stateFlow.asStateFlow()

    private val throttle = TypingThrottle()
    private var idle: Job? = null
    private val expiries = mutableMapOf<String, Job>()

    private val socket = WeldSocket(
        http = env.http,
        scope = scope,
        url = { "${baseUrl.trimEnd('/')}/ws/conversation/$conversationId" },
        token = { env.session?.getToken() },
        workspace = { env.session?.activeWorkspaceId },
        onOpen = ::opened,
        onMessage = ::received,
    )

    fun start() = socket.start()

    /** Leave the room: presence first, while the socket is still open. */
    fun stop() {
        idle?.cancel()
        expiries.values.forEach { it.cancel() }
        expiries.clear()
        if (throttle.stop()) socket.send(message("typing:stop"))
        socket.send(message("presence:leave"))
        socket.stop()
        stateFlow.value = RoomState()
    }

    /** A keystroke in a reply (not a note): "typing" now and then, "stopped" after a pause. */
    fun typed() {
        if (socket.state.value != RealtimeState.CONNECTED) return
        if (throttle.keystroke(System.currentTimeMillis())) socket.send(message("typing:start"))
        idle?.cancel()
        idle = scope.launch {
            delay(DeskLogic.TYPING_IDLE_MS)
            stopTyping()
        }
    }

    fun stopTyping() {
        idle?.cancel()
        idle = null
        if (throttle.stop()) socket.send(message("typing:stop"))
    }

    private fun opened() {
        socket.send(
            buildJsonObject {
                put("type", "presence:enter")
                put("data", buildJsonObject { put("role", "agent") })
            },
        )
    }

    private fun received(message: JsonObject) {
        val type = message.string("type")
        val member = message["member"] as? JsonObject
        val fields = RoomFields(
            userId = message.string("userId") ?: member?.string("userId"),
            userName = message.string("userName") ?: member?.string("userName"),
            isTyping = (message["isTyping"] as? JsonPrimitive)?.booleanOrNull == true,
            presence = (message["presence"] as? JsonArray)?.mapNotNull { (it as? JsonObject)?.string("userId") }.orEmpty(),
        )
        stateFlow.value = RoomState.reduce(stateFlow.value, type, fields)
        if (type == "typing") fields.userId?.let(::expireTyping)
    }

    /** A typing signal without a stop clears itself. */
    private fun expireTyping(userId: String) {
        expiries.remove(userId)?.cancel()
        if (userId !in stateFlow.value.typing) return
        expiries[userId] = scope.launch {
            delay(DeskLogic.TYPING_EXPIRY_MS)
            expiries.remove(userId)
            stateFlow.value = stateFlow.value.withoutTyping(userId)
        }
    }

    private fun message(type: String): JsonObject = buildJsonObject { put("type", type) }
}
