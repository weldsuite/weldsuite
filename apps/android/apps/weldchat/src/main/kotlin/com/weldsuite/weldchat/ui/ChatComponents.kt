package com.weldsuite.weldchat.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.layout.fillMaxSize
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
import androidx.compose.material.icons.automirrored.filled.Assignment
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.TableChart
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.material.icons.filled.Work
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.SubcomposeAsyncImage
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
import org.weldsuite.ui.DayNight
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.avatarColor
import org.weldsuite.ui.tagged
import kotlin.math.roundToInt
import org.weldsuite.core.R as CoreR

/** Shows a short message at the bottom of the screen (a copy, a failure). */
val LocalNotify = staticCompositionLocalOf<(String) -> Unit> { {} }

/**
 * The colours the web platform's WeldChat module uses for its own states,
 * as the Tailwind shades in its code (light, dark). Everything else comes
 * from the theme.
 */
object ChatColors {
    /** A mention in a message: `bg-blue-50 text-blue-600` (`blue-950`, `blue-400` dark). */
    val mentionText = DayNight(Color(0xFF2563EB), Color(0xFF60A5FA))
    val mentionFill = DayNight(Color(0xFFEFF6FF), Color(0xFF172554))

    /** A message that mentions you: `bg-yellow-50/60` and a `yellow-400` bar on its left edge. */
    val mentionedRow = DayNight(Color(0x99FEFCE8), Color(0x1A713F12))
    val mentionedBar = DayNight(Color(0xFFFACC15), Color(0xFFEAB308))

    /** A message flashed after a jump to it (`rgba(59,130,246,.12)`). */
    val flash = Color(0x1F3B82F6)

    /** Your own reaction: `bg-blue-600/10 border-blue-600/40 text-blue-600`. */
    val reactionMine = Color(0xFF2563EB)

    /** The unread count (`CountBadge`): `bg-red-500`, white text. */
    val count = Color(0xFFEF4444)

    /** A call that ran (`text-green-600`) and one that was missed (`text-red-600`). */
    val callGreen = DayNight(Color(0xFF16A34A), Color(0xFF4ADE80))
    val callRed = DayNight(Color(0xFFDC2626), Color(0xFFF87171))

    /** An unread activity row: `bg-blue-50/40` (`blue-950/20` dark) and a `blue-500` bar. */
    val activityUnread = DayNight(Color(0x66EFF6FF), Color(0x33172554))
    val activityBar = Color(0xFF3B82F6)
}

/** The platform's avatar: a rounded square, its corners a third of its width (`rounded-[32%]`). */
val AvatarShape: Shape = RoundedCornerShape(32)

/** The platform's fallback: the name's first letter (`(name || '?')[0].toUpperCase()`). */
fun avatarInitial(name: String?): String = name?.trim()?.firstOrNull()?.uppercase() ?: "?"

/**
 * A person's picture or, without one (or while it loads), the first letter
 * of their name in white on the colour the platform gives that name, in the
 * platform's rounded square.
 */
@Composable
fun ChatAvatar(name: String?, url: String?, size: Dp = 36.dp, modifier: Modifier = Modifier) {
    val box = modifier.size(size).clip(AvatarShape).clearAndSetSemantics { }
    if (url.isNullOrBlank()) {
        AvatarInitial(name, size, box)
    } else {
        SubcomposeAsyncImage(
            model = url,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = box,
            loading = { AvatarInitial(name, size, Modifier.fillMaxSize()) },
            error = { AvatarInitial(name, size, Modifier.fillMaxSize()) },
        )
    }
}

@Composable
private fun AvatarInitial(name: String?, size: Dp, modifier: Modifier) {
    Box(modifier.background(avatarColor(name.orEmpty())), contentAlignment = Alignment.Center) {
        Text(avatarInitial(name), color = Color.White, fontWeight = FontWeight.Medium, fontSize = (size.value * 0.42f).sp, maxLines = 1)
    }
}

