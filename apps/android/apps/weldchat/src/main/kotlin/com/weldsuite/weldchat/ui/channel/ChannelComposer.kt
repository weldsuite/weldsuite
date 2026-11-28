package com.weldsuite.weldchat.ui.channel

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Mic
import org.weldsuite.ui.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.MentionCandidate
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.ReplyReference
import com.weldsuite.weldchat.media.PendingFilesBar
import com.weldsuite.weldchat.media.RecordingBar
import com.weldsuite.weldchat.ui.ChatAvatar
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import org.weldsuite.core.R as CoreR

/** The people and agents a composer offers while `@…` is typed. */
@Composable
fun MentionPicker(candidates: List<MentionCandidate>, onSelect: (MentionCandidate) -> Unit, modifier: Modifier = Modifier) {
    if (candidates.isEmpty()) return
    Surface(
        shape = RoundedCornerShape(Tokens.Radius.large),
        tonalElevation = 3.dp,
        shadowElevation = 2.dp,
        modifier = modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.m).tagged("mention-picker"),
    ) {
        LazyColumn(Modifier.heightIn(max = 216.dp)) {
            items(candidates, key = { it.userId }) { candidate ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onSelect(candidate) }
                        .padding(horizontal = Tokens.Spacing.m, vertical = Tokens.Spacing.s)
                        .tagged("mention-${candidate.userId}"),
                ) {
                    if (candidate.isAgent) AgentAvatar(candidate.agentIcon, 30.dp) else ChatAvatar(candidate.name, candidate.picture, 30.dp)
                    Column(Modifier.weight(1f)) {
                        Text(candidate.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val email = candidate.email
                        if (!candidate.isAgent && !email.isNullOrEmpty()) {
                            Text(email, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                        }
                    }
                    if (candidate.isAgent) AgentBadge()
                }
            }
        }
    }
}

/**
 * The bottom of a conversation: the mention picker, the edit and thread
 * bars, the files about to be sent, who is typing, the archived notice and
 * the input (or the recording bar).
 */
@Composable
fun ChannelComposer(
    model: ChannelModel,
    placeholder: String,
    candidates: List<MentionCandidate>,
    typing: String?,
    isArchived: Boolean,
    focusRequester: FocusRequester,
    onAttach: () -> Unit,
    onSend: () -> Unit,
    onStartRecording: () -> Unit,
    onSendVoice: () -> Unit,
    onContinueInThread: () -> Unit,
    onUnarchive: () -> Unit,
) {
    Surface(tonalElevation = 2.dp, modifier = Modifier.fillMaxWidth()) {
        Column(
            Modifier.fillMaxWidth().padding(top = Tokens.Spacing.xs, bottom = Tokens.Spacing.s),
            verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
        ) {
            if (model.mentionQuery != null && !model.isRecording) {
                MentionPicker(candidates, onSelect = { model.insertMention(it.userId) })
            }
            if (model.editing != null) EditBar(onCancel = model::cancelEdit)
            if (model.showThreadSuggestion) ThreadSuggestion(onContinueInThread, onDismiss = model::dismissThreadSuggestion)
            PendingFilesBar(model.pendingFiles, onRemove = { file -> model.pendingFiles = model.pendingFiles.filter { it.id != file.id } })
            if (typing != null) {
                Text(
                    typing,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l).tagged("typing-indicator"),
                )
            }
            if (isArchived) ArchivedBanner(onUnarchive)
            if (model.isRecording) {
                RecordingBar(
                    recorder = model.recorder,
                    sending = model.sendingVoiceDurationMs != null,
                    onCancel = model::cancelRecording,
                    onSend = onSendVoice,
                    modifier = Modifier.padding(horizontal = Tokens.Spacing.s),
                    frozenDurationMs = model.sendingVoiceDurationMs,
                )
            } else {
                InputBar(model, placeholder, focusRequester, onAttach, onSend, onStartRecording)
            }
        }
    }
}

@Composable
private fun InputBar(
    model: ChannelModel,
    placeholder: String,
    focusRequester: FocusRequester,
    onAttach: () -> Unit,
    onSend: () -> Unit,
    onStartRecording: () -> Unit,
) {
    val editing = model.editing != null
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.m),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        if (!editing) {
            RoundIcon(onClick = onAttach, tag = "composer-attach") {
                Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.weldchat_composer_attach))
            }
        }
        Surface(
            shape = RoundedCornerShape(20.dp),
            color = MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier.weight(1f),
        ) {
            Column(Modifier.padding(horizontal = Tokens.Spacing.m, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val reply = model.replyTo
                if (reply != null && !editing) ReplyHeader(model, reply)
                ComposerField(
                    value = model.input,
                    onValueChange = model::onInputChange,
                    placeholder = placeholder,
                    modifier = Modifier.focusRequester(focusRequester).tagged("composer-input"),
                )
            }
        }
        if (model.canSend || editing) {
            Surface(
                onClick = onSend,
                enabled = !model.uploading,
                shape = CircleShape,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(40.dp).tagged("composer-send"),
            ) {
                androidx.compose.foundation.layout.Box(contentAlignment = Alignment.Center) {
                    if (model.uploading) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                    } else {
                        Icon(
                            if (editing) Icons.Filled.Check else Icons.Filled.ArrowUpward,
                            contentDescription = stringResource(R.string.weldchat_composer_send),
                            tint = MaterialTheme.colorScheme.onPrimary,
                        )
                    }
                }
            }
        } else {
            RoundIcon(onClick = onStartRecording, tag = "composer-mic") {
                Icon(Icons.Filled.Mic, contentDescription = stringResource(R.string.weldchat_composer_record_voice))
            }
        }
    }
}

