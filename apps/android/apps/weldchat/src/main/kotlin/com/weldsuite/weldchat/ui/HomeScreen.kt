package com.weldsuite.weldchat.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.outlined.BookmarkBorder
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import org.weldsuite.ui.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldchat.ChatChannel
import com.weldsuite.weldchat.ChatLogic
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.ConversationPatch
import com.weldsuite.weldchat.DmConversation
import com.weldsuite.weldchat.DmLogic
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.RecordChat
import com.weldsuite.weldchat.RecordChatPatch
import com.weldsuite.weldchat.RecordChatRules
import com.weldsuite.weldchat.RecordRefreshKind
import com.weldsuite.weldchat.calls.CallManager
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.SessionState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.Instant

/**
 * Home, laid out as the platform's WeldChat sidebar: the workspace (tap to
 * switch), search, the top rows (Calls, Drafts, Record chats, Saved items),
 * what is unread, Direct Messages, the record chats followed (one group per
 * type) and the channel sections, each with "Add channel" while empty; the
 * compose button.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(env: AppEnvironment, store: ChatStore, calls: CallManager, session: SessionState.Ready, nav: ChatNavigator) {
    val scope = rememberCoroutineScope()
    val callsAvailable = env.isAvailable("chat-calls")
    val liveCalls by calls.activeChannelCalls.collectAsStateWithLifecycle()
    var collapsed by remember { mutableStateOf(setOf<String>()) }
    var refreshing by remember { mutableStateOf(false) }
    var menuTarget by remember { mutableStateOf<ConversationTarget?>(null) }
    var composeOpen by remember { mutableStateOf(false) }

    suspend fun reload() {
        store.loadHome()
        store.refreshRecordChats(RecordRefreshKind.ALL, immediate = true)
        store.loadCounts()
    }
    LaunchedEffect(session.workspace.id) { reload() }

    val groups = ChatLogic.groupSections(
        store.channels,
        store.sections,
        stringResource(R.string.weldchat_home_channels_group),
        stringResource(R.string.weldchat_home_other_channels_group),
    )
    val recordRows = RecordChatRules.types.flatMap { store.recordRows[it].orEmpty() }
    val now = Instant.now()
    val recordGroups = RecordChatRules.groups(store.recordSummary, store.recordRows, { "record:$it" in collapsed }, now)
    val followsRecords = store.recordSummary.orEmpty().any { it.followed > 0 }
    val unreadDms = DmLogic.recent(store.dms).filter { it.hasUnread && !it.isMuted }
    val unreadChannels = store.channels.filter { ChatLogic.isChannelUnread(it) }
    val unreadRecords = recordRows.filter { RecordChatRules.needsAttention(it) }.sortedByDescending { DmLogic.time(it.lastMessageAt) }
    val unreadTotal = unreadDms.size + unreadChannels.size + unreadRecords.size
    val recentDms = DmLogic.recent(store.dms).take(ChatLogic.RECENT_DM_COUNT)

    fun toggle(key: String) {
        collapsed = if (key in collapsed) collapsed - key else collapsed + key
    }

    Scaffold(
        topBar = {
            TopAppBar(title = { WorkspaceMenu(env, session, nav) })
        },
        floatingActionButton = {
            Box {
                FloatingActionButton(onClick = { composeOpen = true }, modifier = Modifier.tagged("home-compose")) {
                    Icon(Icons.Filled.Edit, contentDescription = stringResource(R.string.weldchat_home_new_item))
                }
                DropdownMenu(expanded = composeOpen, onDismissRequest = { composeOpen = false }) {
                    ComposeItem(R.string.weldchat_home_compose_message, null, Icons.Filled.Edit, "compose-message") {
                        composeOpen = false
                        nav.newMessage()
                    }
                    ComposeItem(R.string.weldchat_home_compose_channel, R.string.weldchat_home_compose_channel_hint, Icons.Filled.Tag, "compose-channel") {
                        composeOpen = false
                        nav.newChannel()
                    }
                    ComposeItem(R.string.weldchat_home_compose_category, R.string.weldchat_home_compose_category_hint, Icons.Filled.CreateNewFolder, "compose-category") {
                        composeOpen = false
                        nav.newCategory()
                    }
                }
            }
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                scope.launch {
                    refreshing = true
                    reload()
                    refreshing = false
                }
            },
            modifier = Modifier.padding(padding).fillMaxSize(),
        ) {
            LazyColumn(Modifier.fillMaxSize().tagged("home-list")) {
                item("search") {
                    SearchButton(onClick = { nav.openSearch() }, modifier = Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s).tagged("home-search"))
                }
                // The platform sidebar's top rows.
                if (callsAvailable) {
                    item("nav-calls") {
                        NavRow(stringResource(R.string.weldchat_tabs_calls), Icons.Outlined.Phone, "home-tile-calls", onClick = { nav.selectTab(ChatTab.CALLS) }) {
                            if (liveCalls.isNotEmpty()) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Icon(Icons.Filled.Call, contentDescription = null, tint = ChatColors.callGreen.current(), modifier = Modifier.size(14.dp))
                                    Text(
                                        pluralStringResource(R.plurals.weldchat_home_live_count, liveCalls.size, liveCalls.size),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = ChatColors.callGreen.current(),
                                    )
                                }
                            }
                        }
                    }
                }
                item("nav-drafts") {
                    val drafts = store.draftCount ?: 0
                    NavRow(stringResource(R.string.weldchat_home_drafts), Icons.Outlined.EditNote, "home-tile-drafts", bold = drafts > 0, onClick = { nav.openDrafts() }) {
                        CountBadge(drafts)
                    }
                }
                if (followsRecords) {
                    item("nav-records") {
                        NavRow(stringResource(R.string.weldchat_record_chats_title), Icons.Outlined.Forum, "home-records", onClick = { nav.openRecords() })
                    }
                }
                item("nav-saved") {
                    NavRow(stringResource(R.string.weldchat_home_saved), Icons.Outlined.BookmarkBorder, "home-tile-saved", onClick = { nav.openSaved() })
                }

                if (!store.homeLoaded && store.channels.isEmpty()) {
                    item("loading") {
                        Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.xl), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                    }
                } else {
                    if (unreadTotal > 0) {
                        item("unread-header") { SidebarGroupHeader(stringResource(R.string.weldchat_home_unreads), unread = unreadTotal) }
                        items(unreadDms, key = { "unread-dm-${it.id}" }) { dm -> HomeDmRow(dm, nav) { menuTarget = it } }
                        items(unreadChannels, key = { "unread-channel-${it.id}" }) { channel -> HomeChannelRow(channel, nav) { menuTarget = it } }
                        items(unreadRecords, key = { "unread-record-${it.id}" }) { chat -> HomeRecordRow(chat, nav) { menuTarget = it } }
                    }

                    // Direct Messages, always, as on the platform.
                    item("dms-header") {
                        SidebarGroupHeader(
                            stringResource(R.string.weldchat_tabs_direct_messages),
                            trailing = {
                                TextButton(onClick = { nav.selectTab(ChatTab.DMS) }, modifier = Modifier.tagged("home-see-all-dms")) {
                                    Text(stringResource(R.string.weldchat_home_see_all), style = MaterialTheme.typography.labelMedium)
                                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, modifier = Modifier.size(16.dp))
                                }
                            },
                        )
                    }
                    if (recentDms.isEmpty()) {
                        item("dms-add") {
                            AddPlaceholderRow(stringResource(R.string.weldchat_home_empty_start_dm), Modifier.tagged("home-empty-start-dm")) { nav.newDm(group = false) }
                        }
                    } else {
                        items(recentDms, key = { "recent-dm-${it.id}" }) { dm -> HomeDmRow(dm, nav) { menuTarget = it } }
                    }

                    recordGroups.forEach { group ->
                        item("records-${group.type}") {
                            SidebarGroupHeader(
                                RecordChatRules.groupLabel(group.type)?.let { stringResource(it) } ?: group.type,
                                modifier = Modifier.clickable { toggle("record:${group.type}") },
                                collapsed = group.collapsed,
                                unread = group.unread,
                                mentions = group.mentions,
                            )
                        }
                        items(group.rows, key = { "record-${group.type}-${it.id}" }) { chat -> HomeRecordRow(chat, nav) { menuTarget = it } }
                        if (group.showAll) {
                            item("records-all-${group.type}") {
                                LinkRow(stringResource(R.string.weldchat_record_chats_show_all, group.followed)) { nav.openRecords(group.type) }
                            }
                        }
                    }

                    groups.forEach { group ->
                        val isCollapsed = group.id in collapsed
                        item("group-${group.id}") {
                            SectionHeaderWithMenu(
                                title = group.name,
                                collapsed = isCollapsed,
                                unread = group.channels.count { ChatLogic.isChannelUnread(it) },
                                mentions = group.channels.sumOf { it.unreadMentionCount },
                                tag = "section-${group.id}",
                                onToggle = { toggle(group.id) },
                                onCreateChannel = { nav.newChannel(group.id.takeIf { it != ChatLogic.UNSECTIONED_ID }) },
                            )
                        }
                        if (!isCollapsed) {
                            if (group.channels.isEmpty()) {
                                item("group-add-${group.id}") {
                                    AddPlaceholderRow(stringResource(R.string.weldchat_home_add_channel), Modifier.tagged("home-add-channel-${group.id}")) {
                                        nav.newChannel(group.id.takeIf { it != ChatLogic.UNSECTIONED_ID })
                                    }
                                }
                            } else {
                                items(group.channels, key = { "channel-${group.id}-${it.id}" }) { channel -> HomeChannelRow(channel, nav) { menuTarget = it } }
                            }
                        }
                    }
                    item("fab-space") { Box(Modifier.height(88.dp)) }
                }
            }
        }
    }

    menuTarget?.let { target ->
        ConversationMenuSheet(
            target = target,
            store = store,
            nav = nav,
            onChange = { id, patch -> applyHomePatch(store, target, id, patch) },
            onDismiss = { menuTarget = null },
        )
    }
}

/** A menu change on Home, shown at once; an undo of a failed change reloads what the server has. */
private fun applyHomePatch(store: ChatStore, target: ConversationTarget, id: String, patch: ConversationPatch) {
    when (target) {
        is ConversationTarget.Channel -> {
            store.patchChannel(id, patch)
            if (patch.hasUnread == true) store.env.scope.launch { store.loadHome() }
        }
        is ConversationTarget.Dm -> {
            if (patch.archived == false) {
                store.env.scope.launch { store.loadHome() }
            } else {
                store.patchDm(id, patch)
            }
        }
        is ConversationTarget.Record -> {
            if (patch.isFollowing == true || patch.hasUnread == true) {
                store.refreshRecordChats(RecordRefreshKind.ALL, immediate = true)
            } else {
                store.patchRecordChat(id, RecordChatPatch(isMuted = patch.isMuted, markRead = patch.hasUnread == false, unfollowed = patch.isFollowing == false))
            }
        }
    }
}

