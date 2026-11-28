package com.weldsuite.weldchat.ui.channel

import android.text.format.Formatter
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.SubdirectoryArrowRight
import androidx.compose.material.icons.filled.Videocam
import org.weldsuite.ui.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.weldsuite.weldchat.AgentVisuals
import com.weldsuite.weldchat.CallLog
import com.weldsuite.weldchat.CallLogEntry
import com.weldsuite.weldchat.ChatAttachment
import com.weldsuite.weldchat.ChatDates
import com.weldsuite.weldchat.ChatLogic
import com.weldsuite.weldchat.ChatMessage
import com.weldsuite.weldchat.MentionText
import com.weldsuite.weldchat.MessageBlock
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.ReplyReference
import com.weldsuite.weldchat.media.AudioPlayerRow
import com.weldsuite.weldchat.media.openAttachment
import com.weldsuite.weldchat.text
import com.weldsuite.weldchat.ui.ChatAvatar
import com.weldsuite.weldchat.ui.MentionColor
import com.weldsuite.weldchat.ui.messageText
import kotlinx.coroutines.launch
import org.weldsuite.core.WeldDate
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.Instant
import kotlin.math.roundToInt

/** What a message row can do, handed down from the screen. */
data class MessageRowActions(
    val openActions: (ChatMessage) -> Unit = {},
    val reply: (ChatMessage) -> Unit = {},
    val toggleReaction: (ChatMessage, String) -> Unit = { _, _ -> },
    val openImage: (String) -> Unit = {},
    val openProfile: (String) -> Unit = {},
    val openThread: (ChatMessage) -> Unit = {},
    val jumpTo: (String) -> Unit = {},
)

/** The tint of a message being replied to, or jumped to. */
private val HighlightColor = MentionColor.copy(alpha = 0.14f)

/** How far a message is dragged right before letting go replies to it. */
private val ReplyThreshold = 60.dp

/**
 * One message: the reply quote, the avatar and name (unless it continues
 * the previous one), the text with mentions and links, attachments, an
 * agent's visuals, reactions and the thread link. Hold it for its actions,
 * drag it right to reply ([interactive] off: neither, as in a thread).
 */