/** A multi-line text field with a placeholder, up to six lines tall. */
@Composable
fun ComposerField(value: TextFieldValue, onValueChange: (TextFieldValue) -> Unit, placeholder: String, modifier: Modifier = Modifier) {
    val textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        textStyle = textStyle,
        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
        maxLines = 6,
        modifier = modifier.fillMaxWidth(),
        decorationBox = { inner ->
            androidx.compose.foundation.layout.Box {
                if (value.text.isEmpty()) {
                    Text(placeholder, style = textStyle, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                inner()
            }
        },
    )
}

@Composable
private fun RoundIcon(onClick: () -> Unit, tag: String, content: @Composable () -> Unit) {
    Surface(
        onClick = onClick,
        shape = CircleShape,
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.size(40.dp).tagged(tag),
    ) {
        androidx.compose.foundation.layout.Box(contentAlignment = Alignment.Center) { content() }
    }
}

/** Who the reply goes to, whether they are pinged, and close. */
@Composable
private fun ReplyHeader(model: ChannelModel, reply: ReplyReference) {
    val brand = MaterialTheme.colorScheme.primary
    val mention = model.replyMention
    val mentionLabel = stringResource(R.string.weldchat_channel_mention_author, reply.authorName)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        Text(
            stringResource(R.string.weldchat_channel_replying_to, reply.authorName),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        IconButton(
            onClick = { model.replyMention = !mention },
            modifier = Modifier
                .size(28.dp)
                .background(if (mention) brand.copy(alpha = 0.15f) else androidx.compose.ui.graphics.Color.Transparent, CircleShape)
                .semantics { selected = mention }
                .tagged("reply-mention"),
        ) {
            Icon(
                Icons.Filled.AlternateEmail,
                contentDescription = mentionLabel,
                tint = if (mention) brand else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(16.dp),
            )
        }
        IconButton(onClick = model::cancelReply, modifier = Modifier.size(28.dp).tagged("reply-cancel")) {
            Icon(
                Icons.Filled.Cancel,
                contentDescription = stringResource(R.string.weldchat_channel_cancel_reply),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@Composable
private fun EditBar(onCancel: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        Icon(Icons.Filled.Edit, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
        Text(
            stringResource(R.string.weldchat_channel_editing_message),
            style = MaterialTheme.typography.titleSmall,
            maxLines = 1,
            modifier = Modifier.weight(1f),
        )
        IconButton(onClick = onCancel, modifier = Modifier.size(32.dp).tagged("edit-cancel")) {
            Icon(Icons.Filled.Close, contentDescription = stringResource(CoreR.string.core_common_cancel), modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun ThreadSuggestion(onCreate: () -> Unit, onDismiss: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Tokens.Spacing.m)
            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f), RoundedCornerShape(Tokens.Radius.medium))
            .padding(Tokens.Spacing.s),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        Icon(Icons.Filled.Forum, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
        Text(stringResource(R.string.weldchat_channel_thread_suggestion), style = MaterialTheme.typography.labelMedium, maxLines = 2, modifier = Modifier.weight(1f))
        Button(onClick = onCreate, modifier = Modifier.tagged("thread-suggestion-create")) {
            Text(stringResource(R.string.weldchat_channel_create_thread))
        }
        IconButton(onClick = onDismiss, modifier = Modifier.size(32.dp).tagged("thread-suggestion-dismiss")) {
            Icon(
                Icons.Filled.Close,
                contentDescription = stringResource(R.string.weldchat_channel_dismiss_thread_suggestion),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

@Composable
private fun ArchivedBanner(onUnarchive: () -> Unit) {
    Column {
        HorizontalDivider()
        Row(
            Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
        ) {
            Icon(Icons.Filled.Archive, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
            Text(
                stringResource(R.string.weldchat_channel_archived_notice),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.size(0.dp))
            TextButton(onClick = onUnarchive, modifier = Modifier.tagged("channel-unarchive")) {
                Text(stringResource(R.string.weldchat_channel_unarchive), fontWeight = FontWeight.SemiBold)
            }
        }
    }
}