/** The workspace (tap: profile & settings, switch workspace). */
@Composable
private fun WorkspaceMenu(env: AppEnvironment, session: SessionState.Ready, nav: ChatNavigator) {
    var open by remember { mutableStateOf(false) }
    val workspace = session.workspace
    val switchLabel = stringResource(R.string.weldchat_home_switch_workspace)
    Box {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
            modifier = Modifier.clickable { open = true }.tagged("home-workspace"),
        ) {
            Box(
                Modifier.size(28.dp).background(MaterialTheme.colorScheme.primary, RoundedCornerShape(Tokens.Radius.medium)),
                contentAlignment = Alignment.Center,
            ) {
                Text(workspace.name.take(1).uppercase(), color = MaterialTheme.colorScheme.onPrimary, fontWeight = FontWeight.SemiBold)
            }
            Text(
                workspace.name.ifEmpty { stringResource(R.string.weldchat_home_workspace_fallback) },
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Icon(Icons.Filled.KeyboardArrowDown, contentDescription = switchLabel, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            (session.person.email ?: session.person.name)?.let { label ->
                Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s))
            }
            DropdownMenuItem(
                text = { Text(stringResource(R.string.weldchat_home_profile_and_settings)) },
                leadingIcon = { Icon(Icons.Filled.Settings, contentDescription = null) },
                onClick = {
                    open = false
                    nav.openSettings()
                },
                modifier = Modifier.tagged("home-settings"),
            )
            if (session.workspaces.size > 1) {
                HorizontalDivider()
                Text(switchLabel, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s))
                session.workspaces.forEach { option ->
                    DropdownMenuItem(
                        text = { Text(option.name) },
                        leadingIcon = { if (option.id == workspace.id) Icon(Icons.Filled.Check, contentDescription = null) },
                        onClick = {
                            open = false
                            if (option.id != workspace.id) env.chooseWorkspace(option.id)
                        },
                        modifier = Modifier.tagged("workspace-${option.id}"),
                    )
                }
            }
        }
    }
}

