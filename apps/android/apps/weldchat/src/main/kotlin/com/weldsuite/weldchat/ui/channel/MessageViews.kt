package com.weldsuite.weldchat.ui.channel

import android.net.Uri
import android.text.format.Formatter
import android.util.Log
import com.weldsuite.weldchat.BuildConfig
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallMade
import androidx.compose.material.icons.automirrored.filled.CallMissed
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
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
import com.weldsuite.weldchat.ui.AvatarShape
import com.weldsuite.weldchat.ui.ChatAvatar
import com.weldsuite.weldchat.ui.ChatColors
import com.weldsuite.weldchat.ui.messageText
import kotlinx.coroutines.launch
import org.weldsuite.core.WeldDate
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.Instant
import kotlin.math.min
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

/** How far a message is dragged right before letting go replies to it. */
private val ReplyThreshold = 60.dp

/** The platform's message avatar (`h-7 w-7`, a little larger on a phone). */
val MessageAvatarSize = 32.dp

/** Space between the avatar and the message. */
private val AvatarGap = 10.dp

/** The row's side padding. */
private val RowPadding = Tokens.Spacing.m

/**
 * One message as the platform draws it (Slack-style rows, no bubbles): the
 * line to what it replies to, the avatar and the name with the time
 * (unless it continues the previous one), the text with mentions and links,
 * attachments, an agent's visuals, reactions and "N replies". A message
 * that mentions you has a yellow wash and bar. Hold it for its actions,
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
    val mentioned = remember(message.content, selfId) { ChatLogic.mentionsUser(message.content, selfId) }
    val background = when {
        highlighted -> ChatColors.flash
        mentioned -> ChatColors.mentionedRow.current()
        else -> Color.Transparent
    }
    val bar = if (mentioned) ChatColors.mentionedBar.current() else Color.Transparent

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
                .background(background)
                .drawBehind { drawRect(bar, size = size.copy(width = 2.dp.toPx())) }
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
                .padding(start = RowPadding, end = RowPadding, top = if (compact) 2.dp else 14.dp, bottom = 2.dp),
        ) {
            val reply = message.replyTo
            if (!compact && reply != null) {
                ReplyQuote(reply, names) { actions.jumpTo(reply.messageId) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(AvatarGap)) {
                if (compact) {
                    Spacer(Modifier.width(MessageAvatarSize))
                } else {
                    val canOpen = !message.isAgent && message.authorId.isNotEmpty() && interactive
                    Box(Modifier.padding(top = 2.dp).clip(AvatarShape).then(if (canOpen) Modifier.clickable { actions.openProfile(message.authorId) } else Modifier)) {
                        MessageAvatar(message)
                    }
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    if (!compact) MessageHeader(message)
                    MessageExtras(message, names, selfId, actions, showEdited = compact)
                    if (message.threadReplyCount > 0) ThreadSummary(message) { actions.openThread(message) }
                }
            }
        }
    }
}

/** The author, an agent's badge, the time, "(edited)", and a spinner while it sends. */
@Composable
private fun MessageHeader(message: ChatMessage) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        Text(
            message.authorName,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (message.isAgent) AgentBadge()
        Text(ChatDates.time(message.instant), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (message.editedAt != null) {
            Text(stringResource(R.string.weldchat_channel_edited), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (message.pending) CircularProgressIndicator(Modifier.size(10.dp), strokeWidth = 1.5.dp)
    }
}

/** "Agent", next to an agent's name: the platform's small secondary badge. */
@Composable
fun AgentBadge() {
    Text(
        stringResource(R.string.weldchat_channel_agent_badge),
        fontSize = 10.sp,
        lineHeight = 14.sp,
        color = MaterialTheme.colorScheme.onSecondaryContainer,
        modifier = Modifier
            .background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(Tokens.Radius.small))
            .padding(horizontal = 4.dp, vertical = 1.dp),
    )
}

/** The text, an agent's visuals, attachments and reactions; "(edited)" here when the row has no header. */
@Composable
private fun MessageExtras(message: ChatMessage, names: Map<String, String>, selfId: String, actions: MessageRowActions, showEdited: Boolean) {
    val inline = remember(message.content) { MentionText.fileTokenIds(message.content).toSet() }
    val gallery = message.attachments.filter { it.id !in inline }
    if (message.content.isNotEmpty()) MessageBody(message, names, actions.openImage)
    if (showEdited && message.editedAt != null) {
        Text(stringResource(R.string.weldchat_channel_edited), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
    if (gallery.isNotEmpty()) {
        Column(Modifier.padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            gallery.forEach { attachment -> AttachmentView(attachment, actions.openImage) }
        }
    }
    val reactions = ChatLogic.reactionEntries(message.reactions)
    if (reactions.isNotEmpty()) ReactionsBar(reactions, selfId, Modifier.padding(top = 4.dp)) { emoji -> actions.toggleReaction(message, emoji) }
}

/** The body split at its inline files: text with mentions and links, the files where they were placed. */
@Composable
fun MessageBody(message: ChatMessage, names: Map<String, String>, openImage: (String) -> Unit) {
    val byId = remember(message.attachments) { message.attachments.associateBy { it.id } }
    val blocks = remember(message.content, byId) { MentionText.blocks(message.content, byId.keys) }
    val linkColor = MaterialTheme.colorScheme.primary
    val mentionText = ChatColors.mentionText.current()
    val mentionFill = ChatColors.mentionFill.current()
    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs)) {
        blocks.forEach { block ->
            when (block) {
                is MessageBlock.Text -> Text(
                    messageText(block.text, names, linkColor, mentionText, mentionFill),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                is MessageBlock.File -> byId[block.id]?.let { AttachmentView(it, openImage) }
            }
        }
    }
}

@Composable
fun MessageAvatar(message: ChatMessage, size: Dp = MessageAvatarSize) {
    if (message.isAgent) {
        AgentAvatar(message.authorAvatar, size)
    } else {
        ChatAvatar(message.authorName, message.authorAvatar, size)
    }
}

/** An agent: its emoji icon, or a bot, on the muted rounded square. */
@Composable
fun AgentAvatar(icon: String?, size: Dp) {
    Box(
        Modifier
            .size(size)
            .clip(AvatarShape)
            .background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        if (!icon.isNullOrEmpty()) {
            Text(icon, fontSize = (size.value * 0.45f).sp)
        } else {
            Icon(Icons.Filled.SmartToy, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(size * 0.5f))
        }
    }
}

/**
 * The line above a reply that ties it to what it answers, as the platform:
 * a curved connector from the avatar's column, the replied-to author's small
 * avatar and name, and the start of their message. A tap jumps to it.
 */
@Composable
fun ReplyQuote(reply: ReplyReference, names: Map<String, String>, modifier: Modifier = Modifier, onJump: () -> Unit) {
    val line = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
    Row(
        modifier
            .padding(bottom = 2.dp)
            .clip(RoundedCornerShape(Tokens.Radius.small))
            .clickable(onClick = onJump),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            Modifier
                .padding(start = MessageAvatarSize / 2 - 1.dp, top = 8.dp)
                .size(width = 20.dp, height = 10.dp)
                .drawBehind {
                    val stroke = 2.dp.toPx()
                    val radius = 6.dp.toPx()
                    val half = stroke / 2
                    val path = Path().apply {
                        moveTo(half, size.height)
                        lineTo(half, half + radius)
                        quadraticTo(half, half, half + radius, half)
                        lineTo(size.width, half)
                    }
                    drawPath(path, line, style = Stroke(width = stroke))
                },
        )
        ChatAvatar(reply.authorName, reply.authorAvatar, 16.dp)
        Text(
            reply.authorName,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
            maxLines = 1,
        )
        Text(
            ChatLogic.replyQuoteText(reply, names).text(),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * "N replies · 21:45" under a message, hooked to it by a curved line, in
 * the primary colour: opens the thread.
 */
@Composable
private fun ThreadSummary(message: ChatMessage, onOpen: () -> Unit) {
    val line = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
    val last = message.threadLastReplyAt?.let { WeldDate.parse(it) }?.let { ChatDates.lastReply(it) }
    Row(
        Modifier
            .padding(top = 2.dp)
            .clip(RoundedCornerShape(Tokens.Radius.small))
            .clickable(onClick = onOpen)
            .padding(vertical = 2.dp, horizontal = 2.dp)
            .tagged("thread-link-${message.id}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            Modifier
                .offset(y = (-4).dp)
                .size(width = 14.dp, height = 12.dp)
                .drawBehind {
                    val stroke = 1.5.dp.toPx()
                    val radius = 7.dp.toPx()
                    val half = stroke / 2
                    val path = Path().apply {
                        moveTo(half, 0f)
                        lineTo(half, size.height - half - radius)
                        quadraticTo(half, size.height - half, half + radius, size.height - half)
                        lineTo(size.width, size.height - half)
                    }
                    drawPath(path, line, style = Stroke(width = stroke))
                },
        )
        Text(
            pluralStringResource(R.plurals.weldchat_channel_reply_count, message.threadReplyCount, message.threadReplyCount),
            fontSize = 13.sp,
            lineHeight = 18.sp,
            fontWeight = FontWeight.Medium,
            color = MaterialTheme.colorScheme.primary,
        )
        if (!last.isNullOrEmpty()) {
            Text("· $last", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** An attachment: a photo (tap for the viewer), a voice message, or a file that opens. */
@Composable
fun AttachmentView(attachment: ChatAttachment, openImage: (String) -> Unit) {
    when {
        attachment.isImage -> ImageAttachment(attachment, openImage)
        attachment.isAudio -> AudioPlayerRow(attachment.url)
        else -> FileAttachment(attachment)
    }
}

/**
 * A photo at its own shape, fitted in 260×200 like the platform's
 * (`max-w-[300px] max-h-[200px]`), in a bordered `rounded-lg` frame. While
 * it loads a muted frame holds its place; one that can't load shows as a
 * file the phone can open (and, in a debug build, says why in the log).
 */
@Composable
private fun ImageAttachment(attachment: ChatAttachment, openImage: (String) -> Unit) {
    var ratio by remember(attachment.url) { mutableStateOf<Float?>(null) }
    var failed by remember(attachment.url) { mutableStateOf(false) }
    if (failed) {
        FileAttachment(attachment)
        return
    }
    val shape = RoundedCornerShape(Tokens.Radius.large)
    val frame = ratio?.let { aspect ->
        val width = min(260f, 200f * aspect)
        Modifier.size(width = width.dp, height = (width / aspect).dp)
    } ?: Modifier.size(width = 200.dp, height = 150.dp)
    AsyncImage(
        model = attachment.url,
        contentDescription = attachment.fileName,
        contentScale = ContentScale.Crop,
        onSuccess = { state ->
            val size = state.painter.intrinsicSize
            if (size.width > 0f && size.height > 0f && size.width.isFinite() && size.height.isFinite()) ratio = size.width / size.height
        },
        onError = { state ->
            // Debug builds only, and the host without the path: a storage key is as good as a link to the file.
            if (BuildConfig.DEBUG) {
                val host = runCatching { Uri.parse(attachment.url).host }.getOrNull() ?: "?"
                Log.w("WeldChat", "Image attachment on $host did not load: ${state.result.throwable}")
            }
            failed = true
        },
        modifier = frame
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .clickable { openImage(attachment.url) }
            .tagged("attachment-image-${attachment.id}"),
    )
}

/** A file: its icon, name and size in a bordered frame; a tap opens it. */
@Composable
private fun FileAttachment(attachment: ChatAttachment) {
    val context = LocalContext.current
    Surface(
        onClick = { openAttachment(context, attachment) },
        shape = RoundedCornerShape(Tokens.Radius.large),
        color = MaterialTheme.colorScheme.background,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.widthIn(max = 280.dp),
    ) {
        Row(
            Modifier.padding(horizontal = Tokens.Spacing.m, vertical = Tokens.Spacing.s),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
        ) {
            Icon(Icons.Outlined.Description, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
            Column {
                Text(attachment.fileName, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (attachment.fileSize > 0) {
                    Text(
                        Formatter.formatShortFileSize(context, attachment.fileSize.toLong()),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

/**
 * The reactions under a message, as the platform's chips: `rounded-md`
 * with a border, the emoji and the count; yours in blue. A tap adds yours or
 * takes it back.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ReactionsBar(reactions: List<Pair<String, List<String>>>, selfId: String, modifier: Modifier = Modifier, onToggle: (String) -> Unit) {
    val haptics = LocalHapticFeedback.current
    val mineColor = ChatColors.reactionMine
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        reactions.forEach { (emoji, users) ->
            val mine = selfId in users
            Surface(
                onClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    onToggle(emoji)
                },
                shape = RoundedCornerShape(Tokens.Radius.small),
                color = if (mine) mineColor.copy(alpha = 0.1f) else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                border = androidx.compose.foundation.BorderStroke(1.dp, if (mine) mineColor.copy(alpha = 0.4f) else MaterialTheme.colorScheme.outlineVariant),
            ) {
                Row(
                    Modifier.heightIn(min = 26.dp).padding(horizontal = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(emoji, fontSize = 13.sp)
                    Text(
                        users.size.toString(),
                        fontSize = 12.sp,
                        fontFamily = FontFamily.Monospace,
                        color = if (mine) mineColor else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

/**
 * A call in the conversation, drawn as the platform's notice: a message
 * from the caller (avatar, name, time) whose line says how the call went,
 * with a green phone for one that ran, grey for no answer and red for a
 * missed one; Join call while it runs and you're not in it.
 */
@Composable
fun CallNoticeRow(entry: CallLogEntry, selfId: String, ongoing: Boolean, joinable: Boolean, createdAt: String, compact: Boolean, onJoin: () -> Unit) {
    val mine = entry.callerId == selfId
    val missed = entry.outcome == CallLogEntry.Outcome.MISSED
    val lasted = if (entry.outcome == CallLogEntry.Outcome.ENDED) CallLog.lasted(entry.duration)?.text() else null
    val text = when {
        missed && mine -> stringResource(R.string.weldchat_channel_called_no_answer)
        missed -> stringResource(R.string.weldchat_channel_you_missed_call)
        lasted != null -> stringResource(R.string.weldchat_channel_started_call_lasted, lasted)
        else -> stringResource(R.string.weldchat_channel_started_call)
    }
    val icon = when {
        missed && mine -> Icons.AutoMirrored.Filled.CallMade
        missed -> Icons.AutoMirrored.Filled.CallMissed
        entry.isVideo -> Icons.Filled.Videocam
        else -> Icons.Filled.Call
    }
    val tint = when {
        missed && mine -> MaterialTheme.colorScheme.onSurfaceVariant
        missed -> ChatColors.callRed.current()
        else -> ChatColors.callGreen.current()
    }
    NoticeRow(entry.callerName, entry.callerAvatar, createdAt, compact, icon, tint, Modifier.tagged("call-notice")) {
        Text(text, style = MaterialTheme.typography.bodyMedium)
        if (ongoing && joinable) {
            Text(
                stringResource(R.string.weldchat_channel_join_call_link),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.clip(RoundedCornerShape(Tokens.Radius.small)).clickable(onClick = onJoin).tagged("call-notice-join"),
            )
        }
    }
}

/** A notice drawn like a message from the person it is about: their avatar, name and time, and one line with an icon. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun NoticeRow(
    name: String,
    avatar: String?,
    createdAt: String,
    compact: Boolean,
    icon: ImageVector,
    tint: Color,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Row(
        modifier.fillMaxWidth().padding(start = RowPadding, end = RowPadding, top = if (compact) 2.dp else 14.dp, bottom = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(AvatarGap),
    ) {
        if (compact) Spacer(Modifier.width(MessageAvatarSize)) else Box(Modifier.padding(top = 2.dp)) { ChatAvatar(name, avatar, MessageAvatarSize) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (!compact) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                    Text(name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    Text(ChatDates.time(WeldDate.parse(createdAt)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            FlowRow(verticalArrangement = Arrangement.Center, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.padding(top = 2.dp).size(15.dp))
                content()
            }
        }
    }
}

/** The day between messages: a line, the day in small muted text, a line. */
@Composable
fun DateSeparator(instant: Instant) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = RowPadding, vertical = Tokens.Spacing.l),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.l),
    ) {
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
        Text(
            ChatDates.dayLabel(instant).text(),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
    }
}

/**
 * A server notice in the conversation ("Ann pinned a message"): the
 * platform's centred muted chip, with a pin or phone when it is about one,
 * and the time.
 */
@Composable
fun SystemMessageRow(text: String, createdAt: String? = null) {
    val lower = text.lowercase()
    val icon = when {
        "pinned" in lower || "vastgezet" in lower -> Icons.Filled.PushPin
        "video call" in lower -> Icons.Filled.Videocam
        "call" in lower -> Icons.Filled.Call
        else -> null
    }
    val time = createdAt?.let { ChatDates.time(WeldDate.parse(it)) }.orEmpty()
    Box(Modifier.fillMaxWidth().padding(horizontal = RowPadding, vertical = 6.dp), contentAlignment = Alignment.Center) {
        Row(
            Modifier
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f), RoundedCornerShape(Tokens.Radius.small))
                .padding(horizontal = Tokens.Spacing.m, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (icon != null) Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(12.dp))
            Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (time.isNotEmpty()) {
                Text("·", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f))
                Text(time, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
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
