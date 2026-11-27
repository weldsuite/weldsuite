package com.weldsuite.weldchat.calls

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.annotation.RawRes
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.weldsuite.weldchat.R
import io.livekit.android.AudioOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.events.RoomEvent
import io.livekit.android.room.Room
import io.livekit.android.room.track.CameraPosition
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import okhttp3.Request
import org.weldsuite.api.core.models.PushTokenRegistration
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.WeldJson
import org.weldsuite.core.push.PushPayload
import org.weldsuite.core.realtime.RealtimeEvent

/** What the call screens show. */
data class CallUiState(
    val status: CallStatus = CallStatus.IDLE,
    val incoming: IncomingCall? = null,
    val session: CallSession? = null,
    /** Collapsed to the bar at the top, the call going on. */
    val minimized: Boolean = false,
    /** In the media room (the server's `roomJoined`). */
    val joined: Boolean = false,
    /** Someone else stayed in the room: the call was answered (ringback stops, the timer runs). */
    val connected: Boolean = false,
    val reconnecting: Boolean = false,
    val seconds: Long = 0,
    val micOn: Boolean = true,
    val cameraOn: Boolean = false,
    val speakerOn: Boolean = false,
    val frontCamera: Boolean = true,
    /** Permissions to ask for before joining (the overlay asks, then calls [CallManager.onPermissionsResult]). */
    val needsPermissions: List<String> = emptyList(),
    /** Bumped whenever the room's tracks or people change, to redraw the video. */
    val mediaVersion: Int = 0,
)

/**
 * WeldChat's calls, app-wide (`CallContext.tsx` and `CallHost.tsx` of the
 * Expo app): the ring (realtime `call_incoming` on `chat.user.<id>`, the
 * native ring's actions, recovery from `/chat-calls/active` when the app
 * comes back), the call lifecycle over `/chat-calls/...`, and the media on
 * LiveKit (ADR CHAT-008) with the call's audio routed by [CallAudio].
 *
 * Everything runs on the environment's main scope.
 */
class CallManager(context: Context, private val env: AppEnvironment) {
    private val app = context.applicationContext
    private val scope = env.scope
    private val api = CallApi(env)
    private val audio = CallAudio(app)
    private val sounds = CallSounds(app)

    private val stateFlow = MutableStateFlow(CallUiState())
    val state: StateFlow<CallUiState> = stateFlow.asStateFlow()

    private val activeCalls = MutableStateFlow<Map<String, ActiveChannelCall>>(emptyMap())

    /** Calls running per channel, for the channel screen's "Join". Kept live by `call_started` / `call_ended`. */
    val activeChannelCalls: StateFlow<Map<String, ActiveChannelCall>> = activeCalls.asStateFlow()

    private val joinedCall = MutableStateFlow<String?>(null)

    /** The joined call's id; null when not in a call. */
    val inCallId: StateFlow<String?> = joinedCall.asStateFlow()

    private val roomFlow = MutableStateFlow<Room?>(null)

    /** The media room of the joined call, for drawing its video. */
    val room: StateFlow<Room?> = roomFlow.asStateFlow()

    private val messageFlow = MutableSharedFlow<Int>(extraBufferCapacity = 4)

    /** Something to tell the person (a string resource), such as a call that failed. */
    val messages: SharedFlow<Int> = messageFlow.asSharedFlow()

    private val historyFlow = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /** A call started or ended in one of the person's conversations: the Calls list reloads. */
    val historyChanged: SharedFlow<Unit> = historyFlow.asSharedFlow()

    /** The signed-in person's id, once [start] ran. */
    var userId: String? = null
        private set

    private var subscription: Job? = null
    private var roomJob: Job? = null
    private var latchJob: Job? = null
    private var peerGoneJob: Job? = null
    private var timerJob: Job? = null
    private var connectingJob: Job? = null
    private var ringTimeoutJob: Job? = null
    private var startedAt = 0L
    private var joinInFlight = false
    private var videoUrl: String? = null
    private var videoUrlLoaded = false

    /** An Answer or a ring tap that came before the session was ready (a cold start). */
    private var pending: Pair<String, IncomingCall>? = null

