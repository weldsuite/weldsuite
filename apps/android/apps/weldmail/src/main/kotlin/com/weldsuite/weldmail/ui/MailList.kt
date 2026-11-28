package com.weldsuite.weldmail.ui

import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.SubcomposeAsyncImage
import com.weldsuite.weldmail.DateGroup
import com.weldsuite.weldmail.DateStyle
import com.weldsuite.weldmail.MailLogic
import com.weldsuite.weldmail.MailMessage
import com.weldsuite.weldmail.R
import com.weldsuite.weldmail.SearchLogic
import org.weldsuite.core.R as CoreR
import org.weldsuite.core.WeldDate
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.avatarColor
import org.weldsuite.ui.labelColor
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

// The platform's mail list (`components/shared/conversation-list`): its row,
// its date-group headers, its badges and its empty state, shared by the
// inbox, search and the message's conversation.

/** The colours the platform's mail screens give their markers (Tailwind). */
object MailColors {
    /** `bg-blue-600`: the unread dot. */
    val unread = Color(0xFF2563EB)

    /** `text-yellow-500`: a starred message. */
    val star = Color(0xFFEAB308)

    /** `text-blue-500`: a pinned message. */
    val pin = Color(0xFF3B82F6)

    /** `text-orange-500`: an important message's flag. */
    val important = Color(0xFFF97316)

    /** `text-purple-600`: snoozing, as the platform's "Snoozed until" line. */
    val snooze = Color(0xFF9333EA)

    /** `gray-500`: the neutral swipe actions (read, archive). */
    val neutral = Color(0xFF6B7280)
}

fun rgb(value: Int): Color = Color(0xFF000000 or value.toLong())

/** A label's colour: its own, else the platform's colour for its name. */
fun labelTint(name: String, own: String?): Color = MailLogic.parseHex(own)?.let(::rgb) ?: labelColor(name)

/**
 * A person on a row: their picture, else the first letter of the name, white
 * on the platform's avatar colour for that name (as the platform's mail list).
 */
@Composable
fun MailAvatar(name: String, modifier: Modifier = Modifier, url: String? = null, size: Dp = 28.dp) {
    val box = modifier.size(size).clip(CircleShape).clearAndSetSemantics { }
    if (url.isNullOrBlank()) {
        Initial(name, size, box)
    } else {
        SubcomposeAsyncImage(
            model = url,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = box,
            loading = { Initial(name, size, Modifier.fillMaxSize()) },
            error = { Initial(name, size, Modifier.fillMaxSize()) },
        )
    }
}

@Composable
private fun Initial(name: String, size: Dp, modifier: Modifier) {
    val textSize = (size.value * 0.43f).sp
    Box(modifier.background(avatarColor(name)), contentAlignment = Alignment.Center) {
        // The line as tall as the letter, and the letter centred in it: the
        // theme's taller body line would push it below the middle of a small avatar.
        Text(
            name.trim().firstOrNull()?.uppercase() ?: "?",
            color = Color.White,
            style = MaterialTheme.typography.labelMedium.copy(
                fontSize = textSize,
                lineHeight = textSize,
                fontWeight = FontWeight.SemiBold,
                lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.Both),
            ),
        )
    }
}

/** A custom label on a row: its name in its colour on a light wash of it, `rounded`. */
@Composable
fun LabelChip(name: String, color: Color, modifier: Modifier = Modifier) {
    Text(
        name,
        color = color,
        style = MaterialTheme.typography.labelMedium,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = modifier
            .background(color.copy(alpha = 0.08f), RoundedCornerShape(4.dp))
            .padding(horizontal = Tokens.Spacing.s, vertical = 2.dp),
    )
}

