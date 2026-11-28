package com.weldsuite.weldchat.ui.channel

import android.Manifest
import android.app.Application
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.outlined.Call
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material3.AlertDialog
import org.weldsuite.ui.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import org.weldsuite.ui.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import org.weldsuite.ui.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.weldsuite.weldchat.ChannelRules
import com.weldsuite.weldchat.ChatLogic
import com.weldsuite.weldchat.ChatMessage
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.ConversationKind
import com.weldsuite.weldchat.ConversationRules
import com.weldsuite.weldchat.MentionText
import com.weldsuite.weldchat.MessageLayout
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.RecordChatRules
import com.weldsuite.weldchat.RecordRefreshKind
import com.weldsuite.weldchat.calls.ActiveChannelCall
import com.weldsuite.weldchat.calls.CallManager
import com.weldsuite.weldchat.calls.CallType
import com.weldsuite.weldchat.media.AttachmentSourceDialog
import com.weldsuite.weldchat.media.ImageViewer
import com.weldsuite.weldchat.media.ImageViewerState
import com.weldsuite.weldchat.media.VoiceRecorder
import com.weldsuite.weldchat.media.rememberAttachmentPicker
import com.weldsuite.weldchat.text
import com.weldsuite.weldchat.ui.BackButton
import com.weldsuite.weldchat.ui.ChatAvatar
import com.weldsuite.weldchat.ui.ChatNavigator
import com.weldsuite.weldchat.ui.DmAvatar
import com.weldsuite.weldchat.ui.LocalNotify
import com.weldsuite.weldchat.ui.RecordOpener
import com.weldsuite.weldchat.ui.copyText
import com.weldsuite.weldchat.ui.recordIcon
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import org.weldsuite.core.R as CoreR

/** A sheet over a conversation: a held message's actions, the full reaction list, or the pin steps. */
private sealed interface MessageSheet {
    data class Actions(val message: ChatMessage) : MessageSheet
    data class Reactions(val message: ChatMessage) : MessageSheet
    data class Pin(val message: ChatMessage) : MessageSheet
}

