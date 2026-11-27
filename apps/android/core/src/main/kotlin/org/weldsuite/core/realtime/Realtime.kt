package org.weldsuite.core.realtime

import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.weldsuite.core.WeldJson
import kotlin.math.min
import kotlin.math.pow

/** How a realtime socket is doing. */
enum class RealtimeState { DISCONNECTED, CONNECTING, CONNECTED }

/**
 * A WebSocket to the server's realtime service (`@weldsuite/realtime`): the
 * session token (`?token=`) and the workspace (`?workspace=`, WeldID's
 * membership mode) go in the URL, the server opens with
 * `{"type":"connected"}`, and the socket pings every 25 seconds. It
 * reconnects with backoff (1 s doubling to 30 s) while it's wanted, closes
 * when the app goes to the background and opens again when it comes back.
 *
 * Messages are handed over as JSON objects on the main thread.
 * [RealtimeClient] speaks the workspace hub's protocol on top of it;
 * WeldChat's rooms use it directly.
 *
 * @param url the socket's URL without the token, null while there is none.
 * @param token the access token; null (signed out) leaves the socket closed.
 * @param workspace the active workspace, sent as `?workspace=`.
 */
class WeldSocket(
    private val http: OkHttpClient,
    private val scope: CoroutineScope,
    private val url: () -> String?,
    private val token: suspend () -> String?,
    private val workspace: () -> String?,
    private val onOpen: () -> Unit,
    private val onMessage: (JsonObject) -> Unit,
) {
    private val stateFlow = MutableStateFlow(RealtimeState.DISCONNECTED)
    val state: StateFlow<RealtimeState> = stateFlow.asStateFlow()

    private var socket: WebSocket? = null
    /** Bumped on every connect and close: a late callback of an older socket is ignored. */
    private var generation = 0
    private var attempt = 0
    private var wanted = false
    private var inBackground = false
    private var heartbeat: Job? = null
    private var retry: Job? = null
    private var connecting: Job? = null

    private val lifecycle = object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) {
            inBackground = false
            attempt = 0
            if (wanted && socket == null) connect()
        }

        override fun onStop(owner: LifecycleOwner) {
            inBackground = true
            close()
        }
    }

    init {
        scope.launch { ProcessLifecycleOwner.get().lifecycle.addObserver(lifecycle) }
    }

    /** Open the socket and keep it open. */
    fun start() {
        wanted = true
        if (socket == null && retry == null && connecting == null) connect()
    }

    /** Close it and stop reconnecting. */
    fun stop() {
        wanted = false
        close()
    }

    /** Close and open again at once: after a workspace switch or a new sign-in. */
    fun restart() {
        close()
        attempt = 0
        if (wanted) connect()
    }

    /** Send a message. Dropped while the socket isn't connected. */
    fun send(message: JsonObject) {
        if (stateFlow.value != RealtimeState.CONNECTED) return
        socket?.send(message.toString())
    }

    private fun connect() {
        retry?.cancel()
        retry = null
        if (!wanted || inBackground) return
        val current = ++generation
        stateFlow.value = RealtimeState.CONNECTING
        connecting = scope.launch {
            val token = token()
            connecting = null
            if (current != generation || !wanted) return@launch
            val target = token?.let { socketUrl(it) }
            if (target == null) {
                // Signed out, or no server yet: nothing to connect to until restart().
                stateFlow.value = RealtimeState.DISCONNECTED
                return@launch
            }
            socket = http.newWebSocket(Request.Builder().url(target).build(), Listener(current))
            scope.launch {
                delay(HANDSHAKE_TIMEOUT_MS)
                if (current == generation && stateFlow.value == RealtimeState.CONNECTING) {
                    socket?.cancel()
                    dropped(current)
                }
            }
        }
    }

    private fun socketUrl(token: String): String? {
        // OkHttp's URL type speaks http(s) only; it upgrades to a WebSocket itself.
        val base = url()?.replaceFirst(Regex("^ws"), "http")?.toHttpUrlOrNull() ?: return null
        return base.newBuilder()
            .addQueryParameter("token", token)
            .apply { workspace()?.trim()?.takeIf { it.isNotEmpty() }?.let { addQueryParameter("workspace", it) } }
            .build()
            .toString()
    }

    private inner class Listener(private val current: Int) : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            val message = runCatching { WeldJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
            scope.launch { received(message, current) }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            scope.launch { dropped(current) }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            scope.launch { dropped(current) }
        }
    }

    private fun received(message: JsonObject, current: Int) {
        if (current != generation) return
        if (stateFlow.value != RealtimeState.CONNECTED && message.string("type") == "connected") {
            attempt = 0
            stateFlow.value = RealtimeState.CONNECTED
            startHeartbeat(current)
            onOpen()
        }
        onMessage(message)
    }

    private fun startHeartbeat(current: Int) {
        heartbeat?.cancel()
        heartbeat = scope.launch {
            while (current == generation) {
                delay(HEARTBEAT_MS)
                if (current == generation) send(buildJsonObject { put("type", "ping") })
            }
        }
    }

    private fun dropped(current: Int) {
        if (current != generation) return
        generation++
        socket = null
        heartbeat?.cancel()
        heartbeat = null
        stateFlow.value = RealtimeState.DISCONNECTED
        if (!wanted || inBackground) return
        val wait = min(1000.0 * 2.0.pow(attempt), 30_000.0).toLong()
        attempt++
        retry = scope.launch {
            delay(wait)
            retry = null
            connect()
        }
    }

    private fun close() {
        generation++
        retry?.cancel()
        retry = null
        connecting?.cancel()
        connecting = null
        heartbeat?.cancel()
        heartbeat = null
        socket?.close(1000, null)
        socket = null
        stateFlow.value = RealtimeState.DISCONNECTED
    }

    private companion object {
        const val HEARTBEAT_MS = 25_000L
        const val HANDSHAKE_TIMEOUT_MS = 15_000L
    }
}

