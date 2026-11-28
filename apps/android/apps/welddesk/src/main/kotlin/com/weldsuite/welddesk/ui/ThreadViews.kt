package com.weldsuite.welddesk.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Resources
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import coil.compose.AsyncImage
import com.weldsuite.welddesk.Attachment
import com.weldsuite.welddesk.AttributeChange
import com.weldsuite.welddesk.AuthorType
import com.weldsuite.welddesk.ChangeValue
import com.weldsuite.welddesk.DeskChannel
import com.weldsuite.welddesk.DeskLogic
import com.weldsuite.welddesk.Member
import com.weldsuite.welddesk.Message
import com.weldsuite.welddesk.MessageKind
import com.weldsuite.welddesk.R
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlin.math.min

/** The channel's name; one the app doesn't know shows as the server sends it. */
@Composable
fun channelName(channel: DeskChannel, value: String): String = when (channel) {
    DeskChannel.MESSENGER -> stringResource(R.string.welddesk_channel_messenger)
    DeskChannel.EMAIL -> stringResource(R.string.welddesk_channel_email)
    DeskChannel.PHONE -> stringResource(R.string.welddesk_channel_phone)
    DeskChannel.WHATSAPP -> stringResource(R.string.welddesk_channel_whatsapp)
    DeskChannel.SMS -> stringResource(R.string.welddesk_channel_sms)
    DeskChannel.API -> stringResource(R.string.welddesk_channel_api)
    DeskChannel.PORTAL -> stringResource(R.string.welddesk_channel_portal)
    DeskChannel.OTHER -> value
}

/** The header's SLA chip (the platform's `DeskSlaBadge`): a clock and the countdown on the tone's tint. */
@Composable
fun SlaChip(display: DeskLogic.SlaDisplay, modifier: Modifier = Modifier) {
    val (background, text) = when (display.tone) {
        DeskLogic.SlaTone.OK -> DeskColors.slaChipOk.first.current() to DeskColors.slaChipOk.second.current()
        DeskLogic.SlaTone.WARNING -> DeskColors.slaChipWarning.first.current() to DeskColors.slaChipWarning.second.current()
        DeskLogic.SlaTone.BREACHED -> DeskColors.slaChipBreached.first.current() to DeskColors.slaChipBreached.second.current()
        DeskLogic.SlaTone.MUTED -> MaterialTheme.colorScheme.surfaceVariant to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(
        modifier.background(background, CircleShape).padding(horizontal = Tokens.Spacing.s, vertical = 2.dp).tagged("sla-badge"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs),
    ) {
        Icon(Icons.Outlined.AccessTime, contentDescription = null, tint = text, modifier = Modifier.size(12.dp))
        Text(slaText(display.label), style = MaterialTheme.typography.labelMedium, color = text, maxLines = 1)
    }
}

/** "Online": the visitor has the widget open on this conversation. */
@Composable
fun OnlineIndicator(modifier: Modifier = Modifier) {
    val color = DeskColors.onlineText.current()
    Row(
        modifier.tagged("visitor-online"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(8.dp).background(DeskColors.onlineDot, CircleShape))
        Text(stringResource(R.string.welddesk_conversation_online), style = MaterialTheme.typography.labelMedium, color = color)
    }
}

/** The line between two days of the timeline, with the day in the middle. */
@Composable
fun DaySeparator(day: LocalDate) {
    val colors = MaterialTheme.colorScheme
    val locale = appLocale()
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        Box(Modifier.weight(1f).height(1.dp).background(colors.outlineVariant.copy(alpha = 0.7f)))
        Text(
            day.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG).withLocale(locale)),
            style = MaterialTheme.typography.labelMedium,
            color = colors.onSurfaceVariant,
        )
        Box(Modifier.weight(1f).height(1.dp).background(colors.outlineVariant.copy(alpha = 0.7f)))
    }
}

/** Who wrote what, for the timeline: the roster, the customer's name, and "Someone" for the rest. */
class TimelineNames(private val members: List<Member>?, val visitor: String, val someone: String) {
    fun member(userId: String?): Member? = userId?.let { id -> members?.firstOrNull { it.userId == id } }
    fun name(userId: String?): String? = member(userId)?.name
}

/**
 * One timeline entry: an event line ("Ann closed this conversation · 14:02"),
 * or a message bubble with its author's avatar beside it, the customer's on
 * the left and the team's on the right, as on the platform.
 */
