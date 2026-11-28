package com.weldsuite.welddesk.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Description
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import coil.compose.AsyncImage
import com.weldsuite.welddesk.Attachment
import com.weldsuite.welddesk.AuthorType
import com.weldsuite.welddesk.Conversation
import com.weldsuite.welddesk.ConversationState
import com.weldsuite.welddesk.DeskChannel
import com.weldsuite.welddesk.DeskLogic
import com.weldsuite.welddesk.Message
import com.weldsuite.welddesk.MessageKind
import com.weldsuite.welddesk.R
import org.weldsuite.core.WeldDate
import org.weldsuite.ui.StatusBadge
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

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

@Composable
fun ChannelBadge(conversation: Conversation) {
    StatusBadge(channelName(conversation.channel, conversation.channelValue), MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
fun StateBadge(state: ConversationState) {
    if (state == ConversationState.OPEN) {
        StatusBadge(stringResource(R.string.welddesk_inbox_open), Tokens.Palette.primary.current())
    } else {
        StatusBadge(stringResource(R.string.welddesk_inbox_closed), MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** One timeline entry: an event line, or a bubble (the agent's on the right). */
@Composable
fun MessageRow(message: Message, onOpenFailed: () -> Unit) {
    if (message.kind == MessageKind.EVENT) {
        Column(
            Modifier.fillMaxWidth().padding(vertical = Tokens.Spacing.s).tagged("event-${message.id}"),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(eventLabel(message), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            message.createdAt?.let {
                Text(WeldDate.short(it), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        return
    }
    val fromAgent = message.authorType == AuthorType.AGENT || message.authorType == AuthorType.BOT
    val isNote = message.kind == MessageKind.NOTE
    val onBrand = fromAgent && !isNote
    val brand = Tokens.Palette.primary.current()
    val background = when {
        isNote -> Tokens.Status.warning.current().copy(alpha = 0.15f)
        fromAgent -> brand
        else -> MaterialTheme.colorScheme.surfaceVariant
    }
    val textColor = if (onBrand) Color.White else MaterialTheme.colorScheme.onSurface
    val mutedColor = if (onBrand) Color.White.copy(alpha = 0.8f) else MaterialTheme.colorScheme.onSurfaceVariant
    BoxWithConstraints(Modifier.fillMaxWidth(), contentAlignment = if (fromAgent) Alignment.CenterEnd else Alignment.CenterStart) {
        Column(
            Modifier
                .widthIn(max = maxWidth * 0.85f)
                .background(background, RoundedCornerShape(Tokens.Radius.large))
                .padding(horizontal = Tokens.Spacing.m, vertical = Tokens.Spacing.s)
                .tagged("message-${message.id}"),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            val author = authorLabel(message.authorType)
            Text(
                if (isNote) "$author · ${stringResource(R.string.welddesk_conversation_note)}" else author,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
                color = mutedColor,
            )
            val body = message.body?.takeIf { it.isNotEmpty() }
            if (body != null || message.attachments.isEmpty()) {
                Text(body ?: stringResource(R.string.welddesk_common_dash), style = MaterialTheme.typography.bodyLarge, color = textColor)
            }
            message.attachments.forEach { attachment -> AttachmentView(attachment, onBrand, onOpenFailed) }
            message.createdAt?.let {
                Text(
                    WeldDate.short(it),
                    style = MaterialTheme.typography.labelSmall,
                    color = mutedColor,
                    modifier = Modifier.align(Alignment.End),
                )
            }
        }
    }
}

@Composable
private fun eventLabel(message: Message): String = when (message.eventType) {
    "closed" -> stringResource(R.string.welddesk_conversation_closed_event)
    "reopened" -> stringResource(R.string.welddesk_conversation_reopened_event)
    "assigned" -> stringResource(R.string.welddesk_conversation_assigned_event)
    "unassigned" -> stringResource(R.string.welddesk_conversation_unassigned_event)
    "rated" -> stringResource(R.string.welddesk_conversation_rated_event, message.rating?.toString() ?: "?")
    else -> message.body?.takeIf { it.isNotBlank() } ?: stringResource(R.string.welddesk_conversation_system)
}

@Composable
private fun authorLabel(type: AuthorType): String = when (type) {
    AuthorType.VISITOR -> stringResource(R.string.welddesk_conversation_visitor)
    AuthorType.BOT -> stringResource(R.string.welddesk_conversation_bot)
    AuthorType.SYSTEM -> stringResource(R.string.welddesk_conversation_system)
    AuthorType.AGENT -> stringResource(R.string.welddesk_conversation_agent)
}

/** An image as a thumbnail, any other file as a row with its size; both open in the browser. */
@Composable
private fun AttachmentView(attachment: Attachment, onBrand: Boolean, onOpenFailed: () -> Unit) {
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
    val rowBackground = if (onBrand) Color.White.copy(alpha = 0.18f) else MaterialTheme.colorScheme.surface
    if (DeskLogic.isImage(attachment.contentType) && DeskLogic.isOpenableUrl(attachment.url)) {
        AsyncImage(
            model = attachment.url,
            contentDescription = name,
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .padding(top = Tokens.Spacing.xs)
                .size(160.dp)
                .clip(RoundedCornerShape(Tokens.Radius.medium))
                .background(rowBackground)
                .clickable(onClick = open)
                .tagged("attachment-image"),
        )
        return
    }
    val textColor = if (onBrand) Color.White else MaterialTheme.colorScheme.onSurface
    val size = DeskLogic.formatFileSize(attachment.size)
    Row(
        Modifier
            .padding(top = Tokens.Spacing.xs)
            .widthIn(min = 160.dp)
            .clip(RoundedCornerShape(Tokens.Radius.medium))
            .background(rowBackground)
            .clickable(onClick = open)
            .padding(horizontal = 10.dp, vertical = Tokens.Spacing.s)
            .semantics { contentDescription = name }
            .tagged("attachment-file"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        Icon(Icons.Outlined.Description, contentDescription = null, tint = textColor, modifier = Modifier.size(18.dp))
        Column {
            Text(name, color = textColor, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (size.isNotEmpty()) {
                Text(size, color = textColor.copy(alpha = 0.75f), style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}
