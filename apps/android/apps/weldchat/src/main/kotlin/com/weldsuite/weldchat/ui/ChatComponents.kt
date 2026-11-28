package com.weldsuite.weldchat.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Assignment
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.TableChart
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material.icons.filled.Work
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.ChatChannel
import com.weldsuite.weldchat.ChatLogic
import com.weldsuite.weldchat.DmConversation
import com.weldsuite.weldchat.DmPerson
import com.weldsuite.weldchat.MentionText
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.RecordChat
import com.weldsuite.weldchat.RecordChatRules
import com.weldsuite.weldchat.TextRun
import kotlinx.coroutines.launch
import org.weldsuite.ui.Avatar
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import kotlin.math.roundToInt
import org.weldsuite.core.R as CoreR

/** Shows a short message at the bottom of the screen (a copy, a failure). */
val LocalNotify = staticCompositionLocalOf<(String) -> Unit> { {} }

/** The mention badge's colour, as the platform's. */
val MentionColor = Color(0xFF5865F2)

/** A person's picture or initials, in WeldChat's colour. */
@Composable
fun ChatAvatar(name: String?, url: String?, size: Dp = 36.dp, modifier: Modifier = Modifier) {
    Avatar(name = name, url = url, size = size, modifier = modifier)
}

/** A group conversation: two avatars overlapping. */
@Composable
fun GroupAvatar(people: List<DmPerson>, size: Dp = 40.dp) {
    val unknown = stringResource(R.string.weldchat_dms_unknown_member)
    Box(Modifier.size(size)) {
        people.firstOrNull()?.let { ChatAvatar(it.displayName(unknown), it.picture, size * 0.72f, Modifier.align(Alignment.TopStart)) }
        people.getOrNull(1)?.let {
            ChatAvatar(
                it.displayName(unknown),
                it.picture,
                size * 0.72f,
                Modifier
                    .align(Alignment.BottomEnd)
                    .border(2.dp, MaterialTheme.colorScheme.surface, CircleShape),
            )
        }
    }
}

/** A DM's avatar: the person, or two for a group. */
@Composable
fun DmAvatar(dm: DmConversation, size: Dp = 40.dp) {
    if (dm.isGroup) GroupAvatar(dm.otherMembers, size) else ChatAvatar(dm.name, dm.picture, size)
}

/** An unread count on a brand capsule. */
@Composable
fun CountBadge(count: Int, prefix: String = "") {
    Text(
        "$prefix$count",
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.Bold,
        color = MaterialTheme.colorScheme.onPrimary,
        modifier = Modifier
            .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(50))
            .padding(horizontal = 6.dp, vertical = 1.dp),
    )
}

@Composable
fun UnreadDot() {
    Box(Modifier.size(8.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary))
}