    /** Calls that stopped ringing here, so a late event can't ring them again. */
    private val ended = mutableMapOf<String, Long>()

    init {
        CallRinging.manager = this
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                scope.launch { recoverIncoming() }
            }
        })
    }

    private val available: Boolean get() = env.isAvailable(FEATURE)

    /** Whether the app is on screen (a ring then shows in the app instead of as a notification). */
    internal fun isForeground(): Boolean = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

    /**
     * The person is signed in, in a workspace: listen on their own topic
     * (rings, calls starting and ending), register this device's call token
     * there, recover a ring the app missed, and run an Answer that launched
     * the app. Again for each workspace.
     */
    fun start(userId: String) {
        if (!available) return
        this.userId = userId
        subscription?.cancel()
        subscription = scope.launch {
            env.realtime?.events(listOf("chat.user.$userId"))?.collect(::onPersonalEvent)
        }
        scope.launch { registerCallToken() }
        scope.launch { recoverIncoming() }
        pending?.let { (action, ring) ->
            pending = null
            run(action, ring)
        }
    }

    // ── Starting and joining ─────────────────────────────────────────────

    /** Start a call in a channel, or join the one running there. Throws when it fails. */
    suspend fun startCall(channelId: String, callType: CallType, peer: CallPeer?) {
        if (joinInFlight) return
        joinInFlight = true
        stateFlow.update { it.copy(status = CallStatus.CONNECTING) }
        try {
            val joined = api.startAndJoin(channelId, callType)
            begin(
                CallSession(
                    callId = joined.callId,
                    channelId = channelId,
                    callType = joined.callType ?: callType,
                    token = joined.token,
                    isDirect = peer?.isDirect == true,
                    peerName = peer?.name,
                    peerAvatar = peer?.avatar,
                ),
            )
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            reset()
            throw error
        } finally {
            joinInFlight = false
        }
    }

    /** Join a running call by id. Throws when it fails. */
    suspend fun joinCall(callId: String, peer: CallPeer?) {
        if (joinInFlight) return
        joinInFlight = true
        stateFlow.update { it.copy(status = CallStatus.CONNECTING) }
        try {
            val call = api.get(callId) ?: throw IllegalStateException("The call is over")
            val joined = api.join(callId)
            begin(
                CallSession(
                    callId = callId,
                    channelId = call.channelId,
                    callType = joined.callType ?: call.callType,
                    token = joined.token,
                    isDirect = peer?.isDirect == true,
                    peerName = peer?.name,
                    peerAvatar = peer?.avatar,
                ),
            )
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            reset()
            throw error
        } finally {
            joinInFlight = false
        }
    }

    /** The channel's running call, for its "Join" button. */
    suspend fun refreshActiveCall(channelId: String) {
        if (!available) return
        val call = runCatching { api.activeIn(channelId) }.getOrElse { if (it is CancellationException) throw it else return }
        setChannelCall(channelId, call?.let { ActiveChannelCall(it.id, it.callType) })
    }

    // ── Ringing ──────────────────────────────────────────────────────────

    /** A tapped push about a call (`chat_incoming_call`, or a ring's notification): show the ring. */
    fun presentIncoming(payload: PushPayload) {
        val ring = CallPushes.incomingFromNotification(payload.values)
            ?: (CallPushes.parse(payload.values) as? CallPush.Ring)?.call
            ?: return
        if (userId == null) pending = CallRinging.ACTION_OPEN to ring else present(ring)
    }

    /**
     * The ring's notification was tapped or answered, or the ongoing call's
     * notification opened the app. True when the intent was one of those.
     */
    fun handleIntent(intent: Intent?): Boolean {
        val action = intent?.getStringExtra(CallRinging.EXTRA_ACTION) ?: return false
        val extras = intent.getBundleExtra(CallRinging.EXTRA_PAYLOAD)
        intent.removeExtra(CallRinging.EXTRA_ACTION)
        intent.removeExtra(CallRinging.EXTRA_PAYLOAD)
        if (action == CallRinging.ACTION_RETURN) {
            expand()
            return true
        }
        val ring = extras?.let { CallPushes.fromExtras(it.strings()) } ?: return true
        if (action == CallRinging.ACTION_ACCEPT) CallRinging.cancelRing(app, ring.callId)
        if (userId == null) pending = action to ring else run(action, ring)
        return true
    }

    private fun run(action: String, ring: IncomingCall) {
        when (action) {
            CallRinging.ACTION_ACCEPT -> if (stateFlow.value.session?.callId != ring.callId) scope.launch { accept(ring) }
            CallRinging.ACTION_OPEN -> present(ring)
        }
    }

    /** Ring in the app: the ring screen, the ringtone and the vibration. */
    internal fun present(ring: IncomingCall) {
        if (!available || wasEnded(ring.callId)) return
        val current = stateFlow.value
        if (current.session?.callId == ring.callId) return
        if (current.status != CallStatus.IDLE) {
            // Already ringing for it (a push and the socket): the in-app ring has it.
            if (current.incoming?.callId == ring.callId) CallRinging.cancelRing(app, ring.callId)
            return
        }
        // The in-app ring screen takes over from the ring's notification.
        CallRinging.cancelRing(app, ring.callId)
        stateFlow.update { it.copy(status = CallStatus.RINGING_INCOMING, incoming = ring) }
        sounds.ring()
        ringTimeoutJob?.cancel()
        val remaining = (ring.expiresAt ?: (System.currentTimeMillis() + CallRules.DEFAULT_RING_MS)) - System.currentTimeMillis()
        ringTimeoutJob = scope.launch {
            delay(remaining.coerceIn(0, CallRules.DEFAULT_RING_MS))
            if (stateFlow.value.incoming?.callId == ring.callId) dropRing(ring.callId)
        }
    }

    /** Answer the ringing call. */
    fun acceptIncoming() {
        val ring = stateFlow.value.incoming ?: return
        scope.launch { accept(ring) }
    }

    /** Decline the ringing call. */
    fun declineIncoming() {
        val ring = stateFlow.value.incoming ?: return
        dropRing(ring.callId)
        scope.launch { quietly { api.decline(ring.callId) } }
    }

    /** The server stopped the ring (answered elsewhere, the caller hung up, it timed out). */
    internal fun dismissRing(callId: String) {
        remember(callId)
        CallRinging.cancelRing(app, callId)
        if (stateFlow.value.incoming?.callId == callId) dropRing(callId)
    }

    /** Declined on the ring's notification; declined on the server already when [declinedOnServer]. */
    internal fun onDeclinedFromNotification(ring: IncomingCall, declinedOnServer: Boolean) {
        remember(ring.callId)
        if (stateFlow.value.incoming?.callId == ring.callId) dropRing(ring.callId)
        if (!declinedOnServer) scope.launch { quietly { api.decline(ring.callId) } }
    }

    internal fun isInCall(callId: String): Boolean = stateFlow.value.session?.callId == callId

    internal fun wasEnded(callId: String): Boolean {
        val now = System.currentTimeMillis()
        ended.entries.removeAll { now - it.value > ENDED_MEMORY_MS }
        return ended.containsKey(callId)
    }

    private fun remember(callId: String) {
        ended[callId] = System.currentTimeMillis()
    }

    private fun dropRing(callId: String) {
        remember(callId)
        ringTimeoutJob?.cancel()
        sounds.stop()
        stateFlow.update {
            if (it.incoming?.callId != callId) {
                it
            } else {
                it.copy(incoming = null, status = if (it.status == CallStatus.RINGING_INCOMING) CallStatus.IDLE else it.status)
            }
        }
    }

    private suspend fun accept(ring: IncomingCall) {
        if (joinInFlight) return
        joinInFlight = true
        ringTimeoutJob?.cancel()
        sounds.stop()
        CallRinging.cancelRing(app, ring.callId)
        stateFlow.update { it.copy(incoming = null, status = CallStatus.CONNECTING) }
        try {
            val joined = api.join(ring.callId)
            val peer = CallRules.peerOfAnsweredCall(ring, joined.participants, userId)
            begin(
                CallSession(
                    callId = ring.callId,
                    channelId = joined.channelId ?: ring.channelId,
                    callType = joined.callType ?: ring.callType,
                    token = joined.token,
                    // Only DMs ring, so an answered ring is always 1:1.
                    isDirect = true,
                    peerName = peer.name,
                    peerAvatar = peer.avatar,
                    answered = true,
                ),
            )
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            reset()
            messageFlow.tryEmit(R.string.weldchat_channel_call_failed_body)
        } finally {
            joinInFlight = false
        }
    }

    /** After the app was away the socket may have missed a ring: a DM call ringing for the person. */
    private suspend fun recoverIncoming() {
        val me = userId ?: return
        if (!available || stateFlow.value.status != CallStatus.IDLE) return
        val calls = runCatching { api.active() }.getOrElse { if (it is CancellationException) throw it else return }
        val candidate = CallRules.recoveryCandidate(calls, me) ?: return
        if (stateFlow.value.status != CallStatus.IDLE) return
        present(
            IncomingCall(
                callId = candidate.callId,
                channelId = candidate.channelId,
                callType = candidate.callType,
                callerName = candidate.initiatorName,
            ),
        )
    }

    /** This device's call token (`fcm_call`, device `<id>:call`): the server rings it with a data-only push. */
    private suspend fun registerCallToken() {
        val tokens = env.pushTokens ?: return
        val token = env.pushProvider?.token() ?: return
        val workspace = env.session?.activeWorkspaceId ?: return
        tokens.register(token, PushTokenRegistration.TokenType.FCM_CALL, tokens.deviceId + ":call", workspace)
    }

    // ── The person's own topic ───────────────────────────────────────────

    private fun onPersonalEvent(event: RealtimeEvent) {
        when (event.event) {
            "call_incoming" -> CallPushes.fromRealtime(event.data)?.let(::present)
            "call_started" -> {
                val channelId = event.data.field("channelId")
                val callId = event.data.field("callId")
                if (channelId != null && callId != null) {
                    setChannelCall(channelId, ActiveChannelCall(callId, CallType.of(event.data.field("callType"))))
                }
                historyFlow.tryEmit(Unit)
            }
            "call_ended" -> {
                callEnded(event.data.field("channelId"), event.data.field("callId"))
                historyFlow.tryEmit(Unit)
            }
            // Answered on another device or the web: stop ringing here.
            "call_answered" -> event.data.field("callId")?.let { if (stateFlow.value.incoming?.callId == it) dropRing(it) }
            RealtimeEvent.RESYNC -> scope.launch { recoverIncoming() }
        }
    }

    private fun callEnded(channelId: String?, callId: String?) {
        if (channelId != null) setChannelCall(channelId, null)
        if (callId == null) {
            stateFlow.value.incoming?.let { dropRing(it.callId) }
            return
        }
        // The caller hung up before anyone answered: every ring for it stops.
        if (stateFlow.value.session?.callId != callId) CallRinging.cancelRing(app, callId)
        if (stateFlow.value.incoming?.callId == callId) dropRing(callId)
    }

    private fun setChannelCall(channelId: String, call: ActiveChannelCall?) {
        activeCalls.update { current ->
            when {
                call == null && channelId !in current -> current
                call == null -> current - channelId
                current[channelId] == call -> current
                else -> current + (channelId to call)
            }
        }
    }

    // ── The call itself ──────────────────────────────────────────────────

    private fun begin(session: CallSession) {
        val video = session.callType == CallType.VIDEO
        audio.speakerOn = video
        stateFlow.value = CallUiState(
            status = CallStatus.CONNECTING,
            session = session,
            micOn = true,
            cameraOn = video,
            speakerOn = video,
        )
        joinedCall.value = session.callId
        if (session.isDirect && !session.answered) sounds.ringback()
        connectingJob?.cancel()
        connectingJob = scope.launch {
            delay(CallRules.CONNECTING_TIMEOUT_MS)
            if (stateFlow.value.session?.callId == session.callId && stateFlow.value.status == CallStatus.CONNECTING) leaveCall()
        }
        val missing = missingPermissions(session.callType)
        if (missing.isEmpty()) connect(session) else stateFlow.update { it.copy(needsPermissions = missing) }
    }

    /**
     * The overlay asked for permissions: join with whatever was granted, or,
     * in the call, turn on the microphone or camera that was asked for.
     */
    fun onPermissionsResult() {
        val session = stateFlow.value.session ?: return
        val asked = stateFlow.value.needsPermissions
        if (asked.isEmpty()) return
        stateFlow.update { it.copy(needsPermissions = emptyList()) }
        val room = roomFlow.value
        if (room == null) {
            connect(session)
            return
        }
        scope.launch {
            if (Manifest.permission.RECORD_AUDIO in asked && granted(Manifest.permission.RECORD_AUDIO)) {
                quietly { room.localParticipant.setMicrophoneEnabled(true) }
            }
            if (Manifest.permission.CAMERA in asked && granted(Manifest.permission.CAMERA)) {
                quietly { room.localParticipant.setCameraEnabled(true) }
            }
            stateFlow.update {
                it.copy(
                    micOn = room.localParticipant.isMicrophoneEnabled,
                    cameraOn = room.localParticipant.isCameraEnabled,
                    mediaVersion = it.mediaVersion + 1,
                )
            }
        }
    }

    private fun missingPermissions(type: CallType): List<String> {
        val wanted = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (type == CallType.VIDEO) add(Manifest.permission.CAMERA)
        }
        return wanted.filter { !granted(it) }
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(app, permission) == PackageManager.PERMISSION_GRANTED

    private fun connect(session: CallSession) {
        roomJob?.cancel()
        roomJob = scope.launch {
            val url = liveKitUrl()
            if (url == null) {
                messageFlow.tryEmit(R.string.weldchat_call_unjoinable)
                leaveCall()
                return@launch
            }
            val room = LiveKit.create(
                app,
                RoomOptions(adaptiveStream = true, dynacast = true),
                LiveKitOverrides(audioOptions = AudioOptions(audioHandler = audio)),
            )
            roomFlow.value = room
            launch { room.events.events.collect { onRoomEvent(session, room, it) } }
            try {
                room.connect(url, session.token)
                CallForegroundService.start(app, session.peerName, session.callType == CallType.VIDEO)
                val mic = granted(Manifest.permission.RECORD_AUDIO)
                room.localParticipant.setMicrophoneEnabled(mic)
                val camera = session.callType == CallType.VIDEO && granted(Manifest.permission.CAMERA)
                if (camera) room.localParticipant.setCameraEnabled(true)
                stateFlow.update { it.copy(micOn = mic, cameraOn = camera) }
                joined()
                evaluatePresence(session, room)
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                messageFlow.tryEmit(R.string.weldchat_channel_call_failed_body)
                leaveCall()
            }
        }
    }

    private fun joined() {
        connectingJob?.cancel()
        stateFlow.update {
            it.copy(
                joined = true,
                reconnecting = false,
                status = if (it.status == CallStatus.CONNECTING) CallStatus.CONNECTED else it.status,
                mediaVersion = it.mediaVersion + 1,
            )
        }
    }

    private fun onRoomEvent(session: CallSession, room: Room, event: RoomEvent) {
        when (event) {
            is RoomEvent.Connected, is RoomEvent.Reconnected -> {
                joined()
                evaluatePresence(session, room)
            }
            // A dropped connection the SDK is already restoring: stay in the call.
            is RoomEvent.Reconnecting -> stateFlow.update { it.copy(reconnecting = true) }
            is RoomEvent.Disconnected -> leaveCall()
            is RoomEvent.ParticipantConnected, is RoomEvent.ParticipantDisconnected -> {
                bumpMedia()
                evaluatePresence(session, room)
            }
            else -> bumpMedia()
        }
    }

    private fun bumpMedia() {
        stateFlow.update { it.copy(mediaVersion = it.mediaVersion + 1) }
    }

    /**
     * The answered latch: someone else stayed in the room for a moment (the
     * ringback stops, the timer starts). On a 1:1 call the other person
     * leaving doesn't end it server side while this phone is in the room, so
     * this hangs up after a grace period that rides out their reconnect.
     */
    private fun evaluatePresence(session: CallSession, room: Room) {
        val present = room.remoteParticipants.isNotEmpty()
        val state = stateFlow.value
        if (state.session?.callId != session.callId) return
        if (!state.connected) {
            if (present) {
                if (latchJob == null) {
                    latchJob = scope.launch {
                        delay(CallRules.ANSWER_LATCH_MS)
                        latchJob = null
                        if (room.remoteParticipants.isNotEmpty()) answered()
                    }
                }
            } else {
                latchJob?.cancel()
                latchJob = null
            }
            return
        }
        if (!session.isDirect) return
        if (present) {
            peerGoneJob?.cancel()
            peerGoneJob = null
        } else if (peerGoneJob == null) {
            peerGoneJob = scope.launch {
                delay(CallRules.PEER_GONE_GRACE_MS)
                peerGoneJob = null
                if (room.remoteParticipants.isEmpty() && !stateFlow.value.reconnecting) leaveCall()
            }
        }
    }

    private fun answered() {
        sounds.stop()
        startedAt = System.currentTimeMillis()
        stateFlow.update { it.copy(connected = true) }
        timerJob?.cancel()
        timerJob = scope.launch {
            while (isActive) {
                stateFlow.update { it.copy(seconds = (System.currentTimeMillis() - startedAt) / 1000) }
                delay(1000)
            }
        }
    }

    /** The other people's video, for the stage. */
    fun remoteVideoTracks(): List<VideoTrack> {
        val room = roomFlow.value ?: return emptyList()
        return room.remoteParticipants.values.flatMap { participant ->
            participant.videoTrackPublications.mapNotNull { (publication, track) ->
                (track as? VideoTrack)?.takeIf { !publication.muted }
            }
        }
    }

    /** This phone's camera, for the preview. */
    fun localVideoTrack(): VideoTrack? {
        if (!stateFlow.value.cameraOn) return null
        val room = roomFlow.value ?: return null
        return room.localParticipant.getTrackPublication(Track.Source.CAMERA)?.track as? VideoTrack
    }

    fun toggleMic() {
        val room = roomFlow.value ?: return
        val next = !stateFlow.value.micOn
        if (next && !granted(Manifest.permission.RECORD_AUDIO)) {
            stateFlow.update { it.copy(needsPermissions = listOf(Manifest.permission.RECORD_AUDIO)) }
            return
        }
        scope.launch {
            quietly { room.localParticipant.setMicrophoneEnabled(next) }
            stateFlow.update { it.copy(micOn = room.localParticipant.isMicrophoneEnabled) }
        }
    }

    fun toggleCamera() {
        val room = roomFlow.value ?: return
        val next = !stateFlow.value.cameraOn
        if (next && !granted(Manifest.permission.CAMERA)) {
            stateFlow.update { it.copy(needsPermissions = listOf(Manifest.permission.CAMERA)) }
            return
        }
        scope.launch {
            quietly { room.localParticipant.setCameraEnabled(next) }
            stateFlow.update { it.copy(cameraOn = room.localParticipant.isCameraEnabled, mediaVersion = it.mediaVersion + 1) }
        }
    }

    fun flipCamera() {
        val track = roomFlow.value?.localParticipant?.getTrackPublication(Track.Source.CAMERA)?.track as? LocalVideoTrack ?: return
        val front = stateFlow.value.frontCamera
        runCatching { track.switchCamera(null, if (front) CameraPosition.BACK else CameraPosition.FRONT) }
            .onSuccess { stateFlow.update { it.copy(frontCamera = !front, mediaVersion = it.mediaVersion + 1) } }
    }

    fun toggleSpeaker() {
        val next = !stateFlow.value.speakerOn
        audio.speakerOn = next
        stateFlow.update { it.copy(speakerOn = next) }
    }

    fun minimize() {
        if (stateFlow.value.session != null) stateFlow.update { it.copy(minimized = true) }
    }

    fun expand() {
        stateFlow.update { it.copy(minimized = false) }
    }

    /** Hang up. */
    fun leaveCall() {
        scope.launch { leave() }
    }

    private suspend fun leave() {
        val session = stateFlow.value.session ?: run {
            reset()
            return
        }
        remember(session.callId)
        reset()
        quietly { api.leave(session.callId) }
    }

    /** Back to no call: the room left, the sounds and the service stopped. */
    private fun reset() {
        roomJob?.cancel()
        roomJob = null
        for (job in listOf(latchJob, peerGoneJob, timerJob, connectingJob)) job?.cancel()
        latchJob = null
        peerGoneJob = null
        timerJob = null
        connectingJob = null
        roomFlow.value?.let { room ->
            runCatching {
                room.disconnect()
                room.release()
            }
        }
        roomFlow.value = null
        audio.stop()
        sounds.stop()
        CallForegroundService.stop(app)
        val incoming = stateFlow.value.incoming
        stateFlow.value = CallUiState(
            status = if (incoming != null) CallStatus.RINGING_INCOMING else CallStatus.IDLE,
            incoming = incoming,
        )
        joinedCall.value = null
    }

    /** `/config.json`'s LiveKit server, read once (the core doesn't keep it). */
    private suspend fun liveKitUrl(): String? {
        if (videoUrlLoaded) return videoUrl
        val config = withContext(Dispatchers.IO) {
            runCatching {
                val request = Request.Builder().url("${env.serverOrigin}/config.json").build()
                env.http.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) null else response.body?.string()
                }
            }.getOrNull()
        } ?: return null
        val json = runCatching { WeldJson.parseToJsonElement(config).jsonObject }.getOrNull() ?: return null
        videoUrl = CallRules.liveKitUrl(json.text("videoProvider"), json.text("videoUrl"))
        videoUrlLoaded = true
        return videoUrl
    }

    private suspend fun quietly(block: suspend () -> Unit) {
        try {
            block()
        } catch (error: Exception) {
            if (error is CancellationException) throw error
        }
    }

    private companion object {
        /** The edition feature calls hang on (`unavailableFeatures`). */
        const val FEATURE = "chat-calls"
        const val ENDED_MEMORY_MS = 120_000L
    }
}

