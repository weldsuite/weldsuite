package com.weldsuite.weldchat.realtime

import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.Request
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.WeldJson
import org.weldsuite.core.realtime.WeldSocket
import org.weldsuite.core.realtime.realtimeBase
import org.weldsuite.core.realtime.string

/**
 * Where the server's realtime service is: `/config.json`'s `realtimeUrl`
 * (without `/ws`), else the server itself on `ws(s)://`. The core reads the
 * same file but keeps the address to itself, so it is read once here
 * (could move to the core).
 */
object RealtimeEndpoint {
    private val cache = mutableMapOf<String, String>()

    suspend fun base(env: AppEnvironment): String {
        cache[env.serverOrigin]?.let { return it }
        val configured = withContext(Dispatchers.IO) {
            runCatching {
                val request = Request.Builder().url("${env.serverOrigin}/config.json").header("Accept", "application/json").build()
                env.http.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) null else response.body?.string()
                }
            }.getOrNull()
        }?.let { text ->
            runCatching { WeldJson.parseToJsonElement(text).jsonObject.string("realtimeUrl") }.getOrNull()
        }
        val base = realtimeBase(configured, env.serverOrigin)
        cache[env.serverOrigin] = base
        return base
    }
}

/** What a room message means for the screen. */
sealed interface RoomEvent {
    /** A message, a reaction, a pin or the channel changed: reload. */
    data object Changed : RoomEvent

    /** Someone started or stopped typing. */
    data class Typing(val userId: String, val isTyping: Boolean) : RoomEvent
}

object RoomEvents {
    /** A room message as a [RoomEvent]; null for what the screen ignores (and the caller's own typing). */
    fun parse(message: JsonObject, selfId: String?): RoomEvent? = when (message.string("type")) {
        "message", "reaction", "pin", "channel:updated" -> RoomEvent.Changed
        "typing" -> {
            val userId = message.string("userId")
            if (userId == null || userId == selfId) {
                null
            } else {
                RoomEvent.Typing(userId, (message["isTyping"] as? JsonPrimitive)?.booleanOrNull ?: false)
            }
        }
        else -> null
    }
}

/**
 * A WeldChat room (`RoomClient` in `@weldsuite/realtime`): the channel's
 * live messages and who is typing, on `<realtime>/ws/chat/<channelId>`. A
 * message (or a reaction, a pin) calls [onChange]; so does every reconnect
 * after the first, since the room doesn't replay what was missed. Its
 * state is Compose state, on the main thread.
 */
class ChatRoomSocket(
    private val env: AppEnvironment,
    base: String,
    channelId: String,
    private val selfId: String?,
) {
    /** Who is typing, the caller left out. */
    var typingUserIds by mutableStateOf<List<String>>(emptyList())
        private set

    var onChange: (() -> Unit)? = null

    private var openedBefore = false
    private val typingExpiry = mutableMapOf<String, Job>()
    private var lastTypingSent = 0L
    private val url = "${base.trimEnd('/')}/ws/chat/${Uri.encode(channelId)}"

    private val socket = WeldSocket(
        http = env.http,
        scope = env.scope,
        url = { url },
        token = { env.session?.getToken() },
        workspace = { env.session?.activeWorkspaceId },
        onOpen = ::opened,
        onMessage = ::received,
    )

    fun start() {
        socket.start()
    }

    fun stop() {
        socket.stop()
        typingExpiry.values.forEach { it.cancel() }
        typingExpiry.clear()
        typingUserIds = emptyList()
    }

    /** A keystroke: tell the room, at most every three seconds. */
    fun keystroke() {
        val now = System.currentTimeMillis()
        if (now - lastTypingSent <= TYPING_THROTTLE_MS) return
        lastTypingSent = now
        socket.send(buildJsonObject { put("type", "typing:start") })
    }

    /** A message went out: no longer typing. */
    fun sent() {
        lastTypingSent = 0L
        socket.send(buildJsonObject { put("type", "typing:stop") })
    }

    private fun opened() {
        if (openedBefore) onChange?.invoke()
        openedBefore = true
    }

    private fun received(message: JsonObject) {
        when (val event = RoomEvents.parse(message, selfId)) {
            RoomEvent.Changed -> onChange?.invoke()
            is RoomEvent.Typing -> typing(event.userId, event.isTyping)
            null -> Unit
        }
    }

    /** A "typing" lasts six seconds unless it is stopped or renewed. */
    private fun typing(userId: String, isTyping: Boolean) {
        typingExpiry.remove(userId)?.cancel()
        if (isTyping) {
            if (userId !in typingUserIds) typingUserIds = typingUserIds + userId
            typingExpiry[userId] = env.scope.launch {
                delay(TYPING_EXPIRY_MS)
                typing(userId, false)
            }
        } else {
            typingUserIds = typingUserIds - userId
        }
    }

    private companion object {
        const val TYPING_THROTTLE_MS = 3_000L
        const val TYPING_EXPIRY_MS = 6_000L
    }
}
