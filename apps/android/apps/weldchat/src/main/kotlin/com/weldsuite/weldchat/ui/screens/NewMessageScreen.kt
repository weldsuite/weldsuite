package com.weldsuite.weldchat.ui.screens

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.ChatAttachment
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.media.AttachmentSourceDialog
import com.weldsuite.weldchat.media.ChatUpload
import com.weldsuite.weldchat.media.PendingFile
import com.weldsuite.weldchat.media.PendingFilesBar
import com.weldsuite.weldchat.media.RecordingBar
import com.weldsuite.weldchat.media.VoiceRecorder
import com.weldsuite.weldchat.media.rememberAttachmentPicker
import com.weldsuite.weldchat.ui.ChatAvatar
import com.weldsuite.weldchat.ui.ChatNavigator
import com.weldsuite.weldchat.ui.GroupAvatar
import com.weldsuite.weldchat.ui.ListHeader
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.api.ApiException
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import org.weldsuite.core.R as CoreR

/**
 * Slack's "New message": pick any mix of channels, conversations and people
 * in "To:", write the message (with files, or as a voice message) and send
 * it. Every channel and conversation gets it; the people picked share one
 * DM (an existing one with the same people is reused). With a single
 * destination it opens after sending. Errors show in the screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewMessageScreen(env: AppEnvironment, store: ChatStore, userId: String, nav: ChatNavigator) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    var query by rememberSaveable { mutableStateOf("") }
    var recipients by remember { mutableStateOf<List<MessageRecipient>>(emptyList()) }
    var message by rememberSaveable { mutableStateOf("") }
    var pendingFiles by remember { mutableStateOf<List<PendingFile>>(emptyList()) }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<Int?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var showAttach by remember { mutableStateOf(false) }
    var micDenied by remember { mutableStateOf(false) }
    // A recorded voice message is uploading: the bar stays, frozen at its length.
    var sendingVoiceMs by remember { mutableStateOf<Long?>(null) }
    val recorder = remember { VoiceRecorder(context) }
    val toFocus = remember { FocusRequester() }
    val picker = rememberAttachmentPicker { files -> pendingFiles = pendingFiles + files }

    LaunchedEffect(Unit) {
        runCatching { toFocus.requestFocus() }
        store.loadHome()
        store.loadRoster()
        loaded = true
    }
    DisposableEffect(recorder) { onDispose { if (recorder.isRecording) recorder.cancel() } }
    BackHandler(enabled = sending || sendingVoiceMs != null) {}

    fun toggle(recipient: MessageRecipient) {
        if (sending) return
        error = null
        query = ""
        recipients = NewMessageRules.toggled(recipients, recipient)
    }

    suspend fun post(channelId: String, body: String, files: List<PendingFile>) {
        val attachments = mutableListOf<ChatAttachment>()
        for (file in files) {
            quietly { ChatUpload.upload(context, env, file, channelId) }?.let { attachments.add(it) }
        }
        if (files.isNotEmpty() && attachments.isEmpty()) throw ApiException(null, null, null)
        store.repository.send(channelId, body, attachments = attachments)
    }

    /**
     * Every channel and conversation picked gets the message; the people
     * share one DM. Files are uploaded once per destination (an upload
     * belongs to its channel). On a failure whoever already has it leaves
     * "To:", so sending again doesn't post it twice.
     */
    suspend fun deliver(body: String, files: List<PendingFile>) {
        val plan = NewMessageRules.split(recipients)
        val delivered = mutableSetOf<String>()
        val destinations = mutableListOf<Triple<String, Boolean, String?>>()
        val names = recipients.associate { it.key to it.name }
        try {
            for (conversation in plan.conversations) {
                post(conversation.id, body, files)
                delivered.add(conversation.key)
                destinations.add(Triple(conversation.id, conversation.isDm, names[conversation.key]))
            }
            if (plan.people.isNotEmpty()) {
                val dm = store.repository.createDm(plan.people, store.currentUserId)
                post(dm.id, body, files)
                recipients.filterIsInstance<MessageRecipient.Person>().forEach { delivered.add(it.key) }
                destinations.add(Triple(dm.id, true, dm.name))
            }
        } catch (failure: Exception) {
            recipients = recipients.filter { it.key !in delivered }
            throw failure
        }
        store.loadHome()
        // One destination: open it. Several: back to where you were.
        val only = destinations.singleOrNull()
        if (only != null) {
            nav.finishSheet { openConversation(only.first, only.third, if (only.second) "dm" else null) }
        } else {
            nav.finishSheet()
        }
    }

    fun send() {
        if (!NewMessageRules.canSend(recipients, message, pendingFiles.size, sending)) return
        sending = true
        error = null
        scope.launch {
            try {
                deliver(message.trim(), pendingFiles)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                error = R.string.weldchat_new_message_send_failed
                sending = false
            }
        }
    }

    fun startRecording() {
        when (recorder.start(scope)) {
            VoiceRecorder.StartResult.STARTED -> haptics.performHapticFeedback(HapticFeedbackType.LongPress)
            VoiceRecorder.StartResult.DENIED -> micDenied = true
            VoiceRecorder.StartResult.FAILED -> error = R.string.weldchat_composer_record_failed
        }
    }

    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startRecording() else micDenied = true
    }

    /** A tap-and-send by accident gives a near-silent clip: it is dropped instead. */
    fun sendVoice() {
        if (recorder.durationMs < com.weldsuite.weldchat.ChatLogic.MIN_VOICE_MESSAGE_MS) {
            recorder.cancel()
            error = R.string.weldchat_composer_voice_too_short
            return
        }
        sendingVoiceMs = recorder.durationMs
        val recording = recorder.stop()
        if (recording == null) {
            sendingVoiceMs = null
            error = R.string.weldchat_composer_voice_send_failed
            return
        }
        scope.launch {
            try {
                deliver("", listOf(recording.file))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                error = R.string.weldchat_composer_voice_send_failed
                sendingVoiceMs = null
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.weldchat_new_message_title)) },
                navigationIcon = {
                    IconButton(
                        onClick = {
                            if (recorder.isRecording) recorder.cancel()
                            nav.back()
                        },
                        enabled = !sending,
                        modifier = Modifier.tagged("new-message-cancel"),
                    ) {
                        Icon(Icons.Filled.Close, contentDescription = stringResource(CoreR.string.core_common_cancel))
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().imePadding()) {
            ToField(
                recipients = recipients,
                query = query,
                onQuery = {
                    query = it
                    error = null
                },
                onRemove = { toggle(it) },
                focus = toFocus,
            )
            HorizontalDivider()
            Choices(store, userId, query, recipients, loaded, Modifier.weight(1f)) { toggle(it) }
            if (recipients.isNotEmpty()) {
                Composer(
                    message = message,
                    onMessage = { message = it },
                    pendingFiles = pendingFiles,
                    onRemoveFile = { file -> pendingFiles = pendingFiles.filter { it.id != file.id } },
                    error = error,
                    sending = sending,
                    recorder = recorder,
                    sendingVoiceMs = sendingVoiceMs,
                    canSend = NewMessageRules.canSend(recipients, message, pendingFiles.size, sending),
                    onAttach = { showAttach = true },
                    onSend = { send() },
                    onMic = { if (recorder.hasPermission()) startRecording() else micPermission.launch(Manifest.permission.RECORD_AUDIO) },
                    onCancelRecording = { recorder.cancel() },
                    onSendVoice = { sendVoice() },
                )
            }
        }
    }

    if (showAttach) AttachmentSourceDialog(picker) { showAttach = false }
    if (micDenied) {
        AlertDialog(
            onDismissRequest = { micDenied = false },
            title = { Text(stringResource(R.string.weldchat_composer_mic_permission_title)) },
            text = { Text(stringResource(R.string.weldchat_composer_mic_permission_body)) },
            confirmButton = {
                TextButton(onClick = {
                    micDenied = false
                    runCatching {
                        context.startActivity(
                            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                }) { Text(stringResource(R.string.weldchat_composer_open_settings)) }
            },
            dismissButton = { TextButton(onClick = { micDenied = false }) { Text(stringResource(CoreR.string.core_common_cancel)) } },
        )
    }
}

/** "To:", the chips picked (tap one to take it out) and the search; backspace in an empty search takes out the last. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ToField(
    recipients: List<MessageRecipient>,
    query: String,
    onQuery: (String) -> Unit,
    onRemove: (MessageRecipient) -> Unit,
    focus: FocusRequester,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        Text(stringResource(R.string.weldchat_new_message_to), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
        FlowRow(
            Modifier.weight(1f),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            recipients.forEach { recipient ->
                val remove = stringResource(R.string.weldchat_new_message_remove_recipient, recipient.name)
                Surface(
                    onClick = { onRemove(recipient) },
                    shape = RoundedCornerShape(50),
                    color = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f),
                    modifier = Modifier.tagged("recipient-chip-${recipient.key}"),
                ) {
                    Row(
                        Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(
                            recipient.label,
                            color = MaterialTheme.colorScheme.primary,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Medium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.widthIn(max = 200.dp),
                        )
                        Icon(Icons.Filled.Close, contentDescription = remove, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(14.dp))
                    }
                }
            }
            Box(Modifier.widthIn(min = 140.dp).padding(vertical = 6.dp)) {
                if (query.isEmpty() && recipients.isEmpty()) {
                    Text(stringResource(R.string.weldchat_new_message_to_placeholder), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                BasicTextField(
                    value = query,
                    onValueChange = onQuery,
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focus)
                        .onPreviewKeyEvent { event ->
                            val last = recipients.lastOrNull()
                            if (event.type == KeyEventType.KeyDown && event.key == Key.Backspace && query.isEmpty() && last != null) {
                                onRemove(last)
                                true
                            } else {
                                false
                            }
                        }
                        .tagged("new-message-to"),
                )
            }
        }
    }
}

/** Recent, people and channels to pick, narrowed by the search (`#` channels, `@` people). */
@Composable
private fun Choices(
    store: ChatStore,
    userId: String,
    query: String,
    recipients: List<MessageRecipient>,
    loaded: Boolean,
    modifier: Modifier,
    onToggle: (MessageRecipient) -> Unit,
) {
    val recent = NewMessageRules.recent(store.channels, store.dms)
    val term = NewMessageRules.term(query)
    val people = NewMessageRules.people(store.roster, userId, query, recent)
    val channels = NewMessageRules.channels(store.channels, query, recent)
    val selected = recipients.map { it.key }.toSet()
    LazyColumn(modifier.fillMaxWidth().tagged("new-message-choices")) {
        if (term.isEmpty() && !loaded && recent.isEmpty()) {
            item("loading") {
                Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.xl), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            }
        }
        if (term.isEmpty() && recent.isNotEmpty()) {
            item("recent-header") { ListHeader(stringResource(R.string.weldchat_new_message_recent)) }
            items(recent, key = { "recent-${it.key}" }) { RecipientRow(it, it.key in selected) { onToggle(it) } }
        }
        if (people.isNotEmpty()) {
            item("people-header") { ListHeader(stringResource(R.string.weldchat_new_message_people)) }
            items(people, key = { "people-${it.key}" }) { RecipientRow(it, it.key in selected) { onToggle(it) } }
        }
        if (channels.isNotEmpty()) {
            item("channels-header") { ListHeader(stringResource(R.string.weldchat_new_message_channels)) }
            items(channels, key = { "channels-${it.key}" }) { RecipientRow(it, it.key in selected) { onToggle(it) } }
        }
        if (term.isNotEmpty() && people.isEmpty() && channels.isEmpty()) {
            item("none") { QuietLine(stringResource(R.string.weldchat_new_message_no_results, query.trim())) }
        }
    }
}

