package com.weldsuite.weldchat.ui.channel

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.ChannelNames
import com.weldsuite.weldchat.ChannelRules
import com.weldsuite.weldchat.ChatChannel
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.ui.BackButton
import com.weldsuite.weldchat.ui.ChatNavigator
import com.weldsuite.weldchat.ui.ListHeader
import com.weldsuite.weldchat.ui.LocalNotify
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.weldsuite.core.api.ApiException
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import org.weldsuite.core.R as CoreR

private enum class Busy { RENAME, LEAVE, DELETE }

/**
 * A channel's details (the iOS `ChannelInfoView`): its icon and name
 * (renamed in place by an owner or admin), public or private, the
 * description, how many members, and leave or delete. Leaving and deleting
 * go back to the tab's root and reload Home.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelInfoScreen(
    store: ChatStore,
    userId: String,
    channelId: String,
    initialName: String,
    nav: ChatNavigator,
) {
    val notify = LocalNotify.current
    val scope = rememberCoroutineScope()
    var channel by remember { mutableStateOf<ChatChannel?>(null) }
    var loading by remember { mutableStateOf(true) }
    var renaming by remember { mutableStateOf(false) }
    var draftName by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf<Busy?>(null) }
    var confirmLeave by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    val displayName = channel?.name ?: initialName

    val renamed = stringResource(R.string.weldchat_channel_info_renamed)
    val renameTaken = stringResource(R.string.weldchat_channel_info_rename_taken)
    val renameFailed = stringResource(R.string.weldchat_channel_info_rename_failed)
    val left = stringResource(R.string.weldchat_channel_info_left, displayName)
    val leaveFailed = stringResource(R.string.weldchat_channel_info_leave_failed)
    val deleted = stringResource(R.string.weldchat_channel_info_deleted)
    val deleteFailed = stringResource(R.string.weldchat_channel_info_delete_failed)

    suspend fun load() {
        loading = true
        try {
            channel = store.repository.channel(channelId)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // The retry screen shows.
        }
        loading = false
    }

    fun submitRename(current: ChatChannel) {
        val next = ChannelNames.trimDashes(draftName)
        if (busy != null || next.isEmpty()) return
        if (next == current.name) {
            renaming = false
            return
        }
        busy = Busy.RENAME
        scope.launch {
            try {
                store.repository.renameChannel(current.id, next)
                channel = channel?.copy(name = next)
                renaming = false
                notify(renamed)
                store.loadHome()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                notify(if ((error as? ApiException)?.status == 409) renameTaken else renameFailed)
            } finally {
                busy = null
            }
        }
    }

    /** Leave or delete, then back to the tab's root; Home reloads on the app's scope (this screen is gone by then). */
    fun leaveOrDelete(kind: Busy) {
        busy = kind
        scope.launch {
            try {
                if (kind == Busy.LEAVE) store.repository.leaveChannel(channelId) else store.repository.deleteChannel(channelId)
                notify(if (kind == Busy.LEAVE) left else deleted)
                nav.popToRoot()
                store.env.scope.launch { store.loadHome() }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                notify(if (kind == Busy.LEAVE) leaveFailed else deleteFailed)
                busy = null
            }
        }
    }

    LaunchedEffect(channelId) { load() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.weldchat_channel_info_title)) },
                navigationIcon = { BackButton(onClick = { nav.back() }) },
            )
        },
    ) { padding ->
        val current = channel
        when {
            current != null -> InfoContent(
                channel = current,
                userId = userId,
                name = displayName,
                renaming = renaming,
                draftName = draftName,
                busy = busy,
                modifier = Modifier.padding(padding),
                onDraftName = { draftName = ChannelNames.normalize(it) },
                onStartRename = {
                    draftName = current.name
                    renaming = true
                },
                onCancelRename = { renaming = false },
                onSubmitRename = { submitRename(current) },
                onLeave = { confirmLeave = true },
                onDelete = { confirmDelete = true },
            )
            loading -> Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.tagged("channel-info-loading"))
            }
            else -> Column(
                Modifier.padding(padding).fillMaxSize().padding(Tokens.Spacing.xl),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m, Alignment.CenterVertically),
            ) {
                Text(stringResource(CoreR.string.core_errors_load_failed), style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
                Text(
                    stringResource(R.string.weldchat_channel_info_load_failed),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
                TextButton(onClick = { scope.launch { load() } }, modifier = Modifier.tagged("retry")) {
                    Text(stringResource(CoreR.string.core_common_try_again))
                }
            }
        }
    }

    if (confirmLeave) {
        ConfirmChannelAction(
            title = stringResource(R.string.weldchat_channel_info_leave_title, displayName),
            body = stringResource(R.string.weldchat_channel_info_leave_body),
            confirm = stringResource(R.string.weldchat_channel_info_leave),
            onDismiss = { confirmLeave = false },
        ) {
            confirmLeave = false
            leaveOrDelete(Busy.LEAVE)
        }
    }
    if (confirmDelete) {
        ConfirmChannelAction(
            title = stringResource(R.string.weldchat_channel_info_delete_title, displayName),
            body = stringResource(R.string.weldchat_channel_info_delete_body),
            confirm = stringResource(R.string.weldchat_channel_info_delete),
            onDismiss = { confirmDelete = false },
        ) {
            confirmDelete = false
            leaveOrDelete(Busy.DELETE)
        }
    }
}