/**
 * A channel, a DM or a record chat (the iOS `ChannelView`, the Expo
 * `ChannelView`): the header (who or what, calls, follow), the pinned bar,
 * the messages newest at the bottom with older pages as you scroll up, and
 * the composer. Hold a message for its actions, drag it right to reply.
 * [userId] is the signed-in person; [name], [type] and [entityType] are
 * what the tapped row knew, shown until the channel loads.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelScreen(
    env: AppEnvironment,
    store: ChatStore,
    calls: CallManager,
    userId: String,
    channelId: String,
    name: String?,
    type: String?,
    entityType: String?,
    nav: ChatNavigator,
) {
    val context = LocalContext.current
    val notify = LocalNotify.current
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val model: ChannelModel = viewModel(key = "channel-$channelId") {
        ChannelModel(channelId, store, env, userId, context.applicationContext as Application)
    }
    val callState by calls.state.collectAsStateWithLifecycle()
    val activeCalls by calls.activeChannelCalls.collectAsStateWithLifecycle()
    val inCallId by calls.inCallId.collectAsStateWithLifecycle()
    val callsAvailable = env.isAvailable("chat-calls")

    val kind = ConversationKind.of(model.channel?.type ?: type)
    val displayName = ChannelRules.displayName(model.channel, name)
    val currentEntityType = model.channel?.entityType ?: entityType
    val peerUserId = if (kind == ConversationKind.DM) ChannelRules.peerUserId(model.dm, displayName, store.roster) else null
    val activeCall = activeCalls[channelId]
    val joinable = ChannelRules.joinableCall(activeCall, inCallId)
    val timeline = model.timeline
    val rows = timeline.rows
    val names = model.names
    val pinned = model.pinned
    val candidates = model.mentionQuery?.let { ChannelRules.mentionCandidates(it, model.agents, store.roster) }.orEmpty()

    val listState = rememberLazyListState()
    val focusRequester = remember { FocusRequester() }
    var sheet by remember { mutableStateOf<MessageSheet?>(null) }
    var viewer by remember { mutableStateOf<ImageViewerState?>(null) }
    var deleteTarget by remember { mutableStateOf<ChatMessage?>(null) }
    var unpinTarget by remember { mutableStateOf<ChatMessage?>(null) }
    var flashId by remember { mutableStateOf<String?>(null) }
    var micDenied by remember { mutableStateOf(false) }
    var callFailed by remember { mutableStateOf(false) }
    var showAttach by remember { mutableStateOf(false) }

    // Texts the actions need outside composition.
    val you = stringResource(R.string.weldchat_channel_you)
    val texts = ChannelTexts(
        aiUnavailable = stringResource(R.string.weldchat_channel_ai_unavailable),
        sendFailed = stringResource(R.string.weldchat_channel_send_failed),
        editFailed = stringResource(R.string.weldchat_channel_edit_failed),
        reactionFailed = stringResource(R.string.weldchat_channel_reaction_failed),
        pinFailed = stringResource(R.string.weldchat_channel_pin_failed),
        pinLimit = stringResource(R.string.weldchat_channel_pin_limit),
        deleteFailed = stringResource(R.string.weldchat_channel_delete_failed),
        copied = stringResource(R.string.weldchat_channel_copied),
        saved = stringResource(R.string.weldchat_channel_saved_for_later),
        alreadySaved = stringResource(R.string.weldchat_channel_already_saved),
        saveFailed = stringResource(R.string.weldchat_channel_save_message_failed),
        furtherBack = stringResource(R.string.weldchat_channel_original_further_back),
        recordFailed = stringResource(R.string.weldchat_composer_record_failed),
        voiceTooShort = stringResource(R.string.weldchat_composer_voice_too_short),
        voiceFailed = stringResource(R.string.weldchat_composer_voice_send_failed),
        followFailed = stringResource(R.string.weldchat_record_chats_follow_failed),
        unfollowFailed = stringResource(R.string.weldchat_record_chats_unfollow_failed),
        muteFailed = stringResource(R.string.weldchat_record_chats_mute_failed),
    )

    // On screen: load (the first time) or refresh, and keep the room open.
    DisposableEffect(model) {
        model.start()
        onDispose { model.stop() }
    }
    LaunchedEffect(channelId) {
        store.loadRosterIfNeeded()
        calls.refreshActiveCall(channelId)
    }

    // Follow new messages while at the bottom (or when it's your own send).
    var atBottom by remember { mutableStateOf(true) }
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }.collect { scrolling ->
            if (!scrolling) atBottom = listState.firstVisibleItemIndex == 0
        }
    }
    val newest = rows.lastOrNull()
    LaunchedEffect(newest?.id) {
        if (newest != null && (atBottom || newest.pending)) listState.animateScrollToItem(0)
    }
    // Older pages as the top comes into view.
    val nearTop by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: -1
            info.totalItemsCount > 0 && last >= info.totalItemsCount - 2
        }
    }
    LaunchedEffect(nearTop, model.hasOlder, rows.size) {
        // On the screen's scope: a page arriving re-keys this effect, which must not cut the load short.
        if (nearTop && model.hasOlder && !model.loading) scope.launch { model.loadOlder() }
    }
    val showScrollToLatest by remember { derivedStateOf { listState.firstVisibleItemIndex > 0 } }

    fun focusComposerSoon() {
        scope.launch {
            delay(300)
            runCatching { focusRequester.requestFocus() }
            keyboard?.show()
        }
    }

    fun jump(id: String) {
        val index = ConversationRules.listIndex(rows, id)
        if (index == null) {
            notify(texts.furtherBack)
            return
        }
        scope.launch {
            listState.animateScrollToItem(index)
            flashId = id
            delay(ChannelRules.JUMP_FLASH_MS)
            if (flashId == id) flashId = null
        }
    }

    fun react(message: ChatMessage, emoji: String) {
        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
        env.scope.launch { if (!model.toggleReaction(message, emoji)) notify(texts.reactionFailed) }
    }

    fun send() {
        env.scope.launch {
            when (model.send(you)) {
                ChannelModel.SendOutcome.SENT, ChannelModel.SendOutcome.EDITED -> Unit
                ChannelModel.SendOutcome.AI_UNAVAILABLE -> notify(texts.aiUnavailable)
                ChannelModel.SendOutcome.FAILED -> notify(texts.sendFailed)
                ChannelModel.SendOutcome.EDIT_FAILED -> notify(texts.editFailed)
            }
        }
    }

    fun beginRecording() {
        when (model.startRecording()) {
            VoiceRecorder.StartResult.STARTED -> haptics.performHapticFeedback(HapticFeedbackType.LongPress)
            VoiceRecorder.StartResult.DENIED -> micDenied = true
            VoiceRecorder.StartResult.FAILED -> notify(texts.recordFailed)
        }
    }

    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) beginRecording() else micDenied = true
    }

    fun startRecording() {
        focusManager.clearFocus()
        if (model.recorder.hasPermission()) beginRecording() else micPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

    fun sendVoice() {
        env.scope.launch {
            when (model.sendVoice()) {
                ChannelModel.VoiceOutcome.SENT -> {
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    listState.animateScrollToItem(0)
                }
                ChannelModel.VoiceOutcome.TOO_SHORT -> notify(texts.voiceTooShort)
                ChannelModel.VoiceOutcome.FAILED -> notify(texts.voiceFailed)
            }
        }
    }

    /** Join the call running here, or start one (the server's start-and-join joins a running one too). */
    fun startOrJoinCall(callType: CallType, running: ActiveChannelCall?) {
        focusManager.clearFocus()
        val peer = ChannelRules.callPeer(kind, displayName, model.dm?.picture)
        env.scope.launch {
            try {
                if (running != null) calls.joinCall(running.callId, peer) else calls.startCall(channelId, callType, peer)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                callFailed = true
            }
        }
    }

    fun toggleFollow() {
        val wasFollowing = model.following == true
        env.scope.launch {
            if (model.toggleFollow()) {
                store.refreshRecordChats(RecordRefreshKind.ALL)
            } else {
                notify(if (wasFollowing) texts.unfollowFailed else texts.followFailed)
            }
        }
    }

    /** Unpin at once; a new pin asks for how long first, unless three are pinned. */
    fun pinTapped(message: ChatMessage) {
        when {
            message.isPinned -> {
                sheet = null
                env.scope.launch { model.unpin(message) }
            }
            !ChannelRules.canPin(pinned.size) -> {
                sheet = null
                notify(texts.pinLimit)
            }
            else -> sheet = MessageSheet.Pin(message)
        }
    }

    fun save(message: ChatMessage) {
        env.scope.launch {
            try {
                val already = store.repository.bookmark(message.id, channelId)
                notify(if (already) texts.alreadySaved else texts.saved)
                store.loadCounts()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                notify(texts.saveFailed)
            }
        }
    }

    val rowActions = MessageRowActions(
        openActions = { message ->
            focusManager.clearFocus()
            sheet = MessageSheet.Actions(message)
        },
        reply = { message ->
            model.startReply(message)
            focusComposerSoon()
        },
        toggleReaction = { message, emoji -> react(message, emoji) },
        openImage = { url -> viewer = ImageViewerState(ChannelRules.images(model.messages), url) },
        openProfile = { id ->
            focusManager.clearFocus()
            nav.openMember(id)
        },
        openThread = { message -> nav.openThread(message.id, channelId) },
        jumpTo = { id -> jump(id) },
    )

    val picker = rememberAttachmentPicker { files -> model.pendingFiles = model.pendingFiles + files }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { BackButton(onClick = { nav.back() }, tag = "channel-back") },
                title = {
                    ChannelIdentity(
                        kind = kind,
                        name = displayName,
                        model = model,
                        store = store,
                        entityType = currentEntityType,
                        peerUserId = peerUserId,
                        onOpenMember = { id ->
                            focusManager.clearFocus()
                            nav.openMember(id)
                        },
                        onOpenInfo = {
                            focusManager.clearFocus()
                            nav.openChannelInfo(channelId, displayName)
                        },
                        onOpenRecord = { recordType, entityId ->
                            env.scope.launch { RecordOpener.open(context, recordType, entityId, store.repository, notify) }
                        },
                        onToggleMute = {
                            env.scope.launch { if (!model.toggleRecordMute()) notify(texts.muteFailed) }
                        },
                    )
                },
                actions = {
                    val following = model.following
                    if (kind == ConversationKind.RECORD && following != null) {
                        FollowButton(following, onClick = ::toggleFollow)
                    }
                    // Calls need the server's video provider.
                    if (callsAvailable) {
                        if (joinable != null) {
                            JoinCallButton(joinable.callType) { startOrJoinCall(joinable.callType, activeCall) }
                        } else {
                            val inCall = callState.session != null
                            IconButton(onClick = { startOrJoinCall(CallType.VIDEO, activeCall) }, enabled = !inCall, modifier = Modifier.tagged("channel-call-video")) {
                                Icon(Icons.Outlined.Videocam, contentDescription = stringResource(R.string.weldchat_channel_start_video_call))
                            }
                            IconButton(onClick = { startOrJoinCall(CallType.VOICE, activeCall) }, enabled = !inCall, modifier = Modifier.tagged("channel-call-voice")) {
                                Icon(Icons.Outlined.Call, contentDescription = stringResource(R.string.weldchat_channel_start_voice_call))
                            }
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePadding(),
        ) {
            if (pinned.isNotEmpty()) {
                val position = ChatLogic.pinnedPosition(model.pinnedIndex, pinned.size)
                val current = pinned[position]
                PinnedBar(
                    message = current,
                    position = position,
                    count = pinned.size,
                    names = names,
                    onTap = {
                        if (pinned.size > 1) model.pinnedIndex += 1
                        ConversationRules.listIndex(rows, current.id)?.let { index -> scope.launch { listState.animateScrollToItem(index) } }
                    },
                    onUnpin = { unpinTarget = current },
                )
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                MessageList(
                    listState = listState,
                    model = model,
                    timeline = timeline,
                    names = names,
                    selfId = userId,
                    flashId = flashId,
                    activeCall = activeCall,
                    joinable = joinable,
                    actions = rowActions,
                    onJoinCall = { callType -> startOrJoinCall(callType, activeCall) },
                )
                if (rows.isEmpty()) {
                    EmptyConversation(loading = model.loading || (model.channel == null && displayName.isEmpty()), kind = kind, name = displayName)
                }
                if (showScrollToLatest && rows.isNotEmpty()) {
                    val label = stringResource(R.string.weldchat_channel_scroll_to_latest)
                    SmallFloatingActionButton(
                        onClick = { scope.launch { listState.animateScrollToItem(0) } },
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .padding(Tokens.Spacing.m)
                            .semantics { contentDescription = label }
                            .tagged("scroll-to-latest"),
                    ) {
                        Icon(Icons.Filled.KeyboardArrowDown, contentDescription = null)
                    }
                }
            }
            ChannelComposer(
                model = model,
                placeholder = ChannelRules.placeholder(kind, displayName).text(),
                candidates = candidates,
                typing = model.room?.typingUserIds?.let { ids ->
                    ChatLogic.typingLabel(ids, names, stringResource(R.string.weldchat_channel_someone))?.text()
                },
                isArchived = model.channel?.isArchived == true,
                focusRequester = focusRequester,
                onAttach = {
                    focusManager.clearFocus()
                    showAttach = true
                },
                onSend = ::send,
                onStartRecording = ::startRecording,
                onSendVoice = ::sendVoice,
                onContinueInThread = {
                    model.continueInThread()?.let { (rootId, draft) ->
                        focusManager.clearFocus()
                        nav.openThread(rootId, channelId, draft)
                    }
                },
                onUnarchive = {
                    env.scope.launch {
                        if (model.unarchive()) {
                            store.loadDmList()
                            nav.back()
                        }
                    }
                },
            )
        }
    }

    // Sheets and dialogs.
    when (val current = sheet) {
        is MessageSheet.Actions -> {
            val message = current.message
            MessageActionsSheet(
                message = message,
                isOwn = message.authorId == userId,
                onDismiss = { sheet = null },
                onQuickReact = { emoji ->
                    sheet = null
                    react(message, emoji)
                },
                onMoreReactions = { sheet = MessageSheet.Reactions(message) },
                onReply = {
                    sheet = null
                    model.startReply(message)
                    focusComposerSoon()
                },
                onThread = {
                    sheet = null
                    nav.openThread(message.id, channelId)
                },
                onCopy = {
                    sheet = null
                    copyText(context, ChannelRules.copyText(message, names))
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    notify(texts.copied)
                },
                onPin = { pinTapped(message) },
                onSave = {
                    sheet = null
                    save(message)
                },
                onEdit = {
                    sheet = null
                    model.startEdit(message)
                    focusComposerSoon()
                },
                onDelete = {
                    sheet = null
                    deleteTarget = message
                },
            )
        }
        is MessageSheet.Reactions -> ReactionPickerSheet(onDismiss = { sheet = null }) { emoji ->
            sheet = null
            react(current.message, emoji)
        }
        is MessageSheet.Pin -> PinMessageSheet(onDismiss = { sheet = null }) { duration, notifyOthers ->
            sheet = null
            env.scope.launch { if (!model.pin(current.message, duration, notifyOthers)) notify(texts.pinFailed) }
        }
        null -> Unit
    }

    viewer?.let { state -> ImageViewer(state) { viewer = null } }
    if (showAttach) AttachmentSourceDialog(picker, onDismiss = { showAttach = false })

    deleteTarget?.let { message ->
        ConfirmDialog(
            title = stringResource(R.string.weldchat_channel_delete_message_title),
            body = stringResource(R.string.weldchat_channel_delete_message_body),
            confirm = stringResource(CoreR.string.core_common_delete),
            onDismiss = { deleteTarget = null },
        ) {
            deleteTarget = null
            env.scope.launch { if (!model.delete(message)) notify(texts.deleteFailed) }
        }
    }
    unpinTarget?.let { message ->
        ConfirmDialog(
            title = stringResource(R.string.weldchat_channel_unpin_title),
            body = stringResource(R.string.weldchat_channel_unpin_body),
            confirm = stringResource(R.string.weldchat_channel_unpin),
            onDismiss = { unpinTarget = null },
        ) {
            unpinTarget = null
            env.scope.launch { model.unpin(message) }
        }
    }
    if (micDenied) {
        AlertDialog(
            onDismissRequest = { micDenied = false },
            title = { Text(stringResource(R.string.weldchat_composer_mic_permission_title)) },
            text = { Text(stringResource(R.string.weldchat_composer_mic_permission_body)) },
            confirmButton = {
                TextButton(onClick = {
                    micDenied = false
                    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                    try {
                        context.startActivity(intent)
                    } catch (_: ActivityNotFoundException) {
                        // No settings screen to open.
                    }
                }) { Text(stringResource(R.string.weldchat_composer_open_settings)) }
            },
            dismissButton = { TextButton(onClick = { micDenied = false }) { Text(stringResource(CoreR.string.core_common_cancel)) } },
        )
    }
    if (callFailed) {
        AlertDialog(
            onDismissRequest = { callFailed = false },
            title = { Text(stringResource(R.string.weldchat_channel_call_failed_title)) },
            text = { Text(stringResource(R.string.weldchat_channel_call_failed_body)) },
            confirmButton = { TextButton(onClick = { callFailed = false }) { Text(stringResource(CoreR.string.core_common_close)) } },
        )
    }
}