private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

private fun Bundle.strings(): Map<String, String> = keySet().mapNotNull { key -> getString(key)?.let { key to it } }.toMap()

/** The ringtone of an in-app ring (with the vibration), and the ringback of an outgoing direct call. */
private class CallSounds(private val context: Context) {
    private val audio = context.getSystemService(AudioManager::class.java)
    private var player: MediaPlayer? = null

    private val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        context.getSystemService(VibratorManager::class.java)?.defaultVibrator
    } else {
        legacyVibrator()
    }

    fun ring() {
        stop()
        if (audio.ringerMode == AudioManager.RINGER_MODE_NORMAL) play(R.raw.weldchat_ringtone, AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
        if (audio.ringerMode != AudioManager.RINGER_MODE_SILENT) vibrate()
    }

    fun ringback() {
        stop()
        play(R.raw.weldchat_ringback, AudioAttributes.USAGE_VOICE_COMMUNICATION)
    }

    fun stop() {
        player?.let { runCatching { it.stop() } }
        player?.release()
        player = null
        vibrator?.cancel()
    }

    private fun play(@RawRes sound: Int, usage: Int) {
        val attributes = AudioAttributes.Builder()
            .setUsage(usage)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        player = MediaPlayer.create(context, sound, attributes, AudioManager.AUDIO_SESSION_ID_GENERATE)?.apply {
            isLooping = true
            start()
        }
    }

    private fun vibrate() {
        val vibrator = vibrator ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(VibrationEffect.createWaveform(RING_PATTERN, 0))
        } else {
            legacyVibrate(vibrator)
        }
    }

    @Suppress("DEPRECATION")
    private fun legacyVibrator(): Vibrator? = context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator

    @Suppress("DEPRECATION")
    private fun legacyVibrate(vibrator: Vibrator) {
        vibrator.vibrate(RING_PATTERN, 0)
    }

    private companion object {
        /** Vibrate, pause, vibrate: the ring of a phone. */
        val RING_PATTERN = longArrayOf(0, 1000, 2000)
    }
}