/**
 * An event from the workspace hub: an entity changed (`ticket`,
 * `invoice.inv_1`, …), a mail arrived, a notification. [data] is the event's
 * payload. After a reconnect every flow gets a [isResync] event: whatever
 * happened in between was missed, so reload.
 */
data class RealtimeEvent(
    val topic: String,
    val event: String,
    val userId: String?,
    val data: JsonElement,
) {
    /** Reload: events were missed (a reconnect, or the server's `resync_required`). */
    val isResync: Boolean get() = event == RESYNC

    companion object {
        const val RESYNC = "resync"

        fun resync(topic: String) = RealtimeEvent(topic, RESYNC, null, JsonNull)
    }
}

/** Whether an event on [topic] belongs to a subscription to [subscription]: `ticket` matches `ticket` and `ticket.tkt_1`. */
fun realtimeTopicMatches(topic: String, subscription: String): Boolean =
    topic == subscription || topic.startsWith("$subscription.")

/**
 * The workspace hub (`WorkspaceClient` in `@weldsuite/realtime`): screens
 * ask for the topics they show and reload on what arrives, the same
 * cache-invalidation model as the web platform (ADR EVT-007).
 *
 * ```kotlin
 * LaunchedEffect(Unit) { env.realtime?.events(listOf("ticket"))?.collect { viewModel.load() } }
 * ```
 *
 * Per-person topics carry the person's id (`mail.<userId>`,
 * `notification.<userId>`, `chat.user.<userId>`); a bare one is refused by
 * the server. Everything runs on [scope]'s (main) thread.
 *
 * @param baseUrl the server's `realtimeUrl` (without `/ws`).
 */