/** A search field that opens the Search screen. */
@Composable
fun SearchButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(Tokens.Radius.medium),
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
            modifier = Modifier.padding(horizontal = Tokens.Spacing.m, vertical = 10.dp),
        ) {
            Icon(Icons.Filled.Search, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(stringResource(CoreR.string.core_common_search), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** A record type's icon. */
fun recordIcon(type: String?): ImageVector = when (type) {
    "company" -> Icons.Filled.Business
    "person" -> Icons.Filled.Person
    "task" -> Icons.Filled.TaskAlt
    "project" -> Icons.Filled.Work
    "domain" -> Icons.Filled.Language
    "sheet" -> Icons.Filled.TableChart
    "doc" -> Icons.Filled.Description
    "board" -> Icons.Filled.Dashboard
    else -> Icons.AutoMirrored.Filled.Assignment
}

/** A conversation row's leading icon, name and trailing marks. */
@Composable
private fun ConversationLine(icon: ImageVector, name: String, unread: Boolean, muted: Boolean, mentions: Int) {
    val color = if (unread) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = 10.dp),
    ) {
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(20.dp))
        Text(
            name,
            color = color,
            fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (muted) Icon(Icons.Filled.NotificationsOff, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
        if (mentions > 0) CountBadge(mentions)
    }
}

/** A channel row: # or lock, the name, the mentions. */
@Composable
fun ChannelRow(channel: ChatChannel) {
    ConversationLine(
        icon = if (channel.isPrivate) Icons.Filled.Lock else Icons.Filled.Tag,
        name = channel.name,
        unread = ChatLogic.isChannelUnread(channel),
        muted = channel.isMuted,
        mentions = channel.unreadMentionCount,
    )
}

/** A record chat row on Home: the type's icon and the record's name. */
@Composable
fun RecordChatRow(chat: RecordChat) {
    ConversationLine(
        icon = recordIcon(chat.entityType),
        name = chat.displayName,
        unread = RecordChatRules.isUnread(chat) || RecordChatRules.hasUnreadMentions(chat),
        muted = chat.isMuted,
        mentions = chat.unreadMentionCount,
    )
}

/** A DM row on Home: the avatar(s), the name, a dot when unread. */
@Composable
fun DmCompactRow(dm: DmConversation) {
    val unread = dm.hasUnread && !dm.isMuted
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = 8.dp),
    ) {
        DmAvatar(dm, 26.dp)
        Text(
            dm.name,
            color = if (unread) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
            fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (unread) UnreadDot()
    }
}

/** Message text with mentions as badges and web addresses as tappable links. */
fun messageText(text: String, names: Map<String, String>, linkColor: Color): AnnotatedString = buildAnnotatedString {
    for (run in MentionText.runs(text, names)) {
        when (run) {
            is TextRun.Plain -> append(run.text)
            is TextRun.Link -> withLink(LinkAnnotation.Url(run.url)) {
                withStyle(SpanStyle(color = linkColor)) { append(run.text) }
            }
            is TextRun.Mention -> withStyle(SpanStyle(color = MentionColor, background = MentionColor.copy(alpha = 0.15f), fontWeight = FontWeight.SemiBold)) {
                append(run.text)
            }
        }
    }
}

/** An action behind a row, revealed by swiping it. */
data class SwipeAction(
    val label: String,
    val icon: ImageVector,
    val color: Color,
    val tag: String? = null,
    val onClick: () -> Unit,
)

/**
 * A row that slides aside to show its actions: [start] behind its left
 * edge (swipe right), [end] behind its right edge (swipe left). A tap on an
 * action runs it and closes the row.
 */
@Composable
fun SwipeActions(
    start: List<SwipeAction>,
    end: List<SwipeAction>,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val actionWidth = 76.dp
    val density = LocalDensity.current
    val startWidth = with(density) { (actionWidth * start.size).toPx() }
    val endWidth = with(density) { (actionWidth * end.size).toPx() }
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    fun settle() {
        val target = when {
            offset.value > startWidth / 2 -> startWidth
            offset.value < -endWidth / 2 -> -endWidth
            else -> 0f
        }
        scope.launch { offset.animateTo(target) }
    }
    fun close() {
        scope.launch { offset.animateTo(0f) }
    }
    Box(modifier.fillMaxWidth()) {
        Row(Modifier.matchParentSize()) {
            start.forEach { action -> SwipeButton(action, actionWidth) { close(); action.onClick() } }
            Box(Modifier.weight(1f))
            end.forEach { action -> SwipeButton(action, actionWidth) { close(); action.onClick() } }
        }
        Box(
            Modifier
                .offset { IntOffset(offset.value.roundToInt(), 0) }
                .background(MaterialTheme.colorScheme.surface)
                .draggable(
                    orientation = Orientation.Horizontal,
                    state = rememberDraggableState { delta ->
                        scope.launch { offset.snapTo((offset.value + delta).coerceIn(-endWidth, startWidth)) }
                    },
                    onDragStopped = { settle() },
                ),
        ) { content() }
    }
}

@Composable
private fun SwipeButton(action: SwipeAction, width: Dp, onClick: () -> Unit) {
    Column(
        Modifier
            .width(width)
            .fillMaxHeight()
            .background(action.color)
            .clickable(onClick = onClick)
            .tagged(action.tag)
            .padding(Tokens.Spacing.xs),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(action.icon, contentDescription = null, tint = Color.White)
        Text(action.label, color = Color.White, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A list's section header. */
@Composable
fun ListHeader(text: String, modifier: Modifier = Modifier, trailing: @Composable (() -> Unit)? = null) {
    Row(
        modifier.fillMaxWidth().padding(start = Tokens.Spacing.l, end = Tokens.Spacing.s, top = Tokens.Spacing.m, bottom = Tokens.Spacing.xs).height(28.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        trailing?.invoke()
    }
}
