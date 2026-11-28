package com.weldsuite.weldchat.ui.channel

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Forum
import org.weldsuite.ui.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.weldsuite.weldchat.MentionCandidate
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.ReplyReference
import com.weldsuite.weldchat.media.PendingFilesBar
import com.weldsuite.weldchat.media.RecordingBar
import com.weldsuite.weldchat.ui.ChatAvatar
import org.weldsuite.ui.DayNight
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import org.weldsuite.core.R as CoreR

/**
 * The platform's composer (`@weldsuite/ui` `composer`): a `rounded-[20px]`
 * box with a `gray-200` border holding the notices, the field and a row of
 * actions that ends in the send button.
 */
private object ComposerColors {
    val border = DayNight(Color(0xFFE5E7EB), Tokens.Palette.border.dark)
    /** A notice above the field: `bg-gray-100` (`secondary/60` dark). */
    val notice = DayNight(Color(0xFFF3F4F6), Tokens.Palette.secondary.dark.copy(alpha = 0.6f))
    /** Send with nothing to send: `bg-gray-300 text-gray-500` (`muted` dark). */
    val sendIdle = DayNight(Color(0xFFD1D5DB), Tokens.Palette.muted.dark)
    val sendIdleText = DayNight(Color(0xFF6B7280), Tokens.Palette.mutedForeground.dark)
    /** The action icons: `text-gray-500` (`muted-foreground` dark). */
    val icon = DayNight(Color(0xFF6B7280), Tokens.Palette.mutedForeground.dark)
}

/** The people and agents a composer offers while `@…` is typed. */
@Composable
fun MentionPicker(candidates: List<MentionCandidate>, onSelect: (MentionCandidate) -> Unit, modifier: Modifier = Modifier) {
    if (candidates.isEmpty()) return
    Surface(
        shape = RoundedCornerShape(Tokens.Radius.xlarge),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        shadowElevation = 4.dp,
        modifier = modifier.fillMaxWidth().tagged("mention-picker"),
    ) {
        LazyColumn(Modifier.heightIn(max = 216.dp).padding(vertical = 4.dp)) {
            items(candidates, key = { it.userId }) { candidate ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onSelect(candidate) }
                        .padding(horizontal = Tokens.Spacing.m, vertical = Tokens.Spacing.s)
                        .tagged("mention-${candidate.userId}"),
                ) {
                    if (candidate.isAgent) AgentAvatar(candidate.agentIcon, 24.dp) else ChatAvatar(candidate.name, candidate.picture, 24.dp)
                    Text(candidate.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val email = candidate.email
                    if (!candidate.isAgent && !email.isNullOrEmpty()) {
                        Text(email, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    } else {
                        Spacer(Modifier.weight(1f))
                    }
                    if (candidate.isAgent) AgentBadge()
                }
            }
        }
    }
}