class RealtimeClient(
    http: OkHttpClient,
    private val scope: CoroutineScope,
    baseUrl: String,
    token: suspend () -> String?,
    workspace: () -> String?,
) {
    private val listeners = mutableMapOf<Any, Pair<List<String>, (RealtimeEvent) -> Unit>>()
    private var subscribed = setOf<String>()
    private var openedBefore = false

    private val socket = WeldSocket(
        http = http,
        scope = scope,
        url = { "${baseUrl.trimEnd('/')}/ws" },
        token = token,
        workspace = workspace,
        onOpen = ::opened,
        onMessage = ::received,
    )

    val state: StateFlow<RealtimeState> get() = socket.state

    /** Events on [topics] (and their children) while the flow is collected. */
    fun events(topics: List<String>): Flow<RealtimeEvent> = callbackFlow {
        val key = Any()
        val deliver: (RealtimeEvent) -> Unit = { event -> trySend(event) }
        scope.launch {
            listeners[key] = topics to deliver
            val fresh = topics.toSet() - subscribed
            if (fresh.isNotEmpty() && socket.state.value == RealtimeState.CONNECTED) {
                subscribed = subscribed + fresh
                socket.send(subscribe("subscribe", fresh))
            }
            socket.start()
        }
        awaitClose { scope.launch { removeListener(key) } }
    }

    /** Reconnect for another workspace or person; flows carry on. */
    fun restart() {
        subscribed = emptySet()
        socket.restart()
    }

    /** Close for good (sign-out). Flows stay and get events again after [restart]. */
    fun stop() {
        subscribed = emptySet()
        openedBefore = false
        socket.stop()
    }

    private fun removeListener(key: Any) {
        listeners.remove(key)
        val wanted = listeners.values.flatMap { it.first }.toSet()
        val gone = subscribed - wanted
        if (gone.isNotEmpty() && socket.state.value == RealtimeState.CONNECTED) socket.send(subscribe("unsubscribe", gone))
        subscribed = subscribed - gone
        if (listeners.isEmpty()) socket.stop()
    }

    private fun opened() {
        val topics = listeners.values.flatMap { it.first }.toSet()
        subscribed = topics
        if (topics.isNotEmpty()) socket.send(subscribe("subscribe", topics))
        if (openedBefore) {
            for ((wantedTopics, deliver) in listeners.values.toList()) wantedTopics.forEach { deliver(RealtimeEvent.resync(it)) }
        }
        openedBefore = true
    }

    private fun received(message: JsonObject) {
        when (message.string("type")) {
            "event" -> {
                val topic = message.string("topic") ?: return
                val event = RealtimeEvent(topic, message.string("event").orEmpty(), message.string("userId"), message["data"] ?: JsonNull)
                for ((wantedTopics, deliver) in listeners.values.toList()) {
                    if (wantedTopics.any { realtimeTopicMatches(topic, it) }) deliver(event)
                }
            }
            "resync_required" -> {
                val topics = (message["topics"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()
                for ((wantedTopics, deliver) in listeners.values.toList()) {
                    wantedTopics
                        .filter { mine -> topics.isEmpty() || topics.any { realtimeTopicMatches(it, mine) || realtimeTopicMatches(mine, it) } }
                        .forEach { deliver(RealtimeEvent.resync(it)) }
                }
            }
        }
    }

    private fun subscribe(type: String, topics: Set<String>): JsonObject = buildJsonObject {
        put("type", type)
        put("topics", JsonArray(topics.map { JsonPrimitive(it) }))
    }
}

/** A string field of a JSON object, if it is one. */
fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

/** The realtime service's base URL: the server's `realtimeUrl` without a trailing `/ws`, else the server itself on `ws(s)://`. */
fun realtimeBase(configured: String?, serverOrigin: String): String {
    val text = configured?.trim()?.takeIf { it.isNotEmpty() } ?: serverOrigin.replaceFirst(Regex("^http"), "ws")
    return text.trimEnd('/').removeSuffix("/ws")
}
