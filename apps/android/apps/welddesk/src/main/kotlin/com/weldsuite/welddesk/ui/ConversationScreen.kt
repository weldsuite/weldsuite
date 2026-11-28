package com.weldsuite.welddesk.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.PersonAddAlt
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
import com.weldsuite.welddesk.Message
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
import org.weldsuite.ui.Button
import org.weldsuite.ui.DayNight
import org.weldsuite.ui.OutlinedButton
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.ZoneId
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
                    loadRoster()
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

    /**
     * The roster, loaded once: the timeline names the teammate behind each
     * reply and event, and the header shows the assignee's avatar.
     */
    private fun loadRoster() {
        if (stateFlow.value.members != null || stateFlow.value.membersLoading) return
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
        loadRoster()
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


/** What the thread lists: a day line, a message or event, the visitor typing. */
private sealed interface TimelineEntry {
    val key: String

    data class Day(val day: java.time.LocalDate) : TimelineEntry {
        override val key get() = "day-$day"
    }

    data class Entry(val message: Message) : TimelineEntry {
        override val key get() = message.id
    }

    data class Typing(val name: String) : TimelineEntry {
        override val key get() = "typing"
    }
}

private fun timeline(messages: List<Message>, typing: String?, zone: ZoneId): List<TimelineEntry> = buildList {
    messages.forEachIndexed { index, message ->
        if (DeskLogic.startsDay(messages.getOrNull(index - 1), message, zone)) {
            message.createdAt?.let { add(TimelineEntry.Day(it.atZone(zone).toLocalDate())) }
        }
        add(TimelineEntry.Entry(message))
    }
    if (typing != null) add(TimelineEntry.Typing(typing))
}

@OptIn(ExperimentalMaterial3Api::class)
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

    val detail = state.detail
    val zone = remember { ZoneId.systemDefault() }
    val now = rememberNow(60_000)
    val typingFallback = stringResource(R.string.welddesk_conversation_typing_fallback)
    val typingName = room.visitorsTyping.firstOrNull()?.let { name -> name.ifBlank { typingFallback } }
    val entries = remember(detail?.messages, typingName, zone) { timeline(detail?.messages.orEmpty(), typingName, zone) }
    // Opening lands on the latest message; a new one (or the visitor typing) follows along.
    LaunchedEffect(entries.size) {
        if (entries.isNotEmpty()) listState.animateScrollToItem(entries.lastIndex)
    }

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
                            detail?.conversation?.let(DeskLogic::threadTitle)
                                ?: stringResource(if (detail == null) R.string.welddesk_conversation_title else R.string.welddesk_conversation_untitled),
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.tagged("conversation-title"),
                        )
                        detail?.conversation?.let {
                            Text(
                                DeskLogic.threadSubtitle(it),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.tagged("conversation-subtitle"),
                            )
                        }
                    }
                },
                actions = {
                    if (detail != null) {
                        AssignButton(detail.conversation, state, userId, enabled = !state.managing) { picking = true }
                        StateButton(detail.conversation, state.managing, onClick = model::toggleState)
                        Spacer(Modifier.width(Tokens.Spacing.s))
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).consumeWindowInsets(padding).imePadding().fillMaxSize()) {
            when {
                detail == null && state.error != null -> DeskLoadError(stringResource(R.string.welddesk_conversation_load_error), state.error, onRetry = model::retry)
                detail == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = MaterialTheme.colorScheme.onSurfaceVariant, strokeWidth = 2.dp)
                }
                else -> {
                    StatusStrip(detail.conversation, room, now)
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    val names = TimelineNames(
                        members = state.members,
                        visitor = DeskLogic.rowTitle(detail.conversation) ?: stringResource(R.string.welddesk_conversation_visitor),
                        someone = stringResource(R.string.welddesk_timeline_someone),
                    )
                    LazyColumn(
                        Modifier.weight(1f).fillMaxWidth().tagged("thread"),
                        state = listState,
                        contentPadding = PaddingValues(vertical = Tokens.Spacing.s),
                    ) {
                        if (entries.isEmpty()) {
                            item {
                                Text(
                                    stringResource(R.string.welddesk_conversation_empty_thread),
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                                    modifier = Modifier.fillMaxWidth().padding(vertical = 64.dp),
                                )
                            }
                        }
                        items(entries, key = { it.key }) { entry ->
                            when (entry) {
                                is TimelineEntry.Day -> DaySeparator(entry.day)
                                is TimelineEntry.Entry -> MessageRow(entry.message, names, now, zone, onOpenFailed = model::attachmentOpenFailed)
                                is TimelineEntry.Typing -> TypingBubble(entry.name)
                            }
                        }
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

/** What the platform's header shows beside the title: the SLA chip, and the visitor online. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StatusStrip(conversation: Conversation, room: RoomState, now: java.time.Instant) {
    val sla = DeskLogic.slaDisplay(conversation, now, showPaused = true, showFinished = true)
    if (sla == null && !room.visitorOnline) return
    FlowRow(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        sla?.let { SlaChip(it) }
        if (room.visitorOnline) OnlineIndicator()
    }
}

/** Assign: the assignee's avatar once someone has it, else the add-person icon; opens the picker. */
@Composable
private fun AssignButton(conversation: Conversation, state: ConversationUiState, userId: String?, enabled: Boolean, onClick: () -> Unit) {
    val assignee = conversation.assigneeId?.takeIf { it.isNotEmpty() }
    val member = assignee?.let { id -> state.members?.firstOrNull { it.userId == id } }
    val label = when (val who = DeskLogic.assigneeLabel(conversation.assigneeId, userId, state.members)) {
        DeskLogic.AssigneeLabel.Unassigned -> stringResource(R.string.welddesk_conversation_assign)
        DeskLogic.AssigneeLabel.You -> member?.name ?: stringResource(R.string.welddesk_conversation_assigned_to_you)
        DeskLogic.AssigneeLabel.Someone -> stringResource(R.string.welddesk_conversation_assign)
        is DeskLogic.AssigneeLabel.Teammate -> who.name
    }
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.semantics { contentDescription = label }.tagged("change-assignee")) {
        if (member != null) {
            InitialAvatar(member.name, url = member.picture, size = 22.dp, modifier = Modifier.tagged("assignee-avatar"))
        } else {
            Icon(Icons.Outlined.PersonAddAlt, contentDescription = null)
        }
    }
}

/** Close while open (the primary button), Reopen once closed (outline), as on the platform. */
@Composable
private fun StateButton(conversation: Conversation, busy: Boolean, onClick: () -> Unit) {
    val open = conversation.state == ConversationState.OPEN
    val padding = PaddingValues(horizontal = Tokens.Spacing.m)
    val content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit = {
        if (busy) {
            CircularProgressIndicator(Modifier.size(14.dp).padding(end = 2.dp), strokeWidth = 2.dp, color = androidx.compose.material3.LocalContentColor.current)
            Spacer(Modifier.width(6.dp))
        }
        Text(stringResource(if (open) R.string.welddesk_conversation_close else R.string.welddesk_conversation_reopen), style = MaterialTheme.typography.labelLarge)
    }
    val modifier = Modifier.height(34.dp).tagged("conversation-toggle-state")
    if (open) {
        Button(onClick = onClick, enabled = !busy, contentPadding = padding, modifier = modifier, content = content)
    } else {
        OutlinedButton(onClick = onClick, enabled = !busy, contentPadding = padding, modifier = modifier, content = content)
    }
}

/**
 * The platform's composer: a rounded box with the field on top, the files
 * under it, and a row of attach, reply or note, and send. A note tints the
 * box amber, so it never reads as a reply.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Composer(state: ConversationUiState, model: ConversationViewModel) {
    val context = LocalContext.current
    val colors = MaterialTheme.colorScheme
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
    val note = state.mode == MessageKind.NOTE
    val frame = RoundedCornerShape(20.dp)
    Box(Modifier.fillMaxWidth().background(colors.background).padding(start = Tokens.Spacing.m, end = Tokens.Spacing.m, top = Tokens.Spacing.s, bottom = Tokens.Spacing.m)) {
        Column(
            Modifier
                .fillMaxWidth()
                .clip(frame)
                .background(if (note) DeskColors.noteComposer.current() else colors.background)
                .border(BorderStroke(1.dp, if (note) DeskColors.noteBorder.current() else colors.outlineVariant), frame)
                .padding(10.dp),
        ) {
            BasicTextField(
                value = state.body,
                onValueChange = model::setBody,
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp, lineHeight = 22.sp, color = colors.onSurface),
                cursorBrush = SolidColor(colors.onSurface),
                maxLines = 8,
                modifier = Modifier.fillMaxWidth().heightIn(min = 40.dp, max = 200.dp).tagged("composer-input"),
                decorationBox = { field ->
                    Box(Modifier.padding(start = 10.dp, top = 7.dp, bottom = Tokens.Spacing.m)) {
                        if (state.body.isEmpty()) {
                            Text(
                                stringResource(if (note) R.string.welddesk_conversation_note_placeholder else R.string.welddesk_conversation_reply_placeholder),
                                fontSize = 15.sp,
                                lineHeight = 22.sp,
                                color = colors.onSurfaceVariant,
                            )
                        }
                        field()
                    }
                },
            )
            if (state.files.isNotEmpty()) {
                FlowRow(
                    Modifier.padding(start = 10.dp, end = 10.dp, bottom = Tokens.Spacing.s),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    state.files.forEach { file -> PendingFileChip(file) { model.removeFile(file.key) } }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box {
                    IconButton(onClick = { menu = true }, modifier = Modifier.size(32.dp).tagged("composer-attach")) {
                        Icon(Icons.Outlined.Add, contentDescription = stringResource(R.string.welddesk_conversation_attach), tint = colors.onSurfaceVariant, modifier = Modifier.size(18.dp))
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
                DeskToggle(stringResource(R.string.welddesk_conversation_reply), !note, "mode-reply") { model.setMode(MessageKind.MESSAGE) }
                DeskToggle(stringResource(R.string.welddesk_conversation_note), note, "mode-note") { model.setMode(MessageKind.NOTE) }
                Spacer(Modifier.weight(1f))
                SendButton(
                    canSend = state.canSend,
                    sending = state.sending,
                    label = stringResource(if (note) R.string.welddesk_conversation_add_note else R.string.welddesk_conversation_send_reply),
                    onClick = model::send,
                )
            }
        }
    }
}

/** A file on the reply: uploading (a spinner) or uploaded (a paperclip and its size), with a remove button. */
@Composable
private fun PendingFileChip(file: PendingFile, onRemove: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val remove = stringResource(R.string.welddesk_conversation_remove_attachment, file.name)
    Row(
        Modifier
            .widthIn(max = 240.dp)
            .clip(RoundedCornerShape(Tokens.Radius.medium))
            .background(colors.surfaceVariant.copy(alpha = 0.6f))
            .border(BorderStroke(1.dp, colors.outlineVariant), RoundedCornerShape(Tokens.Radius.medium))
            .padding(start = Tokens.Spacing.s, end = Tokens.Spacing.xs, top = 2.dp, bottom = 2.dp)
            .tagged("pending-attachment"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (file.uploading) {
            val uploading = stringResource(R.string.welddesk_conversation_uploading)
            CircularProgressIndicator(Modifier.size(12.dp).semantics { contentDescription = uploading }, strokeWidth = 1.5.dp, color = colors.onSurfaceVariant)
        } else {
            Icon(Icons.Outlined.AttachFile, contentDescription = null, tint = colors.onSurfaceVariant, modifier = Modifier.size(12.dp))
        }
        Text(file.name, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        file.uploaded?.size?.let(DeskLogic::formatFileSize)?.takeIf { it.isNotEmpty() }?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, maxLines = 1)
        }
        IconButton(onClick = onRemove, modifier = Modifier.size(28.dp)) {
            Icon(Icons.Outlined.Close, contentDescription = remove, tint = colors.onSurfaceVariant, modifier = Modifier.size(12.dp))
        }
    }
}

/** The platform's send button: a rounded square, solid while there is something to send, plain grey while there isn't. */
@Composable
private fun SendButton(canSend: Boolean, sending: Boolean, label: String, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val idleBackground = DayNight(Color(0xFFD1D5DB), Tokens.Palette.muted.dark).current()
    val idleContent = DayNight(Color(0xFF6B7280), Tokens.Palette.mutedForeground.dark).current()
    val active = canSend || sending
    Box(
        Modifier
            .size(32.dp)
            .clip(RoundedCornerShape(Tokens.Spacing.m))
            .background(if (active) colors.primary else idleBackground)
            .clickable(enabled = canSend, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label }
            .tagged("composer-send"),
        contentAlignment = Alignment.Center,
    ) {
        if (sending) {
            CircularProgressIndicator(Modifier.size(15.dp), strokeWidth = 2.dp, color = colors.onPrimary)
        } else {
            Icon(Icons.Filled.ArrowUpward, contentDescription = null, tint = if (active) colors.onPrimary else idleContent, modifier = Modifier.size(16.dp))
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