/**
 * The bottom of a conversation: the mention picker, who is typing, the
 * archived notice, and the composer box (the edit, thread and reply
 * notices, the files about to be sent, the field, and attach, mention,
 * record and send), or the recording bar.
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
    val editing = model.editing != null
    Column(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background).padding(start = Tokens.Spacing.s, end = Tokens.Spacing.s, bottom = Tokens.Spacing.s),
        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs),
    ) {
        if (model.mentionQuery != null && !model.isRecording) {
            MentionPicker(candidates, onSelect = { model.insertMention(it.userId) })
        }
        if (typing != null) {
            Text(
                typing,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.m).tagged("typing-indicator"),
            )
        }
        if (isArchived) ArchivedBanner(onUnarchive)
        if (model.isRecording) {
            RecordingBar(
                recorder = model.recorder,
                sending = model.sendingVoiceDurationMs != null,
                onCancel = model::cancelRecording,
                onSend = onSendVoice,
                frozenDurationMs = model.sendingVoiceDurationMs,
            )
        } else {
            ComposerFrame {
                if (editing) {
                    ComposerNotice(Icons.Outlined.Edit, onDismiss = model::cancelEdit, dismissLabel = stringResource(CoreR.string.core_common_cancel), dismissTag = "edit-cancel") {
                        Text(stringResource(R.string.weldchat_channel_editing_message), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                if (model.showThreadSuggestion) {
                    ComposerNotice(
                        Icons.Outlined.Forum,
                        onDismiss = model::dismissThreadSuggestion,
                        dismissLabel = stringResource(R.string.weldchat_channel_dismiss_thread_suggestion),
                        dismissTag = "thread-suggestion-dismiss",
                        actions = {
                            Button(
                                onClick = onContinueInThread,
                                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 0.dp),
                                modifier = Modifier.heightIn(min = 28.dp).tagged("thread-suggestion-create"),
                            ) {
                                Text(stringResource(R.string.weldchat_channel_create_thread), fontSize = 12.sp)
                            }
                        },
                    ) {
                        Text(stringResource(R.string.weldchat_channel_thread_suggestion), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
                val reply = model.replyTo
                if (reply != null && !editing) ReplyNotice(model, reply)
                PendingFilesBar(
                    model.pendingFiles,
                    onRemove = { file -> model.pendingFiles = model.pendingFiles.filter { it.id != file.id } },
                    modifier = Modifier.padding(bottom = Tokens.Spacing.xs),
                )
                ComposerField(
                    value = model.input,
                    onValueChange = model::onInputChange,
                    placeholder = placeholder,
                    modifier = Modifier.padding(start = 10.dp, end = 4.dp, top = 6.dp, bottom = 10.dp).focusRequester(focusRequester).tagged("composer-input"),
                )
                ComposerActions(
                    send = {
                        ComposerSendButton(
                            canSend = (model.canSend || editing) && !model.uploading,
                            sending = model.uploading,
                            tag = "composer-send",
                            onClick = onSend,
                        )
                    },
                ) {
                    if (!editing) {
                        ComposerIconButton(Icons.Filled.Add, stringResource(R.string.weldchat_composer_attach), "composer-attach", onAttach)
                    }
                    ComposerIconButton(Icons.Filled.AlternateEmail, stringResource(R.string.weldchat_composer_mention_someone), "composer-mention") {
                        model.onInputChange(withMentionSign(model.input))
                        runCatching { focusRequester.requestFocus() }
                    }
                    if (!editing) {
                        ComposerIconButton(Icons.Filled.Mic, stringResource(R.string.weldchat_composer_record_voice), "composer-mic", onStartRecording)
                    }
                }
            }
        }
    }
}

/** The field with "@" typed at the cursor (replacing a selection), as the platform's mention button does. */
private fun withMentionSign(value: TextFieldValue): TextFieldValue {
    val start = value.selection.min.coerceIn(0, value.text.length)
    val end = value.selection.max.coerceIn(start, value.text.length)
    val before = value.text.substring(0, start)
    val sign = if (before.isEmpty() || before.last().isWhitespace()) "@" else " @"
    val text = before + sign + value.text.substring(end)
    return TextFieldValue(text, TextRange(start + sign.length))
}

/** The composer's box: `rounded-[20px]`, bordered, on the background, 10dp inside. */
@Composable
fun ComposerFrame(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(20.dp)
    Column(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(MaterialTheme.colorScheme.background)
            .border(1.dp, ComposerColors.border.current(), shape)
            .padding(10.dp)
            .tagged("composer"),
        content = content,
    )
}

/** The row under the field: actions at the start, send at the end. */
@Composable
fun ComposerActions(send: @Composable () -> Unit, actions: @Composable RowScope.() -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        actions()
        Spacer(Modifier.weight(1f))
        send()
    }
}

/** An action in the composer's row: a grey icon in a 36dp `rounded-lg` target. */
@Composable
fun ComposerIconButton(icon: ImageVector, label: String, tag: String, onClick: () -> Unit) {
    Box(
        Modifier
            .size(36.dp)
            .clip(RoundedCornerShape(Tokens.Radius.medium))
            .clickable(onClick = onClick)
            .semantics { contentDescription = label }
            .tagged(tag),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = ComposerColors.icon.current(), modifier = Modifier.size(20.dp))
    }
}