@Composable
private fun RecipientRow(recipient: MessageRecipient, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .tagged("recipient-${recipient.key}")
            .padding(horizontal = Tokens.Spacing.l, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        when (recipient) {
            is MessageRecipient.Channel -> Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) {
                Icon(
                    if (recipient.isPrivate) Icons.Filled.Lock else Icons.Filled.Tag,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            is MessageRecipient.Dm -> GroupAvatar(recipient.people, 32.dp)
            is MessageRecipient.Person -> ChatAvatar(recipient.name, recipient.picture, 32.dp)
        }
        Text(recipient.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        SelectionMark(selected)
    }
}

/** The message: files, the text, send, or a voice message. */
@Composable
private fun Composer(
    message: String,
    onMessage: (String) -> Unit,
    pendingFiles: List<PendingFile>,
    onRemoveFile: (PendingFile) -> Unit,
    error: Int?,
    sending: Boolean,
    recorder: VoiceRecorder,
    sendingVoiceMs: Long?,
    canSend: Boolean,
    onAttach: () -> Unit,
    onSend: () -> Unit,
    onMic: () -> Unit,
    onCancelRecording: () -> Unit,
    onSendVoice: () -> Unit,
) {
    Surface(tonalElevation = 2.dp) {
        Column(Modifier.fillMaxWidth().padding(vertical = Tokens.Spacing.s), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            if (error != null) InlineError(stringResource(error), Modifier.padding(horizontal = Tokens.Spacing.l))
            PendingFilesBar(pendingFiles, onRemoveFile)
            if (recorder.isRecording || sendingVoiceMs != null) {
                RecordingBar(
                    recorder = recorder,
                    sending = sendingVoiceMs != null,
                    onCancel = onCancelRecording,
                    onSend = onSendVoice,
                    frozenDurationMs = sendingVoiceMs,
                )
            } else {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.m),
                    verticalAlignment = Alignment.Bottom,
                    horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                ) {
                    RoundButton(
                        icon = Icons.Filled.Add,
                        label = stringResource(R.string.weldchat_composer_attach),
                        enabled = !sending,
                        tag = "new-message-attach",
                        onClick = onAttach,
                    )
                    TextField(
                        value = message,
                        onValueChange = onMessage,
                        placeholder = { Text(stringResource(R.string.weldchat_new_message_message_placeholder)) },
                        maxLines = 6,
                        shape = RoundedCornerShape(20.dp),
                        colors = TextFieldDefaults.colors(
                            focusedIndicatorColor = Color.Transparent,
                            unfocusedIndicatorColor = Color.Transparent,
                            disabledIndicatorColor = Color.Transparent,
                        ),
                        modifier = Modifier.weight(1f).tagged("new-message-input"),
                    )
                    if (canSend || sending) {
                        Surface(
                            onClick = onSend,
                            enabled = canSend,
                            shape = CircleShape,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(40.dp).tagged("new-message-send"),
                        ) {
                            Box(contentAlignment = Alignment.Center) {
                                if (sending) {
                                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                                } else {
                                    Icon(Icons.Filled.ArrowUpward, contentDescription = stringResource(R.string.weldchat_composer_send), tint = MaterialTheme.colorScheme.onPrimary)
                                }
                            }
                        }
                    } else {
                        RoundButton(
                            icon = Icons.Filled.Mic,
                            label = stringResource(R.string.weldchat_composer_record_voice),
                            enabled = true,
                            tag = "new-message-mic",
                            onClick = onMic,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun RoundButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, enabled: Boolean, tag: String, onClick: () -> Unit) {
    Box(
        Modifier
            .size(40.dp)
            .background(MaterialTheme.colorScheme.surfaceVariant, CircleShape)
            .clickable(enabled = enabled, onClickLabel = label, onClick = onClick)
            .tagged(tag),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = label)
    }
}