@Composable
fun MessageRow(message: Message, names: TimelineNames, now: Instant, zone: ZoneId, onOpenFailed: () -> Unit) {
    if (message.kind == MessageKind.EVENT) {
        EventRow(message, names, zone)
    } else {
        MessageBubble(message, names, now, zone, onOpenFailed)
    }
}

@Composable
private fun EventRow(message: Message, names: TimelineNames, zone: ZoneId) {
    val resources = LocalContext.current.resources
    val sentences = eventSentences(resources, message, names)
    if (sentences.isEmpty()) return
    val time = message.createdAt?.atZone(zone)?.format(DateTimeFormatter.ofPattern("HH:mm"))
    val eventType = message.eventType
    val internal = eventType in DeskLogic.INTERNAL_EVENTS
    val color = when (eventType) {
        "sla_warning" -> DeskColors.slaWarningLine.current()
        "sla_breached" -> DeskColors.slaBreachedLine.current()
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Column(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s).tagged("event-${message.id}"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        sentences.forEach { sentence ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs)) {
                if (internal) Icon(Icons.Outlined.Lock, contentDescription = null, tint = color, modifier = Modifier.size(12.dp))
                Text(
                    if (time != null) "$sentence · $time" else sentence,
                    style = MaterialTheme.typography.bodySmall,
                    color = color,
                    textAlign = TextAlign.Center,
                )
            }
        }
        message.details.ratingComment?.takeIf { eventType == "rated" && it.isNotBlank() }?.let { comment ->
            Text(
                "“$comment”",
                style = MaterialTheme.typography.bodySmall,
                fontStyle = FontStyle.Italic,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.8f),
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = Tokens.Spacing.xs).widthIn(max = 448.dp).tagged("rating-comment"),
            )
        }
    }
}

/**
 * An event's line (several for a change of several fields), as the
 * platform's `messages-timeline.tsx` words it. The actor is the teammate who
 * did it, by name from the roster.
 */
fun eventSentences(res: Resources, message: Message, names: TimelineNames): List<String> {
    val details = message.details
    val actor = names.name(message.authorId) ?: names.someone
    fun named(userId: String?): String = names.name(userId) ?: userId.orEmpty()
    fun metric(key: String?): String = when (key) {
        "first_response" -> res.getString(R.string.welddesk_sla_first_response)
        "next_response" -> res.getString(R.string.welddesk_sla_next_response)
        "resolution" -> res.getString(R.string.welddesk_sla_resolution)
        else -> "SLA"
    }
    val number = details.linkedNumber ?: "?"
    val toParent = details.linkRole == "parent"
    val step = details.stepName?.takeIf { it.isNotBlank() } ?: res.getString(R.string.welddesk_timeline_step, ((details.stepIndex ?: 0) + 1).toString())
    fun withComment(sentence: String): String =
        details.comment?.takeIf { it.isNotBlank() }?.let { res.getString(R.string.welddesk_timeline_with_comment, sentence, it) } ?: sentence
    val single: String? = when (message.eventType) {
        "attributes_changed" -> return details.changes.flatMap { changeSentences(res, it, actor) }
        "rated" -> res.getString(R.string.welddesk_timeline_rated, names.visitor, message.rating?.toString() ?: "?")
        "closed" -> res.getString(R.string.welddesk_timeline_closed, actor)
        "reopened" -> res.getString(R.string.welddesk_timeline_reopened, actor)
        "unassigned" -> res.getString(R.string.welddesk_timeline_unassigned, actor)
        "assigned" -> if (details.auto) {
            res.getString(R.string.welddesk_timeline_auto_assigned, named(details.assigneeId))
        } else {
            res.getString(R.string.welddesk_timeline_assigned, actor, named(details.assigneeId))
        }
        "escalated" -> {
            val reason = res.getString(
                when (details.condition) {
                    "no_response" -> R.string.welddesk_timeline_reason_no_response
                    "sla_breach" -> R.string.welddesk_timeline_reason_sla_breach
                    else -> R.string.welddesk_timeline_reason_unassigned
                },
            )
            when {
                details.assigneeId != null -> res.getString(R.string.welddesk_timeline_escalated_to, named(details.assigneeId), reason)
                details.toTeamId != null -> res.getString(R.string.welddesk_timeline_escalated_to_next_team, reason)
                else -> res.getString(R.string.welddesk_timeline_escalated_no_target, reason)
            }
        }
        "sla_warning" -> res.getString(R.string.welddesk_timeline_sla_warning, metric(details.metric))
        "sla_breached" -> res.getString(R.string.welddesk_timeline_sla_breached, metric(details.metric))
        "linked" -> res.getString(if (toParent) R.string.welddesk_timeline_linked_to_parent else R.string.welddesk_timeline_linked_child, actor, number)
        "unlinked" -> res.getString(if (toParent) R.string.welddesk_timeline_unlinked_from_parent else R.string.welddesk_timeline_unlinked_child, actor, number)
        "merged_into" -> res.getString(R.string.welddesk_timeline_merged_into, actor, number)
        "merged_from" -> res.getString(R.string.welddesk_timeline_merged_from, actor, number)
        "incident_marked" -> res.getString(R.string.welddesk_timeline_incident_marked, actor)
        "incident_unmarked" -> res.getString(R.string.welddesk_timeline_incident_unmarked, actor)
        "problem_linked" -> res.getString(R.string.welddesk_timeline_problem_linked, actor, details.problemNumber ?: "?")
        "problem_unlinked" -> res.getString(R.string.welddesk_timeline_problem_unlinked, actor, details.problemNumber ?: "?")
        "approval_requested" -> details.approverId?.let { res.getString(R.string.welddesk_timeline_approval_requested, named(it), step) }
            ?: res.getString(R.string.welddesk_timeline_approval_requested_nobody, step)
        "approval_approved" -> withComment(res.getString(R.string.welddesk_timeline_approval_approved, actor, step))
        "approval_rejected" -> withComment(res.getString(R.string.welddesk_timeline_approval_rejected, actor, step))
        "fulfilment_started" -> if (details.taskCount == 1) {
            res.getString(R.string.welddesk_timeline_fulfilment_started_one)
        } else {
            res.getString(R.string.welddesk_timeline_fulfilment_started_other, details.taskCount)
        }
        else -> null
    }
    return listOf(single ?: message.body?.takeIf { it.isNotBlank() } ?: res.getString(R.string.welddesk_timeline_generic, actor, message.eventType ?: "event"))
}