/** The platform's small monospaced count: a group header's size, a conversation's length. */
@Composable
fun CountBadge(count: Int, modifier: Modifier = Modifier, height: Dp = 16.dp) {
    val shape = RoundedCornerShape(if (height > 16.dp) 6.dp else 5.dp)
    Box(
        modifier
            .height(height)
            .defaultMinSize(minWidth = height)
            .background(MaterialTheme.colorScheme.surfaceVariant, shape)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .padding(horizontal = 3.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            count.toString(),
            fontFamily = FontFamily.Monospace,
            fontSize = 10.sp,
            lineHeight = 10.sp,
            fontWeight = FontWeight.Medium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * A date group's header, as the platform's list: a muted band with the
 * group's name and its size, hairlines above and below.
 */
@Composable
fun GroupHeader(title: String, count: Int, modifier: Modifier = Modifier, topBorder: Boolean = false) {
    Column(modifier.fillMaxWidth()) {
        if (topBorder) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Row(
            Modifier
                .fillMaxWidth()
                .height(32.dp)
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                .padding(horizontal = Tokens.Spacing.l),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
        ) {
            Text(title, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            CountBadge(count)
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    }
}

/** A list filter, as the platform's `FilterButton`: outlined and muted, tinted with the primary while on. */
@Composable
fun FilterPill(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val primary = MaterialTheme.colorScheme.primary
    val shape = MaterialTheme.shapes.small
    Box(
        modifier
            .height(32.dp)
            .clip(shape)
            .background(if (selected) primary.copy(alpha = 0.10f) else Color.Transparent)
            .border(1.dp, if (selected) primary.copy(alpha = 0.4f) else MaterialTheme.colorScheme.outlineVariant, shape)
            .clickable(onClick = onClick)
            .semantics {
                this.selected = selected
                role = Role.Tab
            }
            .padding(horizontal = Tokens.Spacing.m),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            color = if (selected) primary else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
        )
    }
}

/** The platform's search box (`h-8`, bordered, `rounded-md`), as a button that opens search. */
@Composable
fun SearchEntry(placeholder: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val shape = MaterialTheme.shapes.small
    Row(
        modifier
            .fillMaxWidth()
            .height(40.dp)
            .clip(shape)
            .background(MaterialTheme.colorScheme.background)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Search, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
        Text(
            placeholder,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = Tokens.Spacing.s),
        )
    }
}

/** Nothing to list: the icon in a muted square, a semibold title, a muted line. */
@Composable
fun MailEmptyState(icon: ImageVector, title: String, modifier: Modifier = Modifier, description: String? = null) {
    Column(
        modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.xl, vertical = 56.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier.size(44.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(Tokens.Radius.large)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
        }
        Text(
            title,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = Tokens.Spacing.m),
        )
        if (description != null) {
            Text(
                description,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = Tokens.Spacing.xs),
            )
        }
    }
}

/**
 * One email in a list, as the platform's conversation row: the avatar with
 * the unread dot beside it, the sender (or "To:" and the recipients in Sent,
 * Drafts and Scheduled) with the conversation's size, the attachment, pin,
 * important and star markers and the time; the subject, the preview, the
 * labels. [query] is emphasised where it matches (search).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MessageRow(
    message: MailMessage,
    pinned: Boolean,
    outgoing: Boolean,
    labelColors: Map<String, String?>,
    modifier: Modifier = Modifier,
    query: String = "",
) {
    val unread = !message.isRead
    val strong = MaterialTheme.colorScheme.onSurface
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val name = if (outgoing) {
        MailLogic.recipientNames(message.to) ?: stringResource(R.string.weldmail_inbox_no_recipient)
    } else {
        message.senderName ?: stringResource(R.string.weldmail_common_unknown)
    }
    val avatarUrl = if (outgoing) message.to.firstOrNull()?.avatarUrl else message.from?.avatarUrl
    val prefix = if (outgoing) stringResource(R.string.weldmail_inbox_to_prefix) else null
    val unreadLabel = stringResource(R.string.weldmail_inbox_unread_dot)
    Row(
        modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.padding(top = 3.dp)) {
            MailAvatar(name, url = avatarUrl)
            if (unread) {
                Box(
                    Modifier
                        .align(Alignment.CenterStart)
                        .offset(x = (-10).dp)
                        .size(6.dp)
                        .background(MailColors.unread, CircleShape)
                        .semantics { contentDescription = unreadLabel },
                )
            }
        }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        buildAnnotatedString {
                            if (prefix != null) withStyle(SpanStyle(fontWeight = FontWeight.Normal, color = muted)) { append("$prefix ") }
                            append(highlighted(name, query))
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Medium,
                        color = if (unread) strong else muted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (message.threadCount > 1) CountBadge(message.threadCount, Modifier.padding(start = 6.dp), height = 18.dp)
                }
                Row(
                    Modifier.padding(start = Tokens.Spacing.s),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (message.hasAttachments) Marker(Icons.Outlined.AttachFile, muted, stringResource(R.string.weldmail_inbox_has_attachments))
                    if (pinned) Marker(Icons.Filled.PushPin, MailColors.pin, stringResource(R.string.weldmail_inbox_is_pinned))
                    if (MailLogic.isImportant(message)) Marker(Icons.Filled.Flag, MailColors.important, stringResource(R.string.weldmail_inbox_is_important))
                    if (message.isStarred) Marker(Icons.Filled.Star, MailColors.star, stringResource(R.string.weldmail_inbox_is_starred))
                    Text(dateText(message.listDate), style = MaterialTheme.typography.bodySmall, color = muted)
                }
            }
            Text(
                highlighted(message.subject?.takeIf { it.isNotBlank() } ?: stringResource(R.string.weldmail_common_no_subject), query),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (unread) FontWeight.Medium else FontWeight.Normal,
                color = if (unread) strong else muted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 1.dp),
            )
            Text(
                highlighted(message.preview.orEmpty(), query),
                style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp, lineHeight = 18.sp),
                color = muted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 2.dp),
            )
            val shown = MailLogic.displayLabels(message.labels)
            if (shown.isNotEmpty()) {
                FlowRow(
                    Modifier.padding(top = Tokens.Spacing.s),
                    horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs),
                    verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs),
                ) {
                    shown.take(3).forEach { label -> LabelChip(label, labelTint(label, labelColors[label])) }
                    if (shown.size > 3) {
                        Text(
                            "+${shown.size - 3}",
                            fontSize = 10.sp,
                            color = muted,
                            modifier = Modifier.align(Alignment.CenterVertically),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun Marker(icon: ImageVector, tint: Color, description: String) {
    Icon(icon, contentDescription = description, tint = tint, modifier = Modifier.size(13.dp))
}

/** A spacer the height of the FAB, so the last row can scroll above it. */
@Composable
fun FabClearance() {
    Spacer(Modifier.height(88.dp))
}

/** The text with every match of the query (any case) emphasised. */
fun highlighted(text: String, query: String): AnnotatedString = buildAnnotatedString {
    if (query.isBlank()) {
        append(text)
        return@buildAnnotatedString
    }
    var at = 0
    for (range in SearchLogic.matches(text, query)) {
        append(text.substring(at, range.first))
        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(text.substring(range.first, range.last + 1)) }
        at = range.last + 1
    }
    append(text.substring(at))
}