@Composable
private fun InfoContent(
    channel: ChatChannel,
    userId: String,
    name: String,
    renaming: Boolean,
    draftName: String,
    busy: Busy?,
    modifier: Modifier,
    onDraftName: (String) -> Unit,
    onStartRename: () -> Unit,
    onCancelRename: () -> Unit,
    onSubmitRename: () -> Unit,
    onLeave: () -> Unit,
    onDelete: () -> Unit,
) {
    val permissions = ChannelRules.permissions(channel.members, userId)
    val description = listOfNotNull(channel.description, channel.topic).firstOrNull { it.isNotEmpty() }
    LazyColumn(modifier.fillMaxSize().tagged("channel-info")) {
        item("header") {
            Column(
                Modifier.fillMaxWidth().padding(Tokens.Spacing.xl),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
            ) {
                Box(
                    Modifier
                        .size(64.dp)
                        .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(Tokens.Radius.large)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(if (channel.isPrivate) Icons.Filled.Lock else Icons.Filled.Tag, contentDescription = null, modifier = Modifier.size(28.dp))
                }
                if (renaming) {
                    RenameField(draftName, busy == Busy.RENAME, onDraftName, onSubmitRename, onCancelRename)
                } else {
                    Text("#$name", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, maxLines = 2)
                }
                Text(
                    stringResource(if (channel.isPrivate) R.string.weldchat_channel_info_private_channel else R.string.weldchat_channel_info_public_channel),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        item("description") {
            Column {
                ListHeader(stringResource(R.string.weldchat_channel_info_description))
                Text(
                    description ?: stringResource(R.string.weldchat_channel_info_no_description),
                    color = if (description == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
                )
            }
        }
        item("members") {
            val count = channel.memberCount ?: channel.members.size
            Column {
                ListHeader(stringResource(R.string.weldchat_channel_info_members))
                ListItem(
                    headlineContent = { Text(pluralStringResource(R.plurals.weldchat_channel_info_member_count, count, count)) },
                    leadingContent = { Icon(Icons.Filled.Group, contentDescription = null) },
                )
            }
        }
        if (permissions.showActions) {
            item("actions") {
                Column {
                ListHeader(stringResource(R.string.weldchat_channel_info_actions))
                if (permissions.canManage) {
                    ActionItem(R.string.weldchat_channel_info_rename, Icons.Filled.Edit, "channel-info-rename", busy == null, false, false, onStartRename)
                }
                if (permissions.canLeave) {
                    ActionItem(R.string.weldchat_channel_info_leave, Icons.AutoMirrored.Filled.Logout, "channel-info-leave", busy == null, true, busy == Busy.LEAVE, onLeave)
                }
                if (permissions.canManage) {
                    ActionItem(R.string.weldchat_channel_info_delete, Icons.Filled.Delete, "channel-info-delete", busy == null, true, busy == Busy.DELETE, onDelete)
                }
                if (permissions.isOwner) {
                    Text(
                        stringResource(R.string.weldchat_channel_info_owner_cannot_leave),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
                    )
                }
                }
            }
        }
    }
}

/** The name, lower case with dashes as it is typed, saved with ✓. */
@Composable
private fun RenameField(value: String, saving: Boolean, onChange: (String) -> Unit, onSubmit: () -> Unit, onCancel: () -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    val canSave = ChannelNames.trimDashes(value).isNotEmpty()
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs)) {
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            label = { Text(stringResource(R.string.weldchat_channel_info_rename_label)) },
            placeholder = { Text(stringResource(R.string.weldchat_channel_info_rename_placeholder)) },
            leadingIcon = { Icon(Icons.Filled.Tag, contentDescription = null) },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { onSubmit() }),
            modifier = Modifier.weight(1f).focusRequester(focus).tagged("channel-info-rename-input"),
        )
        if (saving) {
            CircularProgressIndicator(Modifier.size(24.dp))
        } else {
            IconButton(onClick = onSubmit, enabled = canSave, modifier = Modifier.tagged("channel-info-rename-save")) {
                Icon(Icons.Filled.Check, contentDescription = stringResource(CoreR.string.core_common_save))
            }
            IconButton(onClick = onCancel) {
                Icon(Icons.Filled.Close, contentDescription = stringResource(CoreR.string.core_common_cancel))
            }
        }
    }
}

@Composable
private fun ActionItem(label: Int, icon: androidx.compose.ui.graphics.vector.ImageVector, tag: String, enabled: Boolean, destructive: Boolean, working: Boolean, onClick: () -> Unit) {
    val base = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
    val color = if (enabled) base else base.copy(alpha = 0.38f)
    ListItem(
        headlineContent = { Text(stringResource(label), color = color) },
        leadingContent = { Icon(icon, contentDescription = null, tint = color) },
        trailingContent = if (working) {
            { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) }
        } else {
            null
        },
        modifier = Modifier.clickable(enabled = enabled, onClick = onClick).tagged(tag),
    )
}

@Composable
private fun ConfirmChannelAction(title: String, body: String, confirm: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(body) },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.tagged("confirm")) { Text(confirm, color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(CoreR.string.core_common_cancel)) } },
    )
}