/** One line per field an `attributes_changed` event changed. */
private fun changeSentences(res: Resources, change: AttributeChange, actor: String): List<String> {
    val cleared = DeskLogic.isCleared(change.to)
    fun shown(value: ChangeValue): String = when (value) {
        ChangeValue.Empty -> ""
        is ChangeValue.Text -> value.text
        is ChangeValue.Items -> value.items.joinToString(", ")
        is ChangeValue.Flag -> res.getString(if (value.on) R.string.welddesk_timeline_yes else R.string.welddesk_timeline_no)
    }
    fun level(value: ChangeValue): String = when ((value as? ChangeValue.Text)?.text) {
        "low" -> res.getString(R.string.welddesk_timeline_level_low)
        "medium" -> res.getString(R.string.welddesk_timeline_level_medium)
        "high" -> res.getString(R.string.welddesk_timeline_level_high)
        else -> shown(value)
    }
    fun priority(value: ChangeValue): String = when ((value as? ChangeValue.Text)?.text) {
        "urgent" -> res.getString(R.string.welddesk_priority_urgent)
        "high" -> res.getString(R.string.welddesk_priority_high)
        "medium" -> res.getString(R.string.welddesk_priority_medium)
        "low" -> res.getString(R.string.welddesk_priority_low)
        else -> shown(value)
    }
    return when (change.field) {
        "ticketType" -> listOf(if (cleared) res.getString(R.string.welddesk_timeline_type_cleared, actor) else res.getString(R.string.welddesk_timeline_type_set, actor, shown(change.to)))
        "team" -> listOf(if (cleared) res.getString(R.string.welddesk_timeline_team_cleared, actor) else res.getString(R.string.welddesk_timeline_team_set, actor, shown(change.to)))
        "priority" -> listOf(if (cleared) res.getString(R.string.welddesk_timeline_priority_cleared, actor) else res.getString(R.string.welddesk_timeline_priority_set, actor, priority(change.to)))
        "tags" -> {
            val (added, removed) = DeskLogic.tagDiff(change)
            buildList {
                if (added.isNotEmpty()) add(res.getString(R.string.welddesk_timeline_tags_added, actor, added.joinToString(", ")))
                if (removed.isNotEmpty()) add(res.getString(R.string.welddesk_timeline_tags_removed, actor, removed.joinToString(", ")))
            }
        }
        "impact" -> listOf(if (cleared) res.getString(R.string.welddesk_timeline_impact_cleared, actor) else res.getString(R.string.welddesk_timeline_impact_set, actor, level(change.to)))
        "urgency" -> listOf(if (cleared) res.getString(R.string.welddesk_timeline_urgency_cleared, actor) else res.getString(R.string.welddesk_timeline_urgency_set, actor, level(change.to)))
        "customField" -> {
            val field = change.label ?: change.key.orEmpty()
            listOf(if (cleared) res.getString(R.string.welddesk_timeline_field_cleared, actor, field) else res.getString(R.string.welddesk_timeline_field_set, actor, field, shown(change.to)))
        }
        else -> emptyList()
    }
}