/** The screen's messages, resolved once per composition for the actions that run later. */
private data class ChannelTexts(
    val aiUnavailable: String,
    val sendFailed: String,
    val editFailed: String,
    val reactionFailed: String,
    val pinFailed: String,
    val pinLimit: String,
    val deleteFailed: String,
    val copied: String,
    val saved: String,
    val alreadySaved: String,
    val saveFailed: String,
    val furtherBack: String,
    val recordFailed: String,
    val voiceTooShort: String,
    val voiceFailed: String,
    val followFailed: String,
    val unfollowFailed: String,
    val muteFailed: String,
)

/** The messages, newest at the bottom (a reversed list, so it stays there), older pages on top. */
@Composable
private fun MessageList(
    listState: LazyListState,
    model: ChannelModel,
    timeline: Timeline,
    names: Map<String, String>,
    selfId: String,
    flashId: String?,
    activeCall: ActiveChannelCall?,
    joinable: ActiveChannelCall?,
    actions: MessageRowActions,
    onJoinCall: (CallType) -> Unit,
) {
    val rows = timeline.rows
    val drawn = rows.asReversed()
    LazyColumn(
        state = listState,
        reverseLayout = true,
        modifier = Modifier.fillMaxSize().tagged("message-list"),
    ) {
        itemsIndexed(drawn, key = { _, message -> message.id }) { index, message ->
            val previous = rows.getOrNull(rows.size - 2 - index)
            Column(Modifier.fillMaxWidth()) {
                if (MessageLayout.startsNewDay(message, previous)) message.instant?.let { DateSeparator(it) }
                if (message.isSystem) {
                    val entry = timeline.calls[message.id]
                    if (entry != null) {
                        val ongoing = entry.outcome == null && timeline.openCallId == message.id && activeCall != null
                        CallLogCard(
                            entry = entry,
                            ongoing = ongoing,
                            joinable = ongoing && joinable != null,
                            createdAt = message.createdAt,
                        ) { onJoinCall(if (entry.isVideo) CallType.VIDEO else CallType.VOICE) }
                    } else {
                        SystemMessageRow(MentionText.plainText(message.content, names))
                    }
                } else {
                    MessageRow(
                        message = message,
                        compact = MessageLayout.isCompact(message, previous),
                        names = names,
                        selfId = selfId,
                        actions = actions,
                        highlighted = model.replyTo?.messageId == message.id || flashId == message.id,
                    )
                }
            }
        }
        if (model.hasOlder) {
            item(key = "older") { LoadingRow() }
        }
    }
}

