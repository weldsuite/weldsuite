package com.weldsuite.weldchat.ui

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.AddCircleOutline
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Drafts
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.RemoveCircleOutline
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import org.weldsuite.ui.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.ChatChannel
import com.weldsuite.weldchat.ChatLogic
import com.weldsuite.weldchat.ChatRepository
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.ConversationPatch
import com.weldsuite.weldchat.DmConversation
import com.weldsuite.weldchat.NotificationLevel
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.RecordChat
import com.weldsuite.weldchat.RecordChatRules
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.weldsuite.ui.tagged

/** What a conversation's long-press menu acts on. */
sealed interface ConversationTarget {
    val id: String

    data class Channel(val channel: ChatChannel) : ConversationTarget {
        override val id: String get() = channel.id
    }

    data class Dm(val dm: DmConversation) : ConversationTarget {
        override val id: String get() = dm.id
    }

    data class Record(val chat: RecordChat) : ConversationTarget {
        override val id: String get() = chat.id
    }
}

/**
 * The long-press menu of a channel, DM or record chat, as in Slack and
 * Discord: mark read, mute, notifications, pin, invite, copy link, details,
 * archive, open the record, follow. Changes show at once (through
 * [onChange]) and are put back, with a message, when the request fails.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationMenuSheet(
    target: ConversationTarget,
    store: ChatStore,
    nav: ChatNavigator,
    onChange: (String, ConversationPatch) -> Unit,
    onDismiss: () -> Unit,
) {
    val notify = LocalNotify.current
    val context = LocalContext.current
    val failed = stringResource(R.string.weldchat_conversation_menu_failed)
    val linkCopied = stringResource(R.string.weldchat_conversation_menu_link_copied)
    var level by remember(target.id) { mutableStateOf(store.cachedMembership(target.id)?.notificationPreference) }
    // The notification level, loaded as the menu opens so it can be ticked.
    LaunchedEffect(target.id) {
        if (target is ConversationTarget.Record && !target.chat.isFollowing) return@LaunchedEffect
        level = runCatching { store.membership(target.id) }.getOrNull()?.notificationPreference ?: level
    }

    fun apply(patch: ConversationPatch, revert: ConversationPatch, request: suspend () -> Unit) {
        val id = target.id
        onChange(id, patch)
        onDismiss()
        store.env.scope.launch {
            try {
                request()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                onChange(id, revert)
                notify(failed)
            }
        }
    }

    fun markRead() = apply(ConversationPatch(hasUnread = false), ConversationPatch(hasUnread = true)) { store.repository.markRead(target.id) }

    fun mute(muted: Boolean) = apply(ConversationPatch(isMuted = !muted), ConversationPatch(isMuted = muted)) {
        store.updateMembership(target.id, isMuted = !muted)
    }

    fun setLevel(next: NotificationLevel) {
        level = next
        store.env.scope.launch {
            try {
                store.updateMembership(target.id, level = next)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                notify(failed)
            }
        }
    }

    fun copyLink(isDm: Boolean, peer: String?) {
        copyText(context, ChatLogic.conversationWebUrl(store.env.serverOrigin, target.id, isDm, peer))
        notify(linkCopied)
        onDismiss()
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 8.dp)) {
            when (target) {
                is ConversationTarget.Channel -> {
                    val channel = target.channel
                    MenuRow(R.string.weldchat_conversation_menu_mark_read, Icons.Filled.Drafts, "menu-mark-read", enabled = ChatLogic.isChannelUnread(channel)) { markRead() }
                    MenuRow(R.string.weldchat_conversation_menu_invite, Icons.Filled.PersonAdd, "menu-invite") {
                        onDismiss()
                        nav.invitePeople(channel.id, channel.name)
                    }
                    MenuRow(R.string.weldchat_conversation_menu_copy_link, Icons.Filled.Link, "menu-copy-link") { copyLink(false, null) }
                    MuteRow(channel.isMuted) { mute(channel.isMuted) }
                    LevelRows(level) { setLevel(it) }
                    MenuRow(R.string.weldchat_conversation_menu_channel_details, Icons.Filled.Info, "menu-details") {
                        onDismiss()
                        nav.openChannelInfo(channel.id, channel.name)
                    }
                }
                is ConversationTarget.Dm -> {
                    val dm = target.dm
                    MenuRow(R.string.weldchat_conversation_menu_mark_read, Icons.Filled.Drafts, "menu-mark-read", enabled = dm.hasUnread) { markRead() }
                    MenuRow(
                        if (dm.isPinned) R.string.weldchat_conversation_menu_unpin else R.string.weldchat_conversation_menu_pin,
                        if (dm.isPinned) Icons.Outlined.PushPin else Icons.Filled.PushPin,
                        "menu-pin",
                    ) {
                        apply(ConversationPatch(isPinned = !dm.isPinned), ConversationPatch(isPinned = dm.isPinned)) {
                            store.repository.pinDm(dm.id, !dm.isPinned)
                        }
                    }
                    MuteRow(dm.isMuted) { mute(dm.isMuted) }
                    LevelRows(level) { setLevel(it) }
                    dm.peerUserId?.let { peer ->
                        MenuRow(R.string.weldchat_conversation_menu_view_profile, Icons.Filled.AccountCircle, "menu-profile") {
                            onDismiss()
                            nav.openMember(peer)
                        }
                    }
                    MenuRow(R.string.weldchat_conversation_menu_copy_link, Icons.Filled.Link, "menu-copy-link") { copyLink(true, dm.peerUserId) }
                    MenuRow(R.string.weldchat_conversation_menu_archive, Icons.Filled.Archive, "menu-archive") {
                        apply(ConversationPatch(archived = true), ConversationPatch(archived = false)) { store.repository.setArchived(dm.id, true) }
                    }
                }
                is ConversationTarget.Record -> {
                    val chat = target.chat
                    MenuRow(
                        R.string.weldchat_conversation_menu_mark_read,
                        Icons.Filled.Drafts,
                        "menu-mark-read",
                        enabled = chat.isFollowing && RecordChatRules.needsAttention(chat),
                    ) { markRead() }
                    RecordChatRules.app(chat.entityType)?.let { app ->
                        ListItem(
                            headlineContent = { Text(stringResource(R.string.weldchat_record_chats_open_in, app)) },
                            leadingContent = { Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = null) },
                            modifier = Modifier.clickable {
                                onDismiss()
                                store.env.scope.launch { RecordOpener.open(context, chat.entityType, chat.entityId, store.repository, notify) }
                            }.tagged("menu-open-record"),
                        )
                    }
                    MenuRow(R.string.weldchat_conversation_menu_copy_link, Icons.Filled.Link, "menu-copy-link") { copyLink(false, null) }
                    if (chat.isFollowing) {
                        MuteRow(chat.isMuted) { mute(chat.isMuted) }
                        LevelRows(level) { setLevel(it) }
                    }
                    MenuRow(
                        if (chat.isFollowing) R.string.weldchat_record_chats_unfollow else R.string.weldchat_record_chats_follow,
                        if (chat.isFollowing) Icons.Filled.RemoveCircleOutline else Icons.Filled.AddCircleOutline,
                        "menu-follow",
                    ) {
                        val next = !chat.isFollowing
                        store.forgetMembership(chat.id)
                        apply(ConversationPatch(isFollowing = next), ConversationPatch(isFollowing = !next)) {
                            store.repository.setFollowing(chat.entityType, chat.entityId, next)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MenuRow(label: Int, icon: ImageVector, tag: String, enabled: Boolean = true, onClick: () -> Unit) {
    val tint = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
    ListItem(
        headlineContent = { Text(stringResource(label), color = tint) },
        leadingContent = { Icon(icon, contentDescription = null, tint = tint) },
        modifier = Modifier.clickable(enabled = enabled, onClick = onClick).tagged(tag),
    )
}

@Composable
private fun MuteRow(muted: Boolean, onClick: () -> Unit) {
    MenuRow(
        if (muted) R.string.weldchat_conversation_menu_unmute else R.string.weldchat_conversation_menu_mute,
        if (muted) Icons.Filled.Notifications else Icons.Filled.NotificationsOff,
        "menu-mute",
        onClick = onClick,
    )
}

/** The notification level, the current one ticked. */
@Composable
private fun LevelRows(current: NotificationLevel?, onPick: (NotificationLevel) -> Unit) {
    ListItem(
        headlineContent = { Text(stringResource(R.string.weldchat_conversation_menu_notifications), style = MaterialTheme.typography.labelLarge) },
        leadingContent = { Icon(Icons.Filled.Notifications, contentDescription = null) },
    )
    listOf(
        NotificationLevel.ALL to R.string.weldchat_conversation_menu_notify_all,
        NotificationLevel.MENTIONS to R.string.weldchat_conversation_menu_notify_mentions,
        NotificationLevel.NONE to R.string.weldchat_conversation_menu_notify_none,
    ).forEach { (level, label) ->
        ListItem(
            headlineContent = { Text(stringResource(label)) },
            leadingContent = { if (current == level) Icon(Icons.Filled.Check, contentDescription = null) else Text("") },
            modifier = Modifier.clickable { onPick(level) }.tagged("menu-notify-${level.wire}"),
        )
    }
}

/** Put [text] on the clipboard. */
fun copyText(context: Context, text: String) {
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("WeldChat", text))
}

/** Opens a record chat's record in its own app (WeldCRM, WeldFlow); says so when it can't. */
object RecordOpener {
    suspend fun open(context: Context, type: String, entityId: String, repository: ChatRepository, notify: (String) -> Unit) {
        val app = RecordChatRules.app(type) ?: return
        val projectId = if (type == "task") repository.recordProjectId(type, entityId) else null
        val link = RecordChatRules.appLink(type, entityId, projectId)
        if (link == null) {
            notify(context.getString(R.string.weldchat_record_chats_open_failed, app))
            return
        }
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            notify(context.getString(R.string.weldchat_record_chats_app_missing_title, app))
        }
    }
}