/** How long ago, short: "Now", "4min", "2h", "3d", then the day. */
@Composable
private fun agoText(at: Instant, now: Instant, zone: ZoneId): String = when (val ago = DeskLogic.ago(at, now, zone)) {
    DeskLogic.Ago.Now -> stringResource(R.string.welddesk_conversation_time_now)
    is DeskLogic.Ago.Minutes -> stringResource(R.string.welddesk_conversation_time_minutes, ago.n.toString())
    is DeskLogic.Ago.Hours -> stringResource(R.string.welddesk_conversation_time_hours, ago.n.toString())
    is DeskLogic.Ago.Days -> stringResource(R.string.welddesk_conversation_time_days, ago.n.toString())
    is DeskLogic.Ago.On -> ago.day.format(DateTimeFormatter.ofPattern(android.text.format.DateFormat.getBestDateTimePattern(appLocale(), "dMMM"), appLocale()))
}

/** A message: the customer's grey bubble on the left, the team's indigo one on the right, a note in amber. */
@Composable
private fun MessageBubble(message: Message, names: TimelineNames, now: Instant, zone: ZoneId, onOpenFailed: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val isVisitor = message.authorType == AuthorType.VISITOR
    val isBot = message.authorType == AuthorType.BOT
    val isNote = message.kind == MessageKind.NOTE
    val member = if (isVisitor) null else names.member(message.authorId)
    val label = when {
        isVisitor -> names.visitor
        isBot -> stringResource(R.string.welddesk_conversation_ai)
        else -> member?.name ?: stringResource(R.string.welddesk_conversation_agent)
    }
    val background = when {
        isNote -> DeskColors.noteBubble.current()
        isVisitor -> colors.surfaceVariant
        else -> DeskColors.agentBubble.current()
    }
    val textColor = when {
        isNote -> DeskColors.noteText.current()
        isVisitor -> colors.onSurface
        else -> DeskColors.agentText.current()
    }
    val metaColor = when {
        isNote -> DeskColors.noteMeta.current()
        isVisitor -> colors.onSurfaceVariant
        else -> DeskColors.agentMeta.current()
    }
    val shape = RoundedCornerShape(Tokens.Radius.xlarge)
    BoxWithConstraints(Modifier.fillMaxWidth().padding(start = Tokens.Spacing.l, end = Tokens.Spacing.l, top = Tokens.Spacing.m)) {
        val bubbleMax = maxWidth * 0.7f
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s, if (isVisitor) Alignment.Start else Alignment.End),
            verticalAlignment = Alignment.Bottom,
        ) {
            if (isVisitor) InitialAvatar(label, size = 24.dp)
            Column(
                Modifier
                    .widthIn(max = bubbleMax)
                    .clip(shape)
                    .background(background)
                    .then(if (isNote) Modifier.border(BorderStroke(1.dp, DeskColors.noteBorder.current()), shape) else Modifier)
                    .padding(start = 14.dp, end = 14.dp, top = 10.dp, bottom = Tokens.Spacing.s)
                    .semantics { contentDescription = label }
                    .tagged("message-${message.id}"),
                horizontalAlignment = if (isVisitor) Alignment.Start else Alignment.End,
            ) {
                val body = message.body?.takeIf { it.isNotEmpty() }
                if (body != null) {
                    Text(body, fontSize = 14.sp, lineHeight = 22.sp, color = textColor, modifier = Modifier.align(Alignment.Start))
                }
                if (message.attachments.isNotEmpty()) {
                    Column(
                        Modifier.padding(top = if (body != null) Tokens.Spacing.s else 0.dp).align(Alignment.Start),
                        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs),
                    ) {
                        message.attachments.forEach { attachment -> AttachmentView(attachment, textColor, onOpenFailed) }
                    }
                }
                Row(
                    Modifier.padding(top = Tokens.Spacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs),
                ) {
                    if (isNote) {
                        Icon(Icons.Outlined.Lock, contentDescription = null, tint = metaColor, modifier = Modifier.size(12.dp))
                        Text(stringResource(R.string.welddesk_conversation_internal_note), fontSize = 11.sp, lineHeight = 16.sp, color = metaColor)
                        Text("·", fontSize = 11.sp, lineHeight = 16.sp, color = metaColor)
                    }
                    message.createdAt?.let {
                        Text(agoText(it, now, zone), fontSize = 11.sp, lineHeight = 16.sp, color = metaColor)
                    }
                }
            }
            if (!isVisitor) InitialAvatar(label, url = member?.picture, size = 24.dp, bot = isBot)
        }
    }
}