@Composable
private fun ComposeItem(label: Int, hint: Int?, icon: ImageVector, tag: String, onClick: () -> Unit) {
    DropdownMenuItem(
        text = {
            Column {
                Text(stringResource(label))
                hint?.let { Text(stringResource(it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        },
        leadingIcon = { Icon(icon, contentDescription = null) },
        onClick = onClick,
        modifier = Modifier.tagged(tag),
    )
}

/** One of the sidebar's top rows (Drafts, Saved items, …): the icon, the label, what it holds. */
@Composable
private fun NavRow(
    title: String,
    icon: ImageVector,
    tag: String,
    bold: Boolean = false,
    onClick: () -> Unit,
    trailing: @Composable () -> Unit = {},
) {
    Box(Modifier.clickable(onClick = onClick).tagged(tag)) {
        SidebarRow(title, unread = bold, muted = false, mentions = 0) { SidebarIcon(icon, bold) }
        Box(Modifier.align(Alignment.CenterEnd).padding(end = Tokens.Spacing.l)) { trailing() }
    }
}

/** A channel section's header: tap to fold it; a long press offers "Create channel". */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SectionHeaderWithMenu(
    title: String,
    collapsed: Boolean,
    unread: Int,
    mentions: Int,
    tag: String,
    onToggle: () -> Unit,
    onCreateChannel: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    Box {
        SidebarGroupHeader(
            title,
            modifier = Modifier.combinedClickable(onClick = onToggle, onLongClick = { menu = true }).tagged(tag),
            collapsed = collapsed,
            unread = unread,
            mentions = mentions,
        )
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.weldchat_home_add_channel)) },
                leadingIcon = { Icon(Icons.Filled.Add, contentDescription = null) },
                onClick = {
                    menu = false
                    onCreateChannel()
                },
            )
        }
    }
}