/** Send: a `rounded-[12px]` square, the primary colour while there is something to send, plain grey while there isn't. */
@Composable
fun ComposerSendButton(canSend: Boolean, sending: Boolean, tag: String, onClick: () -> Unit) {
    val background = if (canSend) MaterialTheme.colorScheme.primary else ComposerColors.sendIdle.current()
    val foreground = if (canSend) MaterialTheme.colorScheme.onPrimary else ComposerColors.sendIdleText.current()
    val label = stringResource(R.string.weldchat_composer_send)
    Box(
        Modifier
            .size(34.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(background)
            .clickable(enabled = canSend && !sending, onClick = onClick)
            .semantics { contentDescription = label }
            .tagged(tag),
        contentAlignment = Alignment.Center,
    ) {
        if (sending) {
            CircularProgressIndicator(Modifier.size(15.dp), strokeWidth = 2.dp, color = foreground)
        } else {
            Icon(Icons.Filled.ArrowUpward, contentDescription = null, tint = foreground, modifier = Modifier.size(17.dp))
        }
    }
}

/**
 * A strip above the field about the next message (what it replies to, that
 * it edits one, a suggestion): `rounded-[10px]` on `gray-100`, 13sp, a grey
 * icon, and a close button.
 */
@Composable
fun ComposerNotice(
    icon: ImageVector,
    onDismiss: (() -> Unit)?,
    dismissLabel: String,
    dismissTag: String,
    actions: @Composable RowScope.() -> Unit = {},
    content: @Composable RowScope.() -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 4.dp)
            .heightIn(min = 36.dp)
            .background(ComposerColors.notice.current(), RoundedCornerShape(10.dp))
            .padding(start = Tokens.Spacing.m, end = 4.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
        androidx.compose.runtime.CompositionLocalProvider(
            androidx.compose.material3.LocalTextStyle provides MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 20.sp, color = MaterialTheme.colorScheme.onSurface),
        ) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) { content() }
            actions()
        }
        if (onDismiss != null) {
            IconButton(onClick = onDismiss, modifier = Modifier.size(32.dp).tagged(dismissTag)) {
                Icon(Icons.Filled.Close, contentDescription = dismissLabel, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
            }
        }
    }
}

/** A multi-line text field with a placeholder (15sp, as the platform's), up to six lines tall. */
@Composable
fun ComposerField(value: TextFieldValue, onValueChange: (TextFieldValue) -> Unit, placeholder: String, modifier: Modifier = Modifier) {
    val textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp, lineHeight = 22.sp, color = MaterialTheme.colorScheme.onSurface)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        textStyle = textStyle,
        cursorBrush = SolidColor(MaterialTheme.colorScheme.onSurface),
        maxLines = 6,
        modifier = modifier.fillMaxWidth(),
        decorationBox = { inner ->
            Box {
                if (value.text.isEmpty()) {
                    Text(placeholder, style = textStyle, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                inner()
            }
        },
    )
}

/** Who the reply goes to, whether they are pinged, and close. */
@Composable
private fun ReplyNotice(model: ChannelModel, reply: ReplyReference) {
    val mention = model.replyMention
    val mentionLabel = stringResource(R.string.weldchat_channel_mention_author, reply.authorName)
    ComposerNotice(
        Icons.AutoMirrored.Filled.Reply,
        onDismiss = model::cancelReply,
        dismissLabel = stringResource(R.string.weldchat_channel_cancel_reply),
        dismissTag = "reply-cancel",
        actions = {
            IconButton(
                onClick = { model.replyMention = !mention },
                modifier = Modifier
                    .size(32.dp)
                    .background(if (mention) MaterialTheme.colorScheme.background else Color.Transparent, RoundedCornerShape(Tokens.Radius.small))
                    .semantics { selected = mention }
                    .tagged("reply-mention"),
            ) {
                Icon(
                    Icons.Filled.AlternateEmail,
                    contentDescription = mentionLabel,
                    tint = if (mention) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(16.dp),
                )
            }
        },
    ) {
        Text(stringResource(R.string.weldchat_channel_replying_to, reply.authorName), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun ArchivedBanner(onUnarchive: () -> Unit) {
    Column {
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Row(
            Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.s),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
        ) {
            Icon(Icons.Filled.Archive, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
            Text(
                stringResource(R.string.weldchat_channel_archived_notice),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onUnarchive, modifier = Modifier.tagged("channel-unarchive")) {
                Text(stringResource(R.string.weldchat_channel_unarchive), fontWeight = FontWeight.SemiBold)
            }
        }
    }
}