/** No messages yet: a spinner while loading, else the conversation's welcome. */
@Composable
private fun EmptyConversation(loading: Boolean, kind: ConversationKind, name: String) {
    Column(
        Modifier.fillMaxSize().padding(horizontal = Tokens.Spacing.xl, vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s, Alignment.CenterVertically),
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.tagged("channel-loading"))
        } else {
            Text(
                ChannelRules.welcome(kind, name).text(),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
            )
            Text(
                stringResource(R.string.weldchat_channel_start_of_conversation),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** The pinned message on show, which of how many, a tap to cycle, an X to unpin. */
@Composable
private fun PinnedBar(
    message: ChatMessage,
    position: Int,
    count: Int,
    names: Map<String, String>,
    onTap: () -> Unit,
    onUnpin: () -> Unit,
) {
    val brand = MaterialTheme.colorScheme.primary
    Surface(tonalElevation = 2.dp, modifier = Modifier.fillMaxWidth().clickable(onClick = onTap).tagged("pinned-bar")) {
        Column {
            Row(
                Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
            ) {
                Column(Modifier.height(32.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    repeat(count) { index ->
                        Box(
                            Modifier
                                .width(3.dp)
                                .weight(1f)
                                .background(if (index == position) brand else MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(2.dp)),
                        )
                    }
                }
                Icon(Icons.Filled.PushPin, contentDescription = null, tint = brand, modifier = Modifier.size(16.dp))
                Column(Modifier.weight(1f)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s), verticalAlignment = Alignment.CenterVertically) {
                        Text(message.authorName, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (count > 1) {
                            Text(
                                stringResource(R.string.weldchat_channel_pin_position, (position + 1).toString(), count),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    Text(MentionText.plainText(message.content, names), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                IconButton(onClick = onUnpin, modifier = Modifier.size(32.dp).tagged("pinned-unpin")) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = stringResource(R.string.weldchat_channel_unpin),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
            HorizontalDivider()
        }
    }
}

/**
 * The header's avatar or icon, name and what it is; a tap opens the person,
 * the channel's details, or a record chat's menu (open in its app, mute).
 */
@Composable
private fun ChannelIdentity(
    kind: ConversationKind,
    name: String,
    model: ChannelModel,
    store: ChatStore,
    entityType: String?,
    peerUserId: String?,
    onOpenMember: (String) -> Unit,
    onOpenInfo: () -> Unit,
    onOpenRecord: (String, String) -> Unit,
    onToggleMute: () -> Unit,
) {
    val details = stringResource(R.string.weldchat_channel_channel_details)
    when (kind) {
        ConversationKind.RECORD -> {
            val entityId = model.channel?.entityId
            val app = if (entityId == null) null else entityType?.let { RecordChatRules.app(it) }
            val following = model.following == true
            var menu by remember { mutableStateOf(false) }
            Box {
                IdentityLabel(
                    kind = kind,
                    name = name,
                    model = model,
                    store = store,
                    entityType = entityType,
                    peerUserId = peerUserId,
                    modifier = Modifier
                        .then(if (app != null || following) Modifier.clickable { menu = true } else Modifier)
                        .tagged("channel-title"),
                )
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    if (app != null && entityType != null && entityId != null) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.weldchat_record_chats_open_in, app)) },
                            leadingIcon = { Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = null) },
                            onClick = {
                                menu = false
                                onOpenRecord(entityType, entityId)
                            },
                            modifier = Modifier.tagged("channel-open-record"),
                        )
                    }
                    if (following) {
                        val muted = model.recordMuted
                        DropdownMenuItem(
                            text = { Text(stringResource(if (muted) R.string.weldchat_record_chats_unmute else R.string.weldchat_record_chats_mute)) },
                            leadingIcon = { Icon(if (muted) Icons.Filled.Notifications else Icons.Filled.NotificationsOff, contentDescription = null) },
                            onClick = {
                                menu = false
                                onToggleMute()
                            },
                            modifier = Modifier.tagged("channel-record-mute"),
                        )
                    }
                }
            }
        }
        ConversationKind.DM -> IdentityLabel(
            kind = kind,
            name = name,
            model = model,
            store = store,
            entityType = entityType,
            peerUserId = peerUserId,
            modifier = Modifier
                .then(if (peerUserId != null) Modifier.clickable { onOpenMember(peerUserId) } else Modifier)
                .tagged("channel-title"),
        )
        ConversationKind.CHANNEL, ConversationKind.PRIVATE_CHANNEL -> IdentityLabel(
            kind = kind,
            name = name,
            model = model,
            store = store,
            entityType = entityType,
            peerUserId = peerUserId,
            modifier = Modifier
                .then(if (model.channel != null) Modifier.clickable(onClick = onOpenInfo) else Modifier)
                .semantics { contentDescription = if (name.isEmpty()) details else "$name, $details" }
                .tagged("channel-title"),
        )
    }
}

@Composable
private fun IdentityLabel(
    kind: ConversationKind,
    name: String,
    model: ChannelModel,
    store: ChatStore,
    entityType: String?,
    peerUserId: String?,
    modifier: Modifier = Modifier,
) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        HeaderIcon(kind, name, model, store, entityType, peerUserId)
        Column {
            Text(
                name.ifEmpty { stringResource(R.string.weldchat_channel_loading_title) },
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val subtitle = when (kind) {
                ConversationKind.DM -> peerUserId?.let { ChannelRules.presenceSubtitle(store.memberStatus(it)) }
                ConversationKind.RECORD -> entityType?.takeIf { RecordChatRules.isType(it) }?.let { RecordChatRules.typeLabel(it) }
                ConversationKind.CHANNEL, ConversationKind.PRIVATE_CHANNEL -> null
            }
            if (subtitle != null) {
                Text(
                    stringResource(subtitle),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
private fun HeaderIcon(kind: ConversationKind, name: String, model: ChannelModel, store: ChatStore, entityType: String?, peerUserId: String?) {
    when (kind) {
        ConversationKind.DM -> Box {
            val dm = model.dm
            if (dm != null) DmAvatar(dm, 30.dp) else ChatAvatar(name, null, 30.dp)
            if (peerUserId != null && store.memberStatus(peerUserId)?.uppercase() == "ACTIVE") {
                Box(
                    Modifier
                        .align(Alignment.BottomEnd)
                        .size(10.dp)
                        .border(2.dp, MaterialTheme.colorScheme.surface, CircleShape)
                        .background(Tokens.Status.success.current(), CircleShape),
                )
            }
        }
        ConversationKind.RECORD -> Icon(recordIcon(entityType), contentDescription = null, modifier = Modifier.size(20.dp))
        ConversationKind.PRIVATE_CHANNEL -> Icon(Icons.Filled.Lock, contentDescription = null, modifier = Modifier.size(20.dp))
        ConversationKind.CHANNEL -> Icon(Icons.Filled.Tag, contentDescription = null, modifier = Modifier.size(20.dp))
    }
}

/** A record chat's Follow / Following. */
@Composable
private fun FollowButton(following: Boolean, onClick: () -> Unit) {
    val modifier = Modifier.padding(end = Tokens.Spacing.xs).tagged("channel-follow")
    if (following) {
        OutlinedButton(onClick = onClick, modifier = modifier) { Text(stringResource(R.string.weldchat_record_chats_following)) }
    } else {
        FilledTonalButton(onClick = onClick, modifier = modifier) { Text(stringResource(R.string.weldchat_record_chats_follow)) }
    }
}

/** "Join" while a call runs here that the person isn't in. */
@Composable
private fun JoinCallButton(callType: CallType, onClick: () -> Unit) {
    val kindLabel = stringResource(if (callType == CallType.VIDEO) R.string.weldchat_in_call_video_call else R.string.weldchat_in_call_voice_call)
    val join = stringResource(R.string.weldchat_channel_join_call)
    Button(
        onClick = onClick,
        colors = ButtonDefaults.buttonColors(containerColor = Tokens.Status.success.current()),
        modifier = Modifier
            .padding(end = Tokens.Spacing.xs)
            .semantics { contentDescription = "$join: $kindLabel" }
            .tagged("channel-join-call"),
    ) {
        Icon(if (callType == CallType.VIDEO) Icons.Filled.Videocam else Icons.Filled.Call, contentDescription = null, modifier = Modifier.size(18.dp))
        Text(join, modifier = Modifier.padding(start = Tokens.Spacing.xs))
    }
}

@Composable
private fun ConfirmDialog(title: String, body: String, confirm: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(body) },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.tagged("confirm")) {
                Text(confirm, color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(CoreR.string.core_common_cancel)) } },
    )
}
