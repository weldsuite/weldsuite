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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.rotate
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
import com.weldsuite.weldchat.text
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.SessionState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.Instant

/**
 * Home: the workspace (tap to switch), search, Calls / Saved / Drafts, what
 * is unread, the channel sections, the record chats followed (one group per
 * type) and the latest direct messages; the compose button.
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

    val defaultGroup = stringResource(R.string.weldchat_home_channels_group)
    val groups = ChatLogic.groupSections(store.channels, store.sections, defaultGroup)
    val recordRows = RecordChatRules.types.flatMap { store.recordRows[it].orEmpty() }
    val now = Instant.now()
    val recordGroups = RecordChatRules.groups(store.recordSummary, store.recordRows, { "record:$it" in collapsed }, now)
    val followsRecords = store.recordSummary.orEmpty().any { it.followed > 0 }
    val unreadDms = DmLogic.recent(store.dms).filter { it.hasUnread && !it.isMuted }
    val unreadChannels = store.channels.filter { ChatLogic.isChannelUnread(it) }
    val unreadRecords = recordRows.filter { RecordChatRules.needsAttention(it) }.sortedByDescending { DmLogic.time(it.lastMessageAt) }
    val unreadTotal = unreadDms.size + unreadChannels.size + unreadRecords.size
    val recentDms = DmLogic.recent(store.dms).take(ChatLogic.RECENT_DM_COUNT)
    val showEmpty = store.homeLoaded && store.channels.isEmpty() && store.dms.isEmpty() && !followsRecords

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
                item("tiles") {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.xs),
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                    ) {
                        if (callsAvailable) {
                            Tile(
                                stringResource(R.string.weldchat_tabs_calls),
                                Icons.Filled.Call,
                                if (liveCalls.isEmpty()) null else pluralStringResource(R.plurals.weldchat_home_live_count, liveCalls.size, liveCalls.size),
                                "home-tile-calls",
                                Modifier.weight(1f),
                            ) { nav.selectTab(ChatTab.CALLS) }
                        }
                        Tile(
                            stringResource(R.string.weldchat_home_saved),
                            Icons.Filled.Bookmark,
                            ChatLogic.countLabel(store.savedCount, ChatLogic.SAVED_CAP)?.text(),
                            "home-tile-saved",
                            Modifier.weight(1f),
                        ) { nav.openSaved() }
                        Tile(
                            stringResource(R.string.weldchat_home_drafts),
                            Icons.AutoMirrored.Filled.Send,
                            ChatLogic.countLabel(store.draftCount)?.text(),
                            "home-tile-drafts",
                            Modifier.weight(1f),
                        ) { nav.openDrafts() }
                    }
                }

                when {
                    !store.homeLoaded && store.channels.isEmpty() -> item("loading") {
                        Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.xl), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                    }
                    showEmpty -> item("empty") { HomeEmpty(nav) }
                    else -> {
                        if (unreadTotal > 0) {
                            item("unread-header") {
                                ListHeader(stringResource(R.string.weldchat_home_unreads), trailing = { CountBadge(unreadTotal) })
                            }
                            items(unreadDms, key = { "unread-dm-${it.id}" }) { dm -> HomeDmRow(dm, nav) { menuTarget = it } }
                            items(unreadChannels, key = { "unread-channel-${it.id}" }) { channel -> HomeChannelRow(channel, nav) { menuTarget = it } }
                            items(unreadRecords, key = { "unread-record-${it.id}" }) { chat -> HomeRecordRow(chat, nav) { menuTarget = it } }
                        }

                        groups.forEach { group ->
                            item("group-${group.id}") {
                                SectionHeaderWithMenu(
                                    title = group.name,
                                    collapsed = group.id in collapsed,
                                    tag = "section-${group.id}",
                                    onToggle = { toggle(group.id) },
                                    onCreateChannel = { nav.newChannel(group.id.takeIf { it != ChatLogic.UNSECTIONED_ID }) },
                                )
                            }
                            if (group.id !in collapsed) {
                                items(group.channels, key = { "channel-${group.id}-${it.id}" }) { channel -> HomeChannelRow(channel, nav) { menuTarget = it } }
                            }
                        }

                        recordGroups.forEach { group ->
                            item("records-${group.type}") {
                                CollapsibleHeader(
                                    title = RecordChatRules.groupLabel(group.type)?.let { stringResource(it) } ?: group.type,
                                    collapsed = group.collapsed,
                                    count = group.unread.takeIf { it > 0 },
                                    mentions = group.mentions,
                                    onToggle = { toggle("record:${group.type}") },
                                )
                            }
                            items(group.rows, key = { "record-${group.type}-${it.id}" }) { chat -> HomeRecordRow(chat, nav) { menuTarget = it } }
                            if (group.showAll) {
                                item("records-all-${group.type}") {
                                    LinkRow(stringResource(R.string.weldchat_record_chats_show_all, group.followed)) { nav.openRecords(group.type) }
                                }
                            }
                        }

                        if (followsRecords) {
                            item("records-link") {
                                LinkRow(stringResource(R.string.weldchat_record_chats_title), Modifier.tagged("home-records")) { nav.openRecords() }
                            }
                        }

                        if (recentDms.isNotEmpty()) {
                            item("dms-header") {
                                ListHeader(stringResource(R.string.weldchat_tabs_direct_messages)) {
                                    TextButton(onClick = { nav.selectTab(ChatTab.DMS) }, modifier = Modifier.tagged("home-see-all-dms")) {
                                        Text(stringResource(R.string.weldchat_home_see_all))
                                        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, modifier = Modifier.size(16.dp))
                                    }
                                }
                            }
                            items(recentDms, key = { "recent-dm-${it.id}" }) { dm -> HomeDmRow(dm, nav) { menuTarget = it } }
                        }
                        item("fab-space") { Box(Modifier.padding(40.dp)) }
                    }
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
                Modifier.size(28.dp).background(MaterialTheme.colorScheme.primary, RoundedCornerShape(7.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text(workspace.name.take(1).uppercase(), color = MaterialTheme.colorScheme.onPrimary, fontWeight = FontWeight.Bold)
            }
            Text(
                workspace.name.ifEmpty { stringResource(R.string.weldchat_home_workspace_fallback) },
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Icon(Icons.Filled.KeyboardArrowDown, contentDescription = switchLabel, modifier = Modifier.size(18.dp))
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

@Composable
private fun Tile(title: String, icon: ImageVector, subtitle: String?, tag: String, modifier: Modifier, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(Tokens.Radius.medium),
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = modifier.tagged(tag),
    ) {
        Column(Modifier.padding(Tokens.Spacing.m)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(icon, contentDescription = null, modifier = Modifier.size(16.dp))
                Text(title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(subtitle ?: " ", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        }
    }
}

@Composable
private fun HomeEmpty(nav: ChatNavigator) {
    Column(
        Modifier.fillMaxWidth().padding(Tokens.Spacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        Icon(Icons.Filled.Forum, contentDescription = null, modifier = Modifier.size(54.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(stringResource(R.string.weldchat_home_empty_title), style = MaterialTheme.typography.titleMedium)
        Text(stringResource(R.string.weldchat_home_empty_hint), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        Button(onClick = { nav.newChannel() }, modifier = Modifier.fillMaxWidth().tagged("home-empty-create-channel")) {
            Icon(Icons.Filled.Add, contentDescription = null)
            Text(stringResource(R.string.weldchat_home_empty_create_channel), modifier = Modifier.padding(start = Tokens.Spacing.s))
        }
        OutlinedButton(onClick = { nav.newDm(group = false) }, modifier = Modifier.fillMaxWidth().tagged("home-empty-start-dm")) {
            Icon(Icons.AutoMirrored.Filled.Chat, contentDescription = null)
            Text(stringResource(R.string.weldchat_home_empty_start_dm), modifier = Modifier.padding(start = Tokens.Spacing.s))
        }
    }
}

/** A group's header: tap to fold it; a channel section's also offers "Create channel" on a long press. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SectionHeaderWithMenu(title: String, collapsed: Boolean, tag: String, onToggle: () -> Unit, onCreateChannel: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Box {
        Box(Modifier.combinedClickable(onClick = onToggle, onLongClick = { menu = true }).tagged(tag)) {
            CollapsibleHeaderContent(title, collapsed, null, 0)
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.weldchat_home_create_channel)) },
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
private fun CollapsibleHeader(title: String, collapsed: Boolean, count: Int?, mentions: Int, onToggle: () -> Unit) {
    Box(Modifier.clickable(onClick = onToggle)) { CollapsibleHeaderContent(title, collapsed, count, mentions) }
}

@Composable
private fun CollapsibleHeaderContent(title: String, collapsed: Boolean, count: Int?, mentions: Int) {
    Row(
        Modifier.fillMaxWidth().padding(start = Tokens.Spacing.l, end = Tokens.Spacing.l, top = Tokens.Spacing.m, bottom = Tokens.Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        count?.let { CountBadge(it) }
        if (mentions > 0) CountBadge(mentions, prefix = "@")
        Icon(
            Icons.Filled.KeyboardArrowDown,
            contentDescription = null,
            modifier = Modifier.size(16.dp).rotate(if (collapsed) -90f else 0f),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun LinkRow(title: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Row(
        modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = Tokens.Spacing.l, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        Icon(Icons.Filled.MoreHoriz, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
        Text(title, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
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