@Composable
private fun LinkRow(title: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(modifier.clickable(onClick = onClick)) {
        SidebarRow(title, unread = false, muted = false, mentions = 0) { SidebarIcon(Icons.Filled.MoreHoriz) }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HomeChannelRow(channel: ChatChannel, nav: ChatNavigator, onMenu: (ConversationTarget) -> Unit) {
    Box(
        Modifier
            .combinedClickable(
                onClick = { nav.openConversation(channel.id, channel.name, channel.type) },
                onLongClick = { onMenu(ConversationTarget.Channel(channel)) },
            )
            .tagged("channel-row-${channel.id}"),
    ) { ChannelRow(channel) }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HomeDmRow(dm: DmConversation, nav: ChatNavigator, onMenu: (ConversationTarget) -> Unit) {
    Box(
        Modifier
            .combinedClickable(
                onClick = { nav.openConversation(dm.id, dm.name, "dm") },
                onLongClick = { onMenu(ConversationTarget.Dm(dm)) },
            )
            .tagged("dm-row-${dm.id}"),
    ) { DmCompactRow(dm) }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HomeRecordRow(chat: RecordChat, nav: ChatNavigator, onMenu: (ConversationTarget) -> Unit) {
    Box(
        Modifier
            .combinedClickable(
                onClick = { nav.openConversation(chat.id, chat.displayName, "entity", chat.entityType) },
                onLongClick = { onMenu(ConversationTarget.Record(chat)) },
            )
            .tagged("record-row-${chat.id}"),
    ) { RecordChatRow(chat) }
}