@Composable
fun MessageRow(
    message: ChatMessage,
    compact: Boolean,
    names: Map<String, String>,
    selfId: String,
    actions: MessageRowActions,
    modifier: Modifier = Modifier,
    highlighted: Boolean = false,
    interactive: Boolean = true,
) {
    val haptics = LocalHapticFeedback.current
    val density = LocalDensity.current
    val threshold = with(density) { ReplyThreshold.toPx() }
    val drag = remember(message.id) { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val canAct = interactive && !message.pending
    val actionsLabel = stringResource(R.string.weldchat_common_more)

    Box(
        modifier
            .fillMaxWidth()
            .tagged("message-${message.id}"),
    ) {
        if (drag.value > 10f) {
            Icon(
                Icons.AutoMirrored.Filled.Reply,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .align(Alignment.CenterStart)
                    .padding(start = 12.dp)
                    .alpha((drag.value / threshold).coerceIn(0f, 1f)),
            )
        }
        Column(
            Modifier
                .fillMaxWidth()
                .offset { IntOffset(drag.value.roundToInt(), 0) }
                .background(if (highlighted) HighlightColor else Color.Transparent)
                .then(
                    if (canAct) {
                        Modifier
                            .pointerInputLongPress(message.id) {
                                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                actions.openActions(message)
                            }
                            .pointerInputSwipeToReply(
                                key = message.id,
                                onDrag = { amount ->
                                    val before = drag.value
                                    val next = (before + amount).coerceIn(0f, threshold * 1.5f)
                                    if (before < threshold && next >= threshold) haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                    scope.launch { drag.snapTo(next) }
                                },
                                onEnd = {
                                    if (drag.value >= threshold) {
                                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                        actions.reply(message)
                                    }
                                    scope.launch { drag.animateTo(0f, spring()) }
                                },
                            )
                            .semantics {
                                onLongClick(label = actionsLabel) {
                                    actions.openActions(message)
                                    true
                                }
                            }
                    } else {
                        Modifier
                    },
                )
                .padding(start = Tokens.Spacing.l, end = Tokens.Spacing.l, top = if (compact) 2.dp else Tokens.Spacing.s, bottom = 2.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            val reply = message.replyTo
            if (!compact && reply != null) {
                ReplyQuote(reply, names, Modifier.padding(start = 46.dp)) { actions.jumpTo(reply.messageId) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                if (compact) {
                    Spacer(Modifier.width(38.dp))
                } else {
                    val canOpen = !message.isAgent && message.authorId.isNotEmpty() && interactive
                    Box(Modifier.clip(CircleShape).then(if (canOpen) Modifier.clickable { actions.openProfile(message.authorId) } else Modifier)) {
                        MessageAvatar(message)
                    }
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (!compact) MessageHeader(message)
                    MessageExtras(message, names, selfId, actions)
                    if (message.threadReplyCount > 0) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                            modifier = Modifier
                                .clip(RoundedCornerShape(Tokens.Radius.small))
                                .clickable { actions.openThread(message) }
                                .padding(vertical = 2.dp)
                                .tagged("thread-link-${message.id}"),
                        ) {
                            Icon(Icons.Filled.Forum, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(14.dp))
                            Text(
                                pluralStringResource(R.plurals.weldchat_channel_reply_count, message.threadReplyCount, message.threadReplyCount),
                                style = MaterialTheme.typography.labelMedium,
                                fontWeight = FontWeight.SemiBold,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** The author, an agent's badge, the time, and a spinner while it sends. */
@Composable
private fun MessageHeader(message: ChatMessage) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            message.authorName,
            style = MaterialTheme.typography.titleSmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (message.isAgent) AgentBadge()
        Text(ChatDates.time(message.instant), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (message.pending) CircularProgressIndicator(Modifier.size(10.dp), strokeWidth = 1.5.dp)
    }
}

/** "Agent", next to an agent's name. */
@Composable
fun AgentBadge() {
    Text(
        stringResource(R.string.weldchat_channel_agent_badge),
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.Bold,
        modifier = Modifier
            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.15f), RoundedCornerShape(3.dp))
            .padding(horizontal = 4.dp),
    )
}

/** The text, the edited mark, an agent's visuals, attachments and reactions. */
@Composable
private fun MessageExtras(message: ChatMessage, names: Map<String, String>, selfId: String, actions: MessageRowActions) {
    val inline = remember(message.content) { MentionText.fileTokenIds(message.content).toSet() }
    val gallery = message.attachments.filter { it.id !in inline }
    if (message.content.isNotEmpty()) MessageBody(message, names, actions.openImage)
    if (message.editedAt != null) {
        Text(stringResource(R.string.weldchat_channel_edited), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    if (message.isAgent) {
        message.visuals.forEach { visual ->
            Text(
                AgentVisuals.line(visual).text(),
                style = MaterialTheme.typography.bodySmall,
                fontStyle = FontStyle.Italic,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    gallery.forEach { attachment -> AttachmentView(attachment, actions.openImage) }
    val reactions = ChatLogic.reactionEntries(message.reactions)
    if (reactions.isNotEmpty()) ReactionsBar(reactions, selfId) { emoji -> actions.toggleReaction(message, emoji) }
}

/** The body split at its inline files: text with mentions and links, the files where they were placed. */
@Composable
fun MessageBody(message: ChatMessage, names: Map<String, String>, openImage: (String) -> Unit) {
    val byId = remember(message.attachments) { message.attachments.associateBy { it.id } }
    val blocks = remember(message.content, byId) { MentionText.blocks(message.content, byId.keys) }
    val linkColor = MaterialTheme.colorScheme.primary
    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs)) {
        blocks.forEach { block ->
            when (block) {
                is MessageBlock.Text -> Text(messageText(block.text, names, linkColor), style = MaterialTheme.typography.bodyLarge)
                is MessageBlock.File -> byId[block.id]?.let { AttachmentView(it, openImage) }
            }
        }
    }
}

@Composable
fun MessageAvatar(message: ChatMessage, size: androidx.compose.ui.unit.Dp = 38.dp) {
    if (message.isAgent) {
        AgentAvatar(message.authorAvatar, size)
    } else {
        ChatAvatar(message.authorName, message.authorAvatar, size)
    }
}

/** An agent: its emoji icon, or sparkles, on the brand colour. */
@Composable
fun AgentAvatar(icon: String?, size: androidx.compose.ui.unit.Dp) {
    Box(
        Modifier
            .size(size)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.primary),
        contentAlignment = Alignment.Center,
    ) {
        if (!icon.isNullOrEmpty()) {
            Text(icon, fontSize = (size.value * 0.45f).sp)
        } else {
            Icon(Icons.Filled.AutoAwesome, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(size * 0.5f))
        }
    }
}

/** An inline reply's quote; a tap jumps to the original. */
@Composable
fun ReplyQuote(reply: ReplyReference, names: Map<String, String>, modifier: Modifier = Modifier, onJump: () -> Unit) {
    Row(
        modifier
            .clip(RoundedCornerShape(Tokens.Radius.small))
            .clickable(onClick = onJump)
            .padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(Icons.Filled.SubdirectoryArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
        ChatAvatar(reply.authorName, reply.authorAvatar, 16.dp)
        Text(reply.authorName, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, maxLines = 1)
        Text(
            ChatLogic.replyQuoteText(reply, names).text(),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** An attachment: a photo (tap for the viewer), a voice message, or a file that opens. */
@Composable
fun AttachmentView(attachment: ChatAttachment, openImage: (String) -> Unit) {
    val context = LocalContext.current
    when {
        attachment.isImage -> AsyncImage(
            model = attachment.url,
            contentDescription = attachment.fileName,
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .size(width = 220.dp, height = 160.dp)
                .clip(RoundedCornerShape(Tokens.Radius.medium))
                .background(MaterialTheme.colorScheme.surfaceVariant)
                .clickable { openImage(attachment.url) },
        )
        attachment.isAudio -> AudioPlayerRow(attachment.url)
        else -> Surface(
            onClick = { openAttachment(context, attachment) },
            shape = RoundedCornerShape(Tokens.Radius.medium),
            color = MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier.widthIn(max = 280.dp),
        ) {
            Row(
                Modifier.padding(Tokens.Spacing.s),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
            ) {
                Icon(Icons.AutoMirrored.Filled.InsertDriveFile, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Column {
                    Text(attachment.fileName, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        Formatter.formatShortFileSize(context, attachment.fileSize.toLong()),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

/** The reactions under a message; a tap adds yours or takes it back. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ReactionsBar(reactions: List<Pair<String, List<String>>>, selfId: String, onToggle: (String) -> Unit) {
    val haptics = LocalHapticFeedback.current
    val brand = MaterialTheme.colorScheme.primary
    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        reactions.forEach { (emoji, users) ->
            val mine = selfId in users
            Surface(
                onClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    onToggle(emoji)
                },
                shape = RoundedCornerShape(50),
                color = if (mine) brand.copy(alpha = 0.18f) else MaterialTheme.colorScheme.surfaceVariant,
                border = if (mine) androidx.compose.foundation.BorderStroke(1.dp, brand) else null,
            ) {
                Row(
                    Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Text(emoji)
                    Text(users.size.toString(), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

/**
 * A call in the conversation, one card: how it went, how long and when, the
 * caller, or Join while it runs.
 */
@Composable
fun CallLogCard(entry: CallLogEntry, ongoing: Boolean, joinable: Boolean, createdAt: String, onJoin: () -> Unit) {
    val missed = entry.outcome == CallLogEntry.Outcome.MISSED
    val title = when {
        ongoing -> R.string.weldchat_channel_call_ongoing
        missed -> R.string.weldchat_channel_missed_call
        entry.outcome == CallLogEntry.Outcome.ENDED -> R.string.weldchat_channel_call_ended
        else -> R.string.weldchat_channel_call_started
    }
    val whenText = WeldDate.parse(createdAt)?.let { WeldDate.dateTime(it) }.orEmpty()
    val lasted = CallLog.lasted(entry.duration)?.text()
    val danger = Tokens.Status.danger.current()
    Surface(
        shape = RoundedCornerShape(Tokens.Radius.large),
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.xs),
    ) {
        Row(
            Modifier.padding(Tokens.Spacing.m),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        ) {
            Box(
                Modifier.size(36.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surface),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    when {
                        missed -> Icons.Filled.CallEnd
                        entry.isVideo -> Icons.Filled.Videocam
                        else -> Icons.Filled.Call
                    },
                    contentDescription = null,
                    tint = when {
                        missed -> danger
                        ongoing -> MaterialTheme.colorScheme.primary
                        else -> MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
            }
            Column(Modifier.weight(1f)) {
                Text(stringResource(title), style = MaterialTheme.typography.titleSmall, maxLines = 1)
                Text(
                    if (lasted != null) stringResource(R.string.weldchat_channel_call_lasted, lasted, whenText) else whenText,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
            if (joinable) {
                Button(onClick = onJoin) { Text(stringResource(R.string.weldchat_channel_join_call)) }
            } else {
                ChatAvatar(entry.callerName, entry.callerAvatar, 28.dp)
            }
        }
    }
}

/** "Today", "Yesterday", the weekday or the date, between days. */
@Composable
fun DateSeparator(instant: Instant) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        HorizontalDivider(Modifier.weight(1f))
        Text(
            ChatDates.dayLabel(instant).text(),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        HorizontalDivider(Modifier.weight(1f))
    }
}

/** A server notice in the conversation ("Ann pinned a message"). */
@Composable
fun SystemMessageRow(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.xl, vertical = Tokens.Spacing.s),
    )
}

/** A spinner row, for the page being loaded. */
@Composable
fun LoadingRow(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(56.dp), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
    }
}

private fun Modifier.pointerInputLongPress(key: Any, onLongPress: () -> Unit): Modifier =
    pointerInput(key) { detectTapGestures(onLongPress = { onLongPress() }) }

/** A horizontal drag moves the row (the caller keeps it at 0 or right of it); letting go settles it. */
private fun Modifier.pointerInputSwipeToReply(key: Any, onDrag: (Float) -> Unit, onEnd: () -> Unit): Modifier =
    pointerInput(key) {
        detectHorizontalDragGestures(onDragEnd = onEnd, onDragCancel = onEnd) { change, amount ->
            change.consume()
            onDrag(amount)
        }
    }
