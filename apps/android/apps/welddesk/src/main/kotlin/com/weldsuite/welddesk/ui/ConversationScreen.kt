package com.weldsuite.welddesk.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.HowToReg
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material.icons.outlined.PersonRemove
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.Replay
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.weldsuite.welddesk.Attachment
import com.weldsuite.welddesk.Attachments
import com.weldsuite.welddesk.Conversation
import com.weldsuite.welddesk.ConversationDetail
import com.weldsuite.welddesk.ConversationRoom
import com.weldsuite.welddesk.ConversationState
import com.weldsuite.welddesk.DeskLogic
import com.weldsuite.welddesk.DeskRepository
import com.weldsuite.welddesk.ManageAction
import com.weldsuite.welddesk.Member
import com.weldsuite.welddesk.MessageKind
import com.weldsuite.welddesk.R
import com.weldsuite.welddesk.ReadResult
import com.weldsuite.welddesk.RoomState
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.api.ApiException
import org.weldsuite.core.realtime.RealtimeEvent
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.util.UUID

/** A file on the reply being written: uploading, or uploaded to the conversation. */
data class PendingFile(val key: String, val name: String, val uploaded: Attachment?) {
    val uploading: Boolean get() = uploaded == null
}

data class ConversationUiState(
    val detail: ConversationDetail? = null,
    val loading: Boolean = true,
    val error: Throwable? = null,
    val body: String = "",
    val mode: MessageKind = MessageKind.MESSAGE,
    val files: List<PendingFile> = emptyList(),
    val sending: Boolean = false,
    val managing: Boolean = false,
    val members: List<Member>? = null,
    val membersLoading: Boolean = false,
    val membersError: Boolean = false,
) {
    val canSend: Boolean get() = !sending && files.none { it.uploading } && (body.isNotBlank() || files.isNotEmpty())
}

/** What the screen tells the agent once, as a toast and a buzz. */
sealed interface ConversationNotice {
    data object Sent : ConversationNotice
    data object Changed : ConversationNotice
    data object SendFailed : ConversationNotice
    data object ManageFailed : ConversationNotice
    data object AssignFailed : ConversationNotice
    data object OpenFailed : ConversationNotice
    data object TooMany : ConversationNotice
    data object UploadUnavailable : ConversationNotice
    data class UploadFailed(val name: String) : ConversationNotice
    data class Refused(val name: String, val problem: DeskLogic.AttachmentProblem) : ConversationNotice
}

/**
 * One conversation: its thread, kept live by the hub (`desk_message`,
 * `desk_conversation`) and by its room (the visitor typing and online),
 * the composer, and close / reopen / assign.
 */