/** The visitor is typing: three dots in a grey bubble, and who. */
@Composable
fun TypingBubble(name: String) {
    val colors = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth().padding(start = Tokens.Spacing.l, end = Tokens.Spacing.l, top = Tokens.Spacing.xs, bottom = Tokens.Spacing.s).tagged("typing"),
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        Spacer(Modifier.width(24.dp))
        Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs)) {
            Row(
                Modifier.background(colors.surfaceVariant, RoundedCornerShape(Tokens.Radius.xlarge)).padding(horizontal = 14.dp, vertical = Tokens.Spacing.m),
                horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs),
            ) {
                repeat(3) { Box(Modifier.size(6.dp).background(colors.onSurfaceVariant.copy(alpha = 0.6f), CircleShape)) }
            }
            Text(stringResource(R.string.welddesk_conversation_typing, name), fontSize = 11.sp, lineHeight = 16.sp, color = colors.onSurfaceVariant)
        }
    }
}

/** An image as a thumbnail, any other file as a link with its size; both open in the browser. */
@Composable
private fun AttachmentView(attachment: Attachment, textColor: Color, onOpenFailed: () -> Unit) {
    val context = LocalContext.current
    val name = attachment.name?.takeIf { it.isNotBlank() } ?: stringResource(R.string.welddesk_conversation_attachment)
    val open = {
        if (!DeskLogic.isOpenableUrl(attachment.url)) {
            onOpenFailed()
        } else {
            try {
                context.startActivity(Intent(Intent.ACTION_VIEW, attachment.url.trim().toUri()))
            } catch (_: ActivityNotFoundException) {
                onOpenFailed()
            }
        }
    }
    if (DeskLogic.isImage(attachment.contentType) && DeskLogic.isOpenableUrl(attachment.url)) {
        // At most 192 high (`max-h-48`), in the picture's own proportions when known.
        val ratio = attachment.width?.takeIf { it > 0 }?.let { width -> attachment.height?.takeIf { it > 0 }?.let { width / it } } ?: 1.0
        val height = min(192.0, 220.0 / ratio)
        AsyncImage(
            model = attachment.url,
            contentDescription = name,
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .size(width = (height * ratio).dp, height = height.dp)
                .clip(RoundedCornerShape(Tokens.Radius.large))
                .background(MaterialTheme.colorScheme.surfaceVariant)
                .clickable(onClick = open)
                .tagged("attachment-image"),
        )
        return
    }
    val size = DeskLogic.formatFileSize(attachment.size)
    Row(
        Modifier
            .clickable(onClick = open)
            .semantics { contentDescription = name }
            .tagged("attachment-file"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs),
    ) {
        Icon(Icons.Outlined.AttachFile, contentDescription = null, tint = textColor, modifier = Modifier.size(12.dp))
        Text(
            name,
            color = textColor,
            fontSize = 12.sp,
            fontWeight = FontWeight.Normal,
            textDecoration = TextDecoration.Underline,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (size.isNotEmpty()) {
            Text("· $size", color = textColor.copy(alpha = 0.7f), fontSize = 12.sp, maxLines = 1)
        }
    }
}
