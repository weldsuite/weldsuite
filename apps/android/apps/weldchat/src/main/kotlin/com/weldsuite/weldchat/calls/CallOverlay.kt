package com.weldsuite.weldchat.calls

import android.os.Build
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldchat.R
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.track.VideoTrack
import livekit.org.webrtc.RendererCommon
import org.weldsuite.ui.Avatar
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/** The minimized call's bar, WhatsApp's: dark in light and dark mode alike, the status in green. */
private object CallBar {
    val background = Color(0xFF242625)
    val button = Color(0xFF101010)
    val green = Color(0xFF82E382)
    val red = Color(0xFFD62E3F)
}

/** The call's height at the top of the screen while minimized, below the status bar. */
val CallBarHeight = 56.dp

/**
 * Every call screen, over the app: the ring (where the system's call
 * notification isn't showing it), the joined call full screen, and the
 * bar it shrinks to. Put it last in the app's root, over everything.
 */
@Composable
fun CallOverlay(manager: CallManager, onOpenChat: (channelId: String, isDirect: Boolean) -> Unit) {
    val state by manager.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val activity = LocalActivity.current

    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        manager.onPermissionsResult()
    }
    LaunchedEffect(state.needsPermissions) {
        if (state.needsPermissions.isNotEmpty()) permissions.launch(state.needsPermissions.toTypedArray())
    }
    LaunchedEffect(manager) {
        manager.messages.collect { Toast.makeText(context, context.getString(it), Toast.LENGTH_LONG).show() }
    }
    // A ring or a call shows over the lock screen and wakes it, as the phone app does.
    val overLockScreen = state.incoming != null || state.session != null
    DisposableEffect(overLockScreen) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            activity?.setShowWhenLocked(overLockScreen)
            activity?.setTurnScreenOn(overLockScreen)
        }
        onDispose { }
    }

    val session = state.session
    val incoming = state.incoming
    when {
        session != null && !state.minimized -> {
            BackHandler { manager.minimize() }
            CallScreen(manager, state, session) {
                manager.minimize()
                onOpenChat(session.channelId, session.isDirect)
            }
        }
        session != null -> MinimizedBar(manager, state, session)
        incoming != null -> IncomingCallScreen(incoming, onAccept = manager::acceptIncoming, onDecline = manager::declineIncoming)
    }
}

/** Under the title: Calling …, Ringing, Connecting, Reconnecting or the call's length. */
@Composable
private fun statusText(state: CallUiState, session: CallSession): String = when {
    state.reconnecting -> stringResource(R.string.weldchat_call_reconnecting)
    state.connected -> CallRules.timer(state.seconds)
    !state.joined && session.isDirect && !session.answered ->
        session.peerName?.let { stringResource(R.string.weldchat_call_calling, it) } ?: stringResource(R.string.weldchat_call_calling_someone)
    !state.joined || session.answered -> stringResource(R.string.weldchat_call_connecting)
    else -> stringResource(R.string.weldchat_call_ringing)
}

@Composable
private fun CallScreen(manager: CallManager, state: CallUiState, session: CallSession, onBackToChat: () -> Unit) {
    val video = session.callType == CallType.VIDEO
    val title = session.peerName ?: stringResource(if (video) R.string.weldchat_in_call_video_call else R.string.weldchat_in_call_voice_call)
    val room by manager.room.collectAsStateWithLifecycle()
    Surface(Modifier.fillMaxSize().tagged("call-overlay"), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().systemBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.s)) {
                IconButton(onClick = manager::minimize, modifier = Modifier.tagged("call-minimize")) {
                    Icon(Icons.Filled.KeyboardArrowDown, contentDescription = stringResource(R.string.weldchat_in_call_minimize))
                }
                Spacer(Modifier.weight(1f))
                IconButton(onClick = onBackToChat, modifier = Modifier.tagged("call-back-to-chat")) {
                    Icon(Icons.AutoMirrored.Filled.Chat, contentDescription = stringResource(R.string.weldchat_in_call_back_to_chat))
                }
            }
            Text(
                title,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.align(Alignment.CenterHorizontally).padding(horizontal = Tokens.Spacing.l),
            )
            Text(
                statusText(state, session),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.align(Alignment.CenterHorizontally).padding(top = Tokens.Spacing.xs),
            )
            Box(Modifier.weight(1f).fillMaxWidth().padding(Tokens.Spacing.l), contentAlignment = Alignment.Center) {
                val current = room
                val remote = remember(current, state.mediaVersion) { manager.remoteVideoTracks() }
                val local = remember(current, state.mediaVersion, state.cameraOn) { manager.localVideoTrack() }
                if (video && current != null && remote.isNotEmpty()) {
                    VideoGrid(current, remote)
                } else {
                    PeerAvatar(session, size = 160)
                }
                if (video && current != null && local != null) {
                    VideoView(
                        current,
                        local,
                        mirror = state.frontCamera,
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .size(width = 110.dp, height = 160.dp)
                            .clip(RoundedCornerShape(Tokens.Radius.medium)),
                    )
                }
            }
            CallControls(manager, state, video, onBackToChat)
        }
    }
}