class ConversationViewModel(
    private val env: AppEnvironment,
    private val repository: DeskRepository,
    val conversationId: String,
    private val userId: String?,
) : ViewModel() {
    private val stateFlow = MutableStateFlow(ConversationUiState(members = repository.cachedMembers()))
    val state: StateFlow<ConversationUiState> = stateFlow.asStateFlow()

    private val roomFlow = MutableStateFlow(RoomState())
    val room: StateFlow<RoomState> = roomFlow.asStateFlow()

    private val noticeChannel = Channel<ConversationNotice>(Channel.BUFFERED)
    val notices = noticeChannel.receiveAsFlow()

    private var socket: ConversationRoom? = null

    init {
        load()
        viewModelScope.launch {
            val joined = ConversationRoom(env, viewModelScope, repository.realtimeRoomBase(), conversationId)
            socket = joined
            joined.start()
            joined.state.collect { roomFlow.value = it }
        }
    }

    fun load() {
        viewModelScope.launch {
            runCatching { repository.conversation(conversationId) }
                .onSuccess { detail ->
                    stateFlow.update { it.copy(detail = detail, loading = false, error = null) }
                    loadAssigneeName(detail.conversation.assigneeId)
                }
                .onFailure { error -> stateFlow.update { it.copy(loading = false, error = error) } }
        }
    }

    fun retry() {
        stateFlow.update { it.copy(loading = true, error = null) }
        load()
    }

    fun setBody(text: String) {
        stateFlow.update { it.copy(body = text) }
        if (stateFlow.value.mode == MessageKind.MESSAGE && text.isNotBlank()) socket?.typed()
    }

    fun setMode(mode: MessageKind) {
        stateFlow.update { it.copy(mode = mode) }
        if (mode == MessageKind.NOTE) socket?.stopTyping()
    }

    fun send() {
        val current = stateFlow.value
        if (!current.canSend) return
        stateFlow.update { it.copy(sending = true) }
        socket?.stopTyping()
        val attachments = current.files.mapNotNull { it.uploaded }
        viewModelScope.launch {
            runCatching { repository.reply(conversationId, current.mode, current.body, attachments) }
                .onSuccess { change ->
                    stateFlow.update { it.copy(body = "", files = emptyList(), sending = false) }
                    apply(change.conversation)
                    merge(change.message)
                    noticeChannel.trySend(ConversationNotice.Sent)
                }
                .onFailure {
                    // The draft stays, to try again.
                    stateFlow.update { it.copy(sending = false) }
                    noticeChannel.trySend(ConversationNotice.SendFailed)
                }
        }
    }

    fun toggleState() {
        val conversation = stateFlow.value.detail?.conversation ?: return
        manage(if (conversation.state == ConversationState.OPEN) ManageAction.Close else ManageAction.Reopen, ConversationNotice.ManageFailed)
    }

    /** Null unassigns. */
    fun assign(assigneeId: String?) = manage(ManageAction.Assign(assigneeId), ConversationNotice.AssignFailed)

    private fun manage(action: ManageAction, failure: ConversationNotice) {
        if (stateFlow.value.managing) return
        stateFlow.update { it.copy(managing = true) }
        viewModelScope.launch {
            runCatching { repository.manage(conversationId, action) }
                .onSuccess { change ->
                    apply(change.conversation)
                    merge(change.message)
                    noticeChannel.trySend(ConversationNotice.Changed)
                }
                .onFailure { noticeChannel.trySend(failure) }
            stateFlow.update { it.copy(managing = false) }
        }
    }

    fun loadMembers(force: Boolean = false) {
        if (stateFlow.value.membersLoading) return
        stateFlow.update { it.copy(membersLoading = true, membersError = false) }
        viewModelScope.launch {
            runCatching { repository.members(force) }
                .onSuccess { list -> stateFlow.update { it.copy(members = list, membersLoading = false) } }
                .onFailure { stateFlow.update { it.copy(membersLoading = false, membersError = true) } }
        }
    }

    /** A teammate's name for the header: the roster, loaded once. */
    private fun loadAssigneeName(assigneeId: String?) {
        if (assigneeId.isNullOrEmpty() || assigneeId == userId || stateFlow.value.members != null) return
        loadMembers()
    }

    fun attach(uri: Uri, fallbackName: String) {
        if (stateFlow.value.files.size >= DeskLogic.MAX_ATTACHMENTS) {
            noticeChannel.trySend(ConversationNotice.TooMany)
            return
        }
        val key = UUID.randomUUID().toString()
        viewModelScope.launch {
            when (val read = repository.read(uri, fallbackName)) {
                is ReadResult.Refused -> noticeChannel.trySend(ConversationNotice.Refused(read.name, read.problem))
                is ReadResult.Failed -> noticeChannel.trySend(ConversationNotice.UploadFailed(read.name))
                is ReadResult.File -> {
                    stateFlow.update { it.copy(files = it.files + PendingFile(key, read.file.name, null)) }
                    runCatching { repository.upload(conversationId, read.file) }
                        .onSuccess { uploaded ->
                            stateFlow.update { state ->
                                state.copy(files = state.files.map { if (it.key == key) it.copy(uploaded = uploaded) else it })
                            }
                        }
                        .onFailure { error ->
                            stateFlow.update { state -> state.copy(files = state.files.filterNot { it.key == key }) }
                            val notice = if ((error as? ApiException)?.status == 503) {
                                ConversationNotice.UploadUnavailable
                            } else {
                                ConversationNotice.UploadFailed(read.file.name)
                            }
                            noticeChannel.trySend(notice)
                        }
                }
            }
        }
    }

    fun removeFile(key: String) = stateFlow.update { state -> state.copy(files = state.files.filterNot { it.key == key }) }

    fun attachmentOpenFailed() {
        noticeChannel.trySend(ConversationNotice.OpenFailed)
    }

    /** A hub event: patch the thread with the record, or reload after a gap. */
    fun hubEvent(event: RealtimeEvent) {
        if (event.isResync) {
            load()
            return
        }
        when (event.topic) {
            "desk_message" -> DeskRepository.messageFromEvent(event.data)
                ?.takeIf { it.conversationId == conversationId }
                ?.let(::merge)
            "desk_conversation" -> DeskRepository.conversationFromEvent(event.data)
                ?.takeIf { it.id == conversationId }
                ?.let(::apply)
        }
    }

    private fun merge(message: com.weldsuite.welddesk.Message) = stateFlow.update { state ->
        val detail = state.detail ?: return@update state
        state.copy(detail = detail.copy(messages = DeskLogic.mergeMessage(detail.messages, message)))
    }

    private fun apply(conversation: Conversation) {
        stateFlow.update { state ->
            val detail = state.detail ?: return@update state
            state.copy(detail = detail.copy(conversation = conversation))
        }
        loadAssigneeName(conversation.assigneeId)
    }

    override fun onCleared() {
        socket?.stop()
        socket = null
    }
}