/** A group conversation: two avatars overlapping (the platform's sidebar). */
@Composable
fun GroupAvatar(people: List<DmPerson>, size: Dp = 40.dp) {
    val unknown = stringResource(R.string.weldchat_dms_unknown_member)
    Box(Modifier.size(size)) {
        people.firstOrNull()?.let { ChatAvatar(it.displayName(unknown), it.picture, size * 0.66f, Modifier.align(Alignment.TopStart)) }
        people.getOrNull(1)?.let {
            ChatAvatar(
                it.displayName(unknown),
                it.picture,
                size * 0.66f,
                Modifier
                    .align(Alignment.BottomEnd)
                    .border(1.5.dp, MaterialTheme.colorScheme.background, AvatarShape),
            )
        }
    }
}

/** A DM's avatar: the person, or two for a group. */
@Composable
fun DmAvatar(dm: DmConversation, size: Dp = 40.dp) {
    if (dm.isGroup) GroupAvatar(dm.otherMembers, size) else ChatAvatar(dm.name, dm.picture, size)
}

/** The platform's `CountBadge`: a red circle for one digit, a pill for more, "99+" above 99. */
@Composable
fun CountBadge(count: Int, modifier: Modifier = Modifier) {
    if (count <= 0) return
    val text = if (count > 99) "99+" else count.toString()
    val minWidth = when (text.length) {
        1 -> 18.dp
        2 -> 24.dp
        else -> 30.dp
    }
    Box(
        modifier
            .height(18.dp)
            .widthIn(min = minWidth)
            .background(ChatColors.count, RoundedCornerShape(50))
            .padding(horizontal = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = Color.White, fontSize = 11.sp, lineHeight = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}

/**
 * A list's empty state icon, as the platform draws it: the icon in a muted
 * rounded square.
 */
@Composable
fun EmptyIcon(icon: ImageVector) {
    Box(
        Modifier.size(48.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(Tokens.Radius.xlarge)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(24.dp))
    }
}

/** A search field that opens the Search screen: the platform's bordered input. */
@Composable
fun SearchButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(Tokens.Radius.medium),
        color = MaterialTheme.colorScheme.background,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
            modifier = Modifier.padding(horizontal = Tokens.Spacing.m, vertical = 9.dp),
        ) {
            Icon(Icons.Filled.Search, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
            Text(stringResource(CoreR.string.core_common_search), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
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

/**
 * A conversation row as in the platform's sidebar: a small icon or avatar,
 * the name (semibold in the foreground while unread, else muted), a muted
 * conversation's bell and the red mention count.
 */
@Composable
fun SidebarRow(
    title: String,
    unread: Boolean,
    muted: Boolean,
    mentions: Int,
    modifier: Modifier = Modifier,
    leading: @Composable () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = modifier.fillMaxWidth().heightIn(min = 44.dp).padding(horizontal = Tokens.Spacing.l, vertical = 6.dp),
    ) {
        Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) { leading() }
        Text(
            title,
            style = MaterialTheme.typography.bodyMedium,
            color = if (unread) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
            fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (muted) Icon(Icons.Filled.NotificationsOff, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
        CountBadge(mentions)
    }
}

/** A sidebar row's 16dp icon, in the row's colour. */
@Composable
fun SidebarIcon(icon: ImageVector, unread: Boolean = false) {
    Icon(
        icon,
        contentDescription = null,
        tint = if (unread) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.size(18.dp),
    )
}

/** A channel row: # or lock, the name, the mentions. */
@Composable
fun ChannelRow(channel: ChatChannel) {
    val unread = ChatLogic.isChannelUnread(channel)
    SidebarRow(channel.name, unread, channel.isMuted, channel.unreadMentionCount) {
        SidebarIcon(if (channel.isPrivate) Icons.Filled.Lock else Icons.Filled.Tag, unread)
    }
}

/** A record chat row on Home: the type's icon and the record's name. */
@Composable
fun RecordChatRow(chat: RecordChat) {
    val unread = RecordChatRules.isUnread(chat) || RecordChatRules.hasUnreadMentions(chat)
    SidebarRow(chat.displayName, unread, chat.isMuted, chat.unreadMentionCount) {
        SidebarIcon(recordIcon(chat.entityType), unread)
    }
}

/** A DM row on Home: the avatar(s), the name, bold while unread. */
@Composable
fun DmCompactRow(dm: DmConversation) {
    val unread = dm.hasUnread && !dm.isMuted
    SidebarRow(dm.name, unread, dm.isMuted, mentions = 0) { DmAvatar(dm, 20.dp) }
}

/**
 * A group's header in the platform's sidebar: a small medium-weight muted
 * label (semibold in the foreground while the group has unread
 * conversations), the unread count, the mentions in red, and a chevron when
 * it folds.
 */
@Composable
fun SidebarGroupHeader(
    title: String,
    modifier: Modifier = Modifier,
    collapsed: Boolean? = null,
    unread: Int = 0,
    mentions: Int = 0,
    trailing: @Composable (() -> Unit)? = null,
) {
    Row(
        modifier.fillMaxWidth().heightIn(min = 40.dp).padding(start = Tokens.Spacing.l, end = Tokens.Spacing.s, top = Tokens.Spacing.s),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            title,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = if (unread > 0) FontWeight.SemiBold else FontWeight.Medium,
            color = if (unread > 0) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (unread > 0) {
            Text(unread.toString(), fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        CountBadge(mentions, Modifier.padding(start = 2.dp))
        if (collapsed != null) {
            Icon(
                Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                modifier = Modifier.size(16.dp).rotate(if (collapsed) -90f else 0f),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Box(Modifier.weight(1f))
        trailing?.invoke()
    }
}

/** The platform's dashed "+ Add channel" under a section with no channels. */
@Composable
fun AddPlaceholderRow(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(Tokens.Radius.medium)
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.xs)
            .clip(shape)
            .dashedBorder(MaterialTheme.colorScheme.outline, Tokens.Radius.medium)
            .clickable(onClick = onClick)
            .padding(horizontal = Tokens.Spacing.m, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s, Alignment.CenterHorizontally),
    ) {
        Icon(Icons.Filled.Add, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** A 1dp dashed outline with rounded corners. */
private fun Modifier.dashedBorder(color: Color, radius: Dp): Modifier = drawBehind {
    val stroke = Stroke(width = 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx())))
    val inset = stroke.width / 2
    drawRoundRect(
        color = color,
        topLeft = Offset(inset, inset),
        size = Size(size.width - stroke.width, size.height - stroke.width),
        cornerRadius = CornerRadius(radius.toPx()),
        style = stroke,
    )
}

/**
 * A list's group header, as the platform's lists draw one (WeldDesk's
 * "Last week 2"): a muted band with a hairline under it, the label small
 * and medium-weight, the count in a small bordered chip.
 */
@Composable
fun ListGroupHeader(label: String, count: Int?, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(32.dp)
                .background(MaterialTheme.colorScheme.background)
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                .padding(horizontal = Tokens.Spacing.l),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
        ) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (count != null) {
                Box(
                    Modifier
                        .heightIn(min = 16.dp)
                        .widthIn(min = 16.dp)
                        .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(5.dp))
                        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(5.dp))
                        .padding(horizontal = 4.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(count.toString(), fontSize = 10.sp, lineHeight = 12.sp, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f))
    }
}

/** A list row's hairline, as under the platform's list rows. */
@Composable
fun RowDivider(modifier: Modifier = Modifier) {
    HorizontalDivider(modifier, color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f))
}

/**
 * Message text with mentions as the platform's blue chips and web
 * addresses as underlined links in the primary colour.
 */
fun messageText(text: String, names: Map<String, String>, linkColor: Color, mentionText: Color, mentionFill: Color): AnnotatedString = buildAnnotatedString {
    for (run in MentionText.runs(text, names)) {
        when (run) {
            is TextRun.Plain -> append(run.text)
            is TextRun.Link -> withLink(LinkAnnotation.Url(run.url)) {
                withStyle(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline)) { append(run.text) }
            }
            is TextRun.Mention -> withStyle(SpanStyle(color = mentionText, background = mentionFill, fontWeight = FontWeight.Medium)) {
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
                .background(MaterialTheme.colorScheme.background)
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

/** A plain section header in a list or form: a small medium-weight muted label. */
@Composable
fun ListHeader(text: String, modifier: Modifier = Modifier, trailing: @Composable (() -> Unit)? = null) {
    Row(
        modifier.fillMaxWidth().heightIn(min = 36.dp).padding(start = Tokens.Spacing.l, end = Tokens.Spacing.s, top = Tokens.Spacing.s),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        trailing?.invoke()
    }
}
