package com.weldsuite.weldchat.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.ChatDates
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.ConversationPatch
import com.weldsuite.weldchat.DmConversation
import com.weldsuite.weldchat.DmLogic
import com.weldsuite.weldchat.MentionText
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.text
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import org.weldsuite.core.R as CoreR

/**
 * Direct messages: All / Unread / Favourites / Muted, pinned first then the
 * newest; swipe to mute or pin, archive or delete; hold for the menu.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun DmsScreen(store: ChatStore, nav: ChatNavigator) {
    val scope = rememberCoroutineScope()
    var filter by remember { mutableStateOf(DmLogic.Filter.ALL) }
    var refreshing by remember { mutableStateOf(false) }
    var menuTarget by remember { mutableStateOf<ConversationTarget?>(null) }
    var composeOpen by remember { mutableStateOf(false) }
    val rows = DmLogic.sorted(store.dms, filter)
    val names = store.memberNames

    LaunchedEffect(Unit) {
        store.loadDmList()
        store.loadRosterIfNeeded()
    }

    fun change(dm: DmConversation, patch: ConversationPatch, revert: ConversationPatch, request: suspend () -> Unit) {
        store.patchDm(dm.id, patch)
        store.env.scope.launch {
            try {
                request()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                store.patchDm(dm.id, revert)
            }
        }
    }

    fun drop(dm: DmConversation, request: suspend () -> Unit) {
        store.removeDm(dm.id)
        store.env.scope.launch {
            try {
                request()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                store.loadDmList()
            }
        }
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text(stringResource(R.string.weldchat_tabs_direct_messages)) }) },
        floatingActionButton = {
            Box {
                FloatingActionButton(onClick = { composeOpen = true }, modifier = Modifier.tagged("dms-compose")) {
                    Icon(Icons.Filled.Edit, contentDescription = stringResource(R.string.weldchat_dms_new_dm))
                }
                DropdownMenu(expanded = composeOpen, onDismissRequest = { composeOpen = false }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.weldchat_home_compose_message)) },
                        leadingIcon = { Icon(Icons.Filled.Edit, contentDescription = null) },
                        onClick = {
                            composeOpen = false
                            nav.newMessage()
                        },
                        modifier = Modifier.tagged("compose-message"),
                    )
                    DropdownMenuItem(
                        text = {
                            Column {
                                Text(stringResource(R.string.weldchat_dms_compose_group))
                                Text(stringResource(R.string.weldchat_dms_compose_group_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        },
                        leadingIcon = { Icon(Icons.Filled.Groups, contentDescription = null) },
                        onClick = {
                            composeOpen = false
                            nav.newDm(group = true)
                        },
                        modifier = Modifier.tagged("compose-group"),
                    )
                }
            }
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                scope.launch {
                    refreshing = true
                    store.loadDmList()
                    refreshing = false
                }
            },
            modifier = Modifier.padding(padding).fillMaxSize(),
        ) {
            LazyColumn(Modifier.fillMaxSize().tagged("dms-list")) {
                item("search") {
                    SearchButton(onClick = { nav.openSearch() }, modifier = Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s).tagged("dms-search"))
                }
                item("filters") {
                    Row(
                        Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = Tokens.Spacing.l),
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                    ) {
                        listOf(
                            DmLogic.Filter.ALL to R.string.weldchat_dms_filter_all,
                            DmLogic.Filter.UNREAD to R.string.weldchat_dms_filter_unread,
                            DmLogic.Filter.FAVOURITES to R.string.weldchat_dms_filter_favourites,
                            DmLogic.Filter.MUTED to R.string.weldchat_dms_filter_muted,
                        ).forEach { (value, label) ->
                            FilterChip(
                                selected = filter == value,
                                onClick = { filter = value },
                                label = { Text(stringResource(label)) },
                                modifier = Modifier.tagged("dms-filter-${value.wire}"),
                            )
                        }
                    }
                }
                when {
                    !store.dmsLoaded && store.dms.isEmpty() -> item("loading") {
                        Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.xl), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                    }
                    rows.isEmpty() -> item("empty") {
                        EmptyState(stringResource(R.string.weldchat_dms_empty_title), stringResource(R.string.weldchat_dms_empty_hint))
                    }
                    else -> items(rows, key = { it.id }) { dm ->
                        SwipeActions(
                            start = listOf(
                                SwipeAction(
                                    stringResource(if (dm.isMuted) R.string.weldchat_dms_unmute else R.string.weldchat_dms_mute),
                                    if (dm.isMuted) Icons.Filled.Notifications else Icons.Filled.NotificationsOff,
                                    Color(0xFF6B7280),
                                    "dm-swipe-mute-${dm.id}",
                                ) {
                                    change(dm, ConversationPatch(isMuted = !dm.isMuted), ConversationPatch(isMuted = dm.isMuted)) {
                                        store.updateMembership(dm.id, isMuted = !dm.isMuted)
                                    }
                                },
                                SwipeAction(
                                    stringResource(if (dm.isPinned) R.string.weldchat_dms_unpin else R.string.weldchat_dms_pin),
                                    if (dm.isPinned) Icons.Outlined.PushPin else Icons.Filled.PushPin,
                                    MaterialTheme.colorScheme.primary,
                                    "dm-swipe-pin-${dm.id}",
                                ) {
                                    change(dm, ConversationPatch(isPinned = !dm.isPinned), ConversationPatch(isPinned = dm.isPinned)) {
                                        store.repository.pinDm(dm.id, !dm.isPinned)
                                    }
                                },
                            ),
                            end = listOf(
                                SwipeAction(stringResource(R.string.weldchat_dms_archive), Icons.Filled.Archive, Color(0xFFF59E0B), "dm-swipe-archive-${dm.id}") {
                                    drop(dm) { store.repository.setArchived(dm.id, true) }
                                },
                                SwipeAction(stringResource(CoreR.string.core_common_delete), Icons.Filled.Delete, MaterialTheme.colorScheme.error, "dm-swipe-delete-${dm.id}") {
                                    drop(dm) { store.repository.leaveDm(dm.id) }
                                },
                            ),
                        ) {
                            Box(
                                Modifier
                                    .combinedClickable(
                                        onClick = { nav.openConversation(dm.id, dm.name, "dm") },
                                        onLongClick = { menuTarget = ConversationTarget.Dm(dm) },
                                    )
                                    .tagged("dm-row-${dm.id}"),
                            ) { DmRow(dm, names) }
                        }
                    }
                }
                item("fab-space") { Box(Modifier.padding(40.dp)) }
            }
        }
    }

    menuTarget?.let { target ->
        ConversationMenuSheet(
            target = target,
            store = store,
            nav = nav,
            onChange = { id, patch ->
                if (patch.archived == false) store.env.scope.launch { store.loadDmList() } else store.patchDm(id, patch)
            },
            onDismiss = { menuTarget = null },
        )
    }
}

/** A row of the DM list: avatar(s) with a pin, name and time, the latest message. */
@Composable
private fun DmRow(dm: DmConversation, names: Map<String, String>) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        Box {
            DmAvatar(dm, 44.dp)
            if (dm.isPinned) {
                Icon(
                    Icons.Filled.PushPin,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onPrimary,
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .size(14.dp)
                        .background(MaterialTheme.colorScheme.primary, CircleShape)
                        .padding(2.dp),
                )
            }
        }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    dm.name,
                    fontWeight = if (dm.hasUnread) FontWeight.Bold else FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    ChatDates.listTime(dm.lastMessageAt).text(),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (dm.hasUnread) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Row(verticalAlignment = Alignment.Top) {
                Text(
                    dm.lastMessagePreview?.let { MentionText.plainText(it, names) } ?: stringResource(R.string.weldchat_dms_no_messages_preview),
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (dm.hasUnread) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (dm.isMuted) {
                    Icon(Icons.Filled.NotificationsOff, contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (dm.hasUnread && dm.unreadCount > 0) CountBadge(dm.unreadCount)
            }
        }
    }
}