/** The conversation that's open, so its notifications don't pop up over it. */
object OpenConversation {
    @Volatile
    var id: String? = null
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ConversationScreen(
    env: AppEnvironment,
    model: ConversationViewModel,
    userId: String?,
    onBack: () -> Unit,
    notify: (String) -> Unit,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val room by model.room.collectAsStateWithLifecycle()
    val haptics = LocalHapticFeedback.current
    var picking by rememberSaveable { mutableStateOf(false) }
    val listState = rememberLazyListState()

    // The hub, while the thread is on screen.
    LaunchedEffect(model) {
        env.realtime?.events(listOf("desk_message", "desk_conversation"))?.collect { model.hubEvent(it) }
    }
    DisposableEffect(model.conversationId) {
        OpenConversation.id = model.conversationId
        onDispose { if (OpenConversation.id == model.conversationId) OpenConversation.id = null }
    }
    val sendError = stringResource(R.string.welddesk_conversation_send_error)
    val manageError = stringResource(R.string.welddesk_conversation_manage_error)
    val assignError = stringResource(R.string.welddesk_conversation_assign_error)
    val openError = stringResource(R.string.welddesk_conversation_attachment_open_error)
    val tooMany = stringResource(R.string.welddesk_conversation_too_many_attachments)
    val unavailable = stringResource(R.string.welddesk_conversation_upload_unavailable)
    val context = LocalContext.current
    LaunchedEffect(model) {
        model.notices.collect { notice ->
            when (notice) {
                ConversationNotice.Sent, ConversationNotice.Changed -> haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                ConversationNotice.SendFailed -> notify(sendError)
                ConversationNotice.ManageFailed -> notify(manageError)
                ConversationNotice.AssignFailed -> notify(assignError)
                ConversationNotice.OpenFailed -> notify(openError)
                ConversationNotice.TooMany -> notify(tooMany)
                ConversationNotice.UploadUnavailable -> notify(unavailable)
                is ConversationNotice.UploadFailed -> notify(context.getString(R.string.welddesk_conversation_upload_error, notice.name))
                is ConversationNotice.Refused -> notify(
                    context.getString(
                        if (notice.problem == DeskLogic.AttachmentProblem.TOO_LARGE) {
                            R.string.welddesk_conversation_upload_too_large
                        } else {
                            R.string.welddesk_conversation_upload_type_not_allowed
                        },
                        notice.name,
                    ),
                )
            }
            if (notice is ConversationNotice.SendFailed || notice is ConversationNotice.ManageFailed || notice is ConversationNotice.AssignFailed) {
                haptics.performHapticFeedback(HapticFeedbackType.Reject)
            }
        }
    }
    val messages = state.detail?.messages.orEmpty()
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.lastIndex)
    }

    val detail = state.detail
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.tagged("back")) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(org.weldsuite.core.R.string.core_common_close))
                    }
                },
                title = {
                    Column {
                        Text(
                            detail?.conversation?.let(DeskLogic::threadTitle) ?: stringResource(R.string.welddesk_conversation_title),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.tagged("conversation-title"),
                        )
                        detail?.conversation?.email?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                        }
                    }
                },
                actions = {
                    if (detail != null) {
                        val open = detail.conversation.state == ConversationState.OPEN
                        IconButton(onClick = model::toggleState, enabled = !state.managing, modifier = Modifier.tagged("conversation-toggle-state")) {
                            Icon(
                                if (open) Icons.Outlined.CheckCircle else Icons.Outlined.Replay,
                                contentDescription = stringResource(if (open) R.string.welddesk_conversation_close else R.string.welddesk_conversation_reopen),
                            )
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).consumeWindowInsets(padding).imePadding().fillMaxSize()) {
            when {
                detail == null && state.error != null -> DeskLoadError(stringResource(R.string.welddesk_conversation_load_error), state.error, onRetry = model::retry)
                detail == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                else -> {
                    ConversationHeader(detail.conversation, room, state, userId, model, onPick = { picking = true })
                    HorizontalDivider()
                    LazyColumn(
                        Modifier.weight(1f).fillMaxWidth().tagged("thread"),
                        state = listState,
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        if (messages.isEmpty()) {
                            item {
                                Text(
                                    stringResource(R.string.welddesk_conversation_empty_thread),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    textAlign = TextAlign.Center,
                                    modifier = Modifier.fillMaxWidth().padding(top = 40.dp),
                                )
                            }
                        }
                        items(messages, key = { it.id }) { message -> MessageRow(message, onOpenFailed = model::attachmentOpenFailed) }
                    }
                    room.visitorsTyping.firstOrNull()?.let { name ->
                        Text(
                            stringResource(R.string.welddesk_conversation_typing, name.ifBlank { stringResource(R.string.welddesk_conversation_typing_fallback) }),
                            style = MaterialTheme.typography.labelMedium,
                            fontStyle = FontStyle.Italic,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.xs).tagged("typing"),
                        )
                    }
                    Composer(state, model)
                }
            }
        }
    }

    if (picking && detail != null) {
        AssigneeSheet(
            state = state,
            currentAssigneeId = detail.conversation.assigneeId,
            userId = userId,
            onLoad = model::loadMembers,
            onDismiss = { picking = false },
            onSelect = { assignee ->
                picking = false
                model.assign(assignee)
            },
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ConversationHeader(
    conversation: Conversation,
    room: RoomState,
    state: ConversationUiState,
    userId: String?,
    model: ConversationViewModel,
    onPick: () -> Unit,
) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            StateBadge(conversation.state)
            ChannelBadge(conversation)
            Text("#${conversation.number}", style = MaterialTheme.typography.labelLarge, color = muted)
            if (room.visitorOnline) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs), modifier = Modifier.tagged("visitor-online")) {
                    Box(Modifier.size(7.dp).background(Color(0xFF10B981), CircleShape))
                    Text(stringResource(R.string.welddesk_conversation_visitor_online), style = MaterialTheme.typography.labelLarge, color = muted)
                }
            }
        }
        val label = when (val assignee = DeskLogic.assigneeLabel(conversation.assigneeId, userId, state.members)) {
            DeskLogic.AssigneeLabel.Unassigned -> stringResource(R.string.welddesk_conversation_unassigned_label)
            DeskLogic.AssigneeLabel.You -> stringResource(R.string.welddesk_conversation_assigned_to_you)
            DeskLogic.AssigneeLabel.Someone -> stringResource(R.string.welddesk_conversation_assigned_event)
            is DeskLogic.AssigneeLabel.Teammate -> assignee.name
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs)) {
            Text(stringResource(R.string.welddesk_conversation_assignee), style = MaterialTheme.typography.labelLarge, color = muted)
            Text(label, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, modifier = Modifier.tagged("assignee-label"))
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            val mine = !conversation.assigneeId.isNullOrEmpty() && conversation.assigneeId == userId
            if (!mine && userId != null) {
                AssignChip(R.string.welddesk_conversation_assign_to_me, Icons.Outlined.HowToReg, "assign-to-me", !state.managing) { model.assign(userId) }
            }
            AssignChip(R.string.welddesk_conversation_change_assignee, Icons.Outlined.PersonAdd, "change-assignee", !state.managing, onPick)
            if (!conversation.assigneeId.isNullOrEmpty()) {
                AssignChip(R.string.welddesk_conversation_unassign, Icons.Outlined.PersonRemove, "unassign", !state.managing) { model.assign(null) }
            }
        }
    }
}