@Composable
private fun PeerAvatar(session: CallSession, size: Int) {
    if (session.isDirect) {
        Avatar(session.peerName, session.peerAvatar, size = size.dp)
    } else {
        Box(
            Modifier.size(size.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Tag, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size((size / 2).dp))
        }
    }
}

/** Up to four people's video, in a column (two) or two rows of two. */
@Composable
private fun VideoGrid(room: Room, tracks: List<VideoTrack>) {
    val shown = tracks.take(4)
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        shown.chunked(if (shown.size > 2) 2 else 1).forEach { row ->
            Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                row.forEach { track ->
                    VideoView(room, track, mirror = false, modifier = Modifier.weight(1f).fillMaxSize().clip(RoundedCornerShape(Tokens.Radius.medium)))
                }
            }
        }
    }
}

/** A LiveKit video track drawn in a `TextureViewRenderer`. */
@Composable
private fun VideoView(room: Room, track: VideoTrack, mirror: Boolean, modifier: Modifier = Modifier) {
    var renderer by remember { mutableStateOf<TextureViewRenderer?>(null) }
    AndroidView(
        factory = { context ->
            TextureViewRenderer(context).also { view ->
                room.initVideoRenderer(view)
                view.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
                renderer = view
            }
        },
        update = { it.setMirror(mirror) },
        onRelease = { it.release() },
        modifier = modifier,
    )
    val view = renderer
    DisposableEffect(track, view) {
        if (view != null) track.addRenderer(view)
        onDispose { if (view != null) track.removeRenderer(view) }
    }
}

@Composable
private fun CallControls(manager: CallManager, state: CallUiState, video: Boolean, onBackToChat: () -> Unit) {
    var more by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.l),
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ControlButton(
            icon = if (state.micOn) Icons.Filled.Mic else Icons.Filled.MicOff,
            label = stringResource(if (state.micOn) R.string.weldchat_in_call_turn_off_mic else R.string.weldchat_in_call_turn_on_mic),
            on = state.micOn,
            tag = "call-mic",
            onClick = manager::toggleMic,
        )
        if (video) {
            ControlButton(
                icon = if (state.cameraOn) Icons.Filled.Videocam else Icons.Filled.VideocamOff,
                label = stringResource(if (state.cameraOn) R.string.weldchat_in_call_turn_off_camera else R.string.weldchat_in_call_turn_on_camera),
                on = state.cameraOn,
                tag = "call-camera",
                onClick = manager::toggleCamera,
            )
        }
        Box {
            ControlButton(
                icon = Icons.Filled.MoreVert,
                label = stringResource(R.string.weldchat_in_call_more_options),
                on = true,
                tag = "call-more",
                onClick = { more = true },
            )
            DropdownMenu(expanded = more, onDismissRequest = { more = false }) {
                if (video) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.weldchat_in_call_flip_camera)) },
                        leadingIcon = { Icon(Icons.Filled.Cameraswitch, contentDescription = null) },
                        onClick = {
                            more = false
                            manager.flipCamera()
                        },
                    )
                }
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.weldchat_call_speaker)) },
                    leadingIcon = { Icon(Icons.AutoMirrored.Filled.VolumeUp, contentDescription = null) },
                    trailingIcon = { if (state.speakerOn) Icon(Icons.Filled.Check, contentDescription = null) },
                    onClick = {
                        more = false
                        manager.toggleSpeaker()
                    },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.weldchat_in_call_back_to_chat)) },
                    leadingIcon = { Icon(Icons.AutoMirrored.Filled.Chat, contentDescription = null) },
                    onClick = {
                        more = false
                        onBackToChat()
                    },
                )
            }
        }
        FilledIconButton(
            onClick = manager::leaveCall,
            colors = IconButtonDefaults.filledIconButtonColors(containerColor = CallBar.red, contentColor = Color.White),
            shape = RoundedCornerShape(Tokens.Radius.medium),
            modifier = Modifier.weight(1f).height(48.dp).tagged("call-leave"),
        ) {
            Icon(Icons.Filled.CallEnd, contentDescription = stringResource(R.string.weldchat_in_call_leave_call))
        }
    }
}

