package com.weldsuite.weldchat.ui.channel

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.filled.AllInclusive
import androidx.compose.material.icons.filled.AddReaction
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.weldsuite.weldchat.ChannelRules
import com.weldsuite.weldchat.ChatLogic
import com.weldsuite.weldchat.ChatMessage
import com.weldsuite.weldchat.PinDuration
import com.weldsuite.weldchat.R
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/**
 * What a held message offers: six quick reactions and more, reply, reply
 * in a thread, copy, pin or unpin, save, and edit and delete on your own.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessageActionsSheet(
    message: ChatMessage,
    isOwn: Boolean,
    onDismiss: () -> Unit,
    onQuickReact: (String) -> Unit,
    onMoreReactions: () -> Unit,
    onReply: () -> Unit,
    onThread: () -> Unit,
    onCopy: () -> Unit,
    onPin: () -> Unit,
    onSave: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = Tokens.Spacing.m)) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.s, vertical = Tokens.Spacing.s),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                ChatLogic.quickEmojis.forEachIndexed { index, emoji ->
                    EmojiButton(emoji, "quick-react-$index") { onQuickReact(emoji) }
                }
                val more = stringResource(R.string.weldchat_message_actions_more_reactions)
                Box(
                    Modifier
                        .size(44.dp)
                        .background(MaterialTheme.colorScheme.surfaceVariant, CircleShape)
                        .clickable(onClick = onMoreReactions)
                        .semantics { contentDescription = more }
                        .tagged("action-more-reactions"),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.AddReaction, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            HorizontalDivider()
            ActionRow(R.string.weldchat_message_actions_reply, Icons.AutoMirrored.Filled.Reply, "action-reply", onClick = onReply)
            ActionRow(R.string.weldchat_message_actions_reply_in_thread, Icons.Filled.Forum, "action-thread", onClick = onThread)
            if (ChannelRules.canCopy(message)) {
                ActionRow(R.string.weldchat_message_actions_copy_text, Icons.Filled.ContentCopy, "action-copy", onClick = onCopy)
            }
            ActionRow(
                if (message.isPinned) R.string.weldchat_message_actions_unpin else R.string.weldchat_message_actions_pin,
                if (message.isPinned) Icons.Filled.PushPin else Icons.Outlined.PushPin,
                "action-pin",
                onClick = onPin,
            )
            ActionRow(R.string.weldchat_message_actions_save, Icons.Filled.Bookmark, "action-save", onClick = onSave)
            if (isOwn && !message.isSystem) {
                ActionRow(R.string.weldchat_message_actions_edit, Icons.Filled.Edit, "action-edit", onClick = onEdit)
            }
            if (isOwn) {
                HorizontalDivider()
                ActionRow(R.string.weldchat_message_actions_delete, Icons.Filled.Delete, "action-delete", destructive = true, onClick = onDelete)
            }
        }
    }
}

@Composable
private fun EmojiButton(emoji: String, tag: String, onClick: () -> Unit) {
    Box(
        Modifier
            .size(44.dp)
            .background(MaterialTheme.colorScheme.surfaceVariant, CircleShape)
            .clickable(onClick = onClick)
            .tagged(tag),
        contentAlignment = Alignment.Center,
    ) {
        Text(emoji, fontSize = 24.sp)
    }
}

@Composable
private fun ActionRow(label: Int, icon: ImageVector, tag: String, destructive: Boolean = false, onClick: () -> Unit) {
    val color = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
    ListItem(
        headlineContent = { Text(stringResource(label), color = color) },
        leadingContent = { Icon(icon, contentDescription = null, tint = color) },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.clickable(onClick = onClick).tagged(tag),
    )
}

/** Every reaction, for "More reactions". */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReactionPickerSheet(onDismiss: () -> Unit, onSelect: (String) -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().padding(bottom = Tokens.Spacing.m)) {
            Text(
                stringResource(R.string.weldchat_message_actions_react_with_emoji),
                style = MaterialTheme.typography.titleMedium,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(bottom = Tokens.Spacing.m),
            )
            LazyVerticalGrid(
                columns = GridCells.Fixed(8),
                horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
                modifier = Modifier.padding(horizontal = Tokens.Spacing.l),
            ) {
                itemsIndexed(ChatLogic.emojiList) { index, emoji ->
                    Box(
                        Modifier
                            .aspectRatio(1f)
                            .clickable { onSelect(emoji) }
                            .tagged("emoji-$index"),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(emoji, fontSize = 28.sp)
                    }
                }
            }
        }
    }
}

/** Pinning: for how long, then whether the channel hears about it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PinMessageSheet(onDismiss: () -> Unit, onConfirm: (PinDuration, Boolean) -> Unit) {
    var duration by remember { mutableStateOf<PinDuration?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.navigationBarsPadding().padding(bottom = Tokens.Spacing.m)) {
            val chosen = duration
            Text(
                stringResource(if (chosen == null) R.string.weldchat_channel_pin_for_how_long else R.string.weldchat_channel_notify_others),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
            )
            if (chosen == null) {
                PinDuration.entries.forEach { choice ->
                    ListItem(
                        headlineContent = { Text(stringResource(choice.label)) },
                        leadingContent = {
                            Icon(if (choice == PinDuration.FOREVER) Icons.Filled.AllInclusive else Icons.Filled.Schedule, contentDescription = null)
                        },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                        modifier = Modifier.clickable { duration = choice }.tagged("pin-duration-${choice.key}"),
                    )
                }
            } else {
                PinOption(
                    title = R.string.weldchat_channel_pin_with_alert,
                    hint = R.string.weldchat_channel_pin_with_alert_hint,
                    icon = Icons.Filled.Notifications,
                    tag = "pin-notify",
                ) { onConfirm(chosen, true) }
                PinOption(
                    title = R.string.weldchat_channel_pin_silently,
                    hint = R.string.weldchat_channel_pin_silently_hint,
                    icon = Icons.Filled.NotificationsOff,
                    tag = "pin-silent",
                ) { onConfirm(chosen, false) }
            }
        }
    }
}

@Composable
private fun PinOption(title: Int, hint: Int, icon: ImageVector, tag: String, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(stringResource(title)) },
        supportingContent = { Text(stringResource(hint)) },
        leadingContent = { Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary) },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.clickable(onClick = onClick).tagged(tag),
    )
}