/** A group's name: Yesterday, a weekday, Last week, 2 weeks ago, a month (the list leaves Today's header out). */
@Composable
fun groupTitle(group: DateGroup, locale: Locale = Locale.getDefault()): String = when (group.kind) {
    DateGroup.Kind.PINNED -> stringResource(R.string.weldmail_inbox_pinned)
    DateGroup.Kind.TODAY, DateGroup.Kind.UNDATED -> stringResource(CoreR.string.core_common_today)
    DateGroup.Kind.YESTERDAY -> stringResource(CoreR.string.core_common_yesterday)
    DateGroup.Kind.WEEKDAY -> dayText(group.day, "EEEE", locale)
    DateGroup.Kind.LAST_WEEK -> stringResource(R.string.weldmail_inbox_last_week)
    DateGroup.Kind.WEEKS_AGO -> pluralStringResource(R.plurals.weldmail_inbox_weeks_ago, group.weeks, group.weeks)
    DateGroup.Kind.MONTH -> dayText(group.day, "LLLL", locale)
    DateGroup.Kind.MONTH_YEAR -> dayText(group.day, DateFormat.getBestDateTimePattern(locale, "MMMMy"), locale)
    DateGroup.Kind.UPCOMING -> dayText(group.day, DateFormat.getBestDateTimePattern(locale, "MMMMd"), locale)
}

private fun dayText(day: LocalDate?, pattern: String, locale: Locale): String =
    day?.format(DateTimeFormatter.ofPattern(pattern, locale))?.replaceFirstChar { it.titlecase(locale) }.orEmpty()

/**
 * A date as the platform's mail screens show it: the time today ("13:21"),
 * else the day ("27 Nov", "Nov 27" in English), with the year once it isn't
 * this year's; [withTime] adds the time to a day (the message's own date).
 */
fun dateText(date: String, withTime: Boolean = false, locale: Locale = Locale.getDefault()): String {
    val instant = WeldDate.parse(date) ?: return ""
    val zoned = instant.atZone(ZoneId.systemDefault())
    val time = zoned.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale))
    val day = when (MailLogic.dateStyle(instant)) {
        DateStyle.TIME -> return time
        DateStyle.DAY -> zoned.format(DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, "MMMd"), locale))
        DateStyle.DAY_YEAR -> zoned.format(DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, "yMMMd"), locale))
    }
    return if (withTime) "$day, $time" else day
}