@Composable
private fun AssignChip(label: Int, icon: androidx.compose.ui.graphics.vector.ImageVector, tag: String, enabled: Boolean, onClick: () -> Unit) {
    val brand = Tokens.Palette.primary.current()
    AssistChip(
        onClick = onClick,
        enabled = enabled,
        label = { Text(stringResource(label)) },
        leadingIcon = { Icon(icon, contentDescription = null, tint = brand, modifier = Modifier.size(16.dp)) },
        colors = AssistChipDefaults.assistChipColors(containerColor = brand.copy(alpha = 0.12f)),
        border = null,
        modifier = Modifier.tagged(tag),
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Composer(state: ConversationUiState, model: ConversationViewModel) {
    val context = LocalContext.current
    var menu by remember { mutableStateOf(false) }
    var cameraTarget by rememberSaveable { mutableStateOf<String?>(null) }
    val photoName = stringResource(R.string.welddesk_conversation_attachment)
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { taken ->
        val target = cameraTarget
        cameraTarget = null
        if (taken && target != null) model.attach(target.toUri(), "photo.jpg")
    }
    val photo = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) model.attach(uri, photoName)
    }
    val document = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) model.attach(uri, photoName)
    }
    Column(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(horizontal = Tokens.Spacing.m, vertical = Tokens.Spacing.s),
        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        HorizontalDivider()
        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            FilterChip(
                selected = state.mode == MessageKind.MESSAGE,
                onClick = { model.setMode(MessageKind.MESSAGE) },
                label = { Text(stringResource(R.string.welddesk_conversation_reply)) },
                modifier = Modifier.tagged("mode-reply"),
            )
            FilterChip(
                selected = state.mode == MessageKind.NOTE,
                onClick = { model.setMode(MessageKind.NOTE) },
                label = { Text(stringResource(R.string.welddesk_conversation_note)) },
                modifier = Modifier.tagged("mode-note"),
            )
        }
        if (state.files.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                state.files.forEach { file ->
                    val remove = stringResource(R.string.welddesk_conversation_remove_attachment, file.name)
                    InputChip(
                        selected = false,
                        onClick = { model.removeFile(file.key) },
                        label = { Text(file.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        leadingIcon = {
                            if (file.uploading) {
                                val uploading = stringResource(R.string.welddesk_conversation_uploading)
                                CircularProgressIndicator(Modifier.size(16.dp).semantics { contentDescription = uploading }, strokeWidth = 2.dp)
                            } else {
                                Icon(Icons.Outlined.Description, contentDescription = null, modifier = Modifier.size(16.dp))
                            }
                        },
                        trailingIcon = { Icon(Icons.Outlined.Close, contentDescription = remove, modifier = Modifier.size(16.dp)) },
                        modifier = Modifier.tagged("pending-attachment"),
                    )
                }
            }
        }
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            Box {
                IconButton(onClick = { menu = true }, modifier = Modifier.tagged("composer-attach")) {
                    Icon(Icons.Outlined.AttachFile, contentDescription = stringResource(R.string.welddesk_conversation_attach))
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.welddesk_conversation_take_photo)) },
                        leadingIcon = { Icon(Icons.Outlined.PhotoCamera, contentDescription = null) },
                        onClick = {
                            menu = false
                            runCatching { Attachments.cameraUri(context) }.getOrNull()?.let { uri ->
                                cameraTarget = uri.toString()
                                camera.launch(uri)
                            }
                        },
                        modifier = Modifier.tagged("attach-camera"),
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.welddesk_conversation_choose_photo)) },
                        leadingIcon = { Icon(Icons.Outlined.Image, contentDescription = null) },
                        onClick = {
                            menu = false
                            photo.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                        },
                        modifier = Modifier.tagged("attach-photo"),
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.welddesk_conversation_choose_file)) },
                        leadingIcon = { Icon(Icons.Outlined.Description, contentDescription = null) },
                        onClick = {
                            menu = false
                            document.launch(DeskLogic.ATTACHMENT_TYPES.toTypedArray())
                        },
                        modifier = Modifier.tagged("attach-file"),
                    )
                }
            }
            OutlinedTextField(
                value = state.body,
                onValueChange = model::setBody,
                placeholder = {
                    Text(
                        stringResource(
                            if (state.mode == MessageKind.NOTE) R.string.welddesk_conversation_note_placeholder else R.string.welddesk_conversation_reply_placeholder,
                        ),
                    )
                },
                maxLines = 5,
                modifier = Modifier.weight(1f).tagged("composer-input"),
            )
            FilledIconButton(onClick = model::send, enabled = state.canSend, modifier = Modifier.tagged("composer-send")) {
                if (state.sending) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                } else {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.welddesk_conversation_send))
                }
            }
        }
    }
}

/** The thread's model, one per conversation on the back stack. */
@Composable
fun rememberConversationModel(env: AppEnvironment, repository: DeskRepository, conversationId: String, userId: String?): ConversationViewModel {
    return androidx.lifecycle.viewmodel.compose.viewModel(key = "conversation-$conversationId") {
        ConversationViewModel(env, repository, conversationId, userId)
    }
}