@Composable
private fun ControlButton(icon: ImageVector, label: String, on: Boolean, tag: String, onClick: () -> Unit) {
    val colors = if (on) {
        IconButtonDefaults.filledIconButtonColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
            contentColor = MaterialTheme.colorScheme.onSurface,
        )
    } else {
        IconButtonDefaults.filledIconButtonColors(
            containerColor = MaterialTheme.colorScheme.errorContainer,
            contentColor = MaterialTheme.colorScheme.onErrorContainer,
        )
    }
    FilledIconButton(
        onClick = onClick,
        colors = colors,
        shape = RoundedCornerShape(Tokens.Radius.medium),
        modifier = Modifier.size(48.dp).tagged(tag),
    ) {
        Icon(icon, contentDescription = label)
    }
}

/** The call collapsed to a bar at the top: mute, "name · status" (back to the call), end. */
@Composable
private fun MinimizedBar(manager: CallManager, state: CallUiState, session: CallSession) {
    val status = statusText(state, session)
    val returnLabel = stringResource(R.string.weldchat_call_return_to_call)
    Row(
        Modifier
            .fillMaxWidth()
            .background(CallBar.background)
            .windowInsetsPadding(WindowInsets.statusBars)
            .height(CallBarHeight)
            .padding(horizontal = Tokens.Spacing.m)
            .tagged("call-bar"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FilledIconButton(
            onClick = manager::toggleMic,
            colors = IconButtonDefaults.filledIconButtonColors(
                containerColor = if (state.micOn) CallBar.button else Color.White,
                contentColor = if (state.micOn) Color.White else CallBar.button,
            ),
            modifier = Modifier.size(40.dp).tagged("call-bar-mute"),
        ) {
            Icon(Icons.Filled.MicOff, contentDescription = stringResource(if (state.micOn) R.string.weldchat_call_mute else R.string.weldchat_call_unmute))
        }
        Row(
            Modifier
                .weight(1f)
                .clickable(onClick = manager::expand)
                .semantics { contentDescription = returnLabel }
                .padding(horizontal = Tokens.Spacing.m),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Call, contentDescription = null, tint = CallBar.green, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(Tokens.Spacing.s))
            Text(
                session.peerName?.let { stringResource(R.string.weldchat_call_bar_title, it, status) } ?: status,
                color = CallBar.green,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        FilledIconButton(
            onClick = manager::leaveCall,
            colors = IconButtonDefaults.filledIconButtonColors(containerColor = CallBar.red, contentColor = Color.White),
            modifier = Modifier.size(40.dp).tagged("call-bar-end"),
        ) {
            Icon(Icons.Filled.CallEnd, contentDescription = stringResource(R.string.weldchat_call_end_call))
        }
    }
}

/** The in-app ring (`IncomingCallModal`): who is calling, Decline and Accept. */
@Composable
private fun IncomingCallScreen(call: IncomingCall, onAccept: () -> Unit, onDecline: () -> Unit) {
    val name = call.callerName ?: stringResource(R.string.weldchat_call_unknown_caller)
    val video = call.callType == CallType.VIDEO
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            Modifier.fillMaxSize().systemBarsPadding().navigationBarsPadding().padding(Tokens.Spacing.xl),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.weight(1f))
            Avatar(name, call.callerAvatar, size = 120.dp)
            Text(
                name,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = Tokens.Spacing.l),
            )
            Text(
                stringResource(if (video) R.string.weldchat_call_incoming_video else R.string.weldchat_call_incoming_voice),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = Tokens.Spacing.xs),
            )
            Spacer(Modifier.weight(2f))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                RingButton(
                    icon = Icons.Filled.CallEnd,
                    label = stringResource(R.string.weldchat_call_decline),
                    color = CallBar.red,
                    tag = "incoming-decline",
                    onClick = onDecline,
                )
                RingButton(
                    icon = if (video) Icons.Filled.Videocam else Icons.Filled.Call,
                    label = stringResource(R.string.weldchat_call_accept),
                    color = Color(0xFF22C55E),
                    tag = "incoming-accept",
                    onClick = onAccept,
                )
            }
        }
    }
}

@Composable
private fun RingButton(icon: ImageVector, label: String, color: Color, tag: String, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        FilledIconButton(
            onClick = onClick,
            colors = IconButtonDefaults.filledIconButtonColors(containerColor = color, contentColor = Color.White),
            modifier = Modifier.size(72.dp).tagged(tag),
        ) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(32.dp))
        }
        Text(label, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = Tokens.Spacing.s))
    }
}
