package com.weldsuite.weldchat.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.PersonRemove
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.ChatDates
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.ConversationPatch
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.RecordChat
import com.weldsuite.weldchat.RecordChatPatch
import com.weldsuite.weldchat.RecordChatRules
import com.weldsuite.weldchat.RecordRefreshKind
import com.weldsuite.weldchat.text
import com.weldsuite.weldchat.ui.BackButton
import com.weldsuite.weldchat.ui.ChatNavigator
import com.weldsuite.weldchat.ui.ConversationMenuSheet
import com.weldsuite.weldchat.ui.ConversationTarget
import com.weldsuite.weldchat.ui.CountBadge
import com.weldsuite.weldchat.ui.LocalNotify
import com.weldsuite.weldchat.ui.SwipeAction
import com.weldsuite.weldchat.ui.SwipeActions
import com.weldsuite.weldchat.ui.recordIcon
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import org.weldsuite.core.AppEnvironment
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.Instant
import org.weldsuite.core.R as CoreR

/**
 * Record chats: every chat on a company, person, task, project, … you may
 * read, not only the five per type Home shows. The title picks the record
 * type; chips filter (Following, Unread, Mentions, All); search; more as
 * you scroll. Swipe a row to follow, unfollow or mute it; hold for its menu.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun RecordsScreen(env: AppEnvironment, store: ChatStore, initialType: String?, nav: ChatNavigator) {
    val scope = rememberCoroutineScope()
    val notify = LocalNotify.current
    var type by rememberSaveable { mutableStateOf(RecordsRules.initialType(initialType)) }
    var filter by rememberSaveable { mutableStateOf(RecordsFilter.FOLLOWING) }
    var query by rememberSaveable { mutableStateOf("") }
    var search by rememberSaveable { mutableStateOf("") }
    var rows by remember { mutableStateOf<List<RecordChat>>(emptyList()) }
    var cursor by remember { mutableStateOf<String?>(null) }
    var hasMore by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }
    var loadingMore by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    var typeMenuOpen by remember { mutableStateOf(false) }
    var menuTarget by remember { mutableStateOf<ConversationTarget?>(null) }
    // Each first-page load gets a number; answers to an older one are dropped.
    var request by remember { mutableIntStateOf(0) }
    val listState = rememberLazyListState()
    val followFailed = stringResource(R.string.weldchat_record_chats_follow_failed)
    val unfollowFailed = stringResource(R.string.weldchat_record_chats_unfollow_failed)
    val muteFailed = stringResource(R.string.weldchat_record_chats_mute_failed)

    suspend fun loadFirst() {
        request += 1
        val mine = request
        loading = true
        failed = false
        try {
            val page = store.repository.listRecordChats(type, filter.wire, search.ifEmpty { null }, null, RecordsRules.PAGE_SIZE)
            if (mine != request) return
            rows = page.items
            cursor = page.cursor
            hasMore = page.hasMore
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            if (mine != request) return
            // A failed reload keeps the rows shown.
            failed = true
        }
        loading = false
    }

    suspend fun loadMore() {
        val next = cursor
        if (!hasMore || next == null || loading || loadingMore) return
        val mine = request
        loadingMore = true
        try {
            val page = store.repository.listRecordChats(type, filter.wire, search.ifEmpty { null }, next, RecordsRules.PAGE_SIZE)
            if (mine == request) {
                rows = RecordChatRules.uniqueRows(listOf(rows, page.items))
                cursor = page.cursor
                hasMore = page.hasMore
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // The next scroll to the end tries again.
        } finally {
            loadingMore = false
        }
    }

    fun patchRow(id: String, patch: ConversationPatch) {
        val listed = rows.any { it.id == id }
        rows = RecordsRules.apply(patch, rows, id, filter, Instant.now())
        if (RecordsRules.needsReload(patch, listed)) scope.launch { loadFirst() }
    }

    fun toggleFollow(chat: RecordChat) {
        val next = !chat.isFollowing
        store.forgetMembership(chat.id)
        patchRow(chat.id, ConversationPatch(isFollowing = next))
        store.env.scope.launch {
            try {
                store.repository.setFollowing(chat.entityType, chat.entityId, next)
                store.refreshRecordChats(RecordRefreshKind.ALL)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                patchRow(chat.id, ConversationPatch(isFollowing = !next))
                notify(if (next) followFailed else unfollowFailed)
            }
        }
    }

    fun toggleMute(chat: RecordChat) {
        if (!chat.isFollowing) return
        val next = !chat.isMuted
        patchRow(chat.id, ConversationPatch(isMuted = next))
        store.env.scope.launch {
            try {
                store.updateMembership(chat.id, isMuted = next)
                store.patchRecordChat(chat.id, RecordChatPatch(isMuted = next))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                patchRow(chat.id, ConversationPatch(isMuted = !next))
                notify(muteFailed)
            }
        }
    }

    // The list for the type, filter and search; also on coming back from a chat, which moved its read marker.
    LaunchedEffect(type, filter, search) { loadFirst() }
    // Typing pauses before the search runs.
    LaunchedEffect(query) {
        val trimmed = query.trim()
        if (trimmed == search) return@LaunchedEffect
        delay(RecordsRules.SEARCH_DEBOUNCE_MS)
        search = trimmed
    }
    // More as the end comes into view.
    val nearEnd by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: 0
            info.totalItemsCount > 0 && last >= info.totalItemsCount - 3
        }
    }
    LaunchedEffect(nearEnd, rows.size, hasMore) { if (nearEnd && hasMore) loadMore() }
    // New follows, and messages in the chats listed, reload the first page once per burst.
    val userId = store.currentUserId
    LaunchedEffect(userId) {
        val realtime = env.realtime ?: return@LaunchedEffect
        if (userId == null) return@LaunchedEffect
        var pending: Job? = null
        realtime.events(listOf("chat.user.$userId")).collect { event ->
            val channelId = ((event.data as? JsonObject)?.get("channelId") as? JsonPrimitive)?.contentOrNull
            if (!event.isResync && !RecordsRules.isRelevant(event.event, channelId, rows)) return@collect
            pending?.cancel()
            pending = launch {
                delay(RecordsRules.EVENT_BURST_MS)
                loadFirst()
            }
        }
    }

    val title = type?.let { RecordChatRules.groupLabel(it) }?.let { stringResource(it) } ?: stringResource(R.string.weldchat_record_chats_title)
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Box {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .clickable(onClickLabel = stringResource(R.string.weldchat_record_chats_choose_type)) { typeMenuOpen = true }
                                .tagged("records-type"),
                        ) {
                            Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Icon(Icons.Filled.ArrowDropDown, contentDescription = null)
                        }
                        DropdownMenu(expanded = typeMenuOpen, onDismissRequest = { typeMenuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.weldchat_record_chats_all_types)) },
                                leadingIcon = { if (type == null) Icon(Icons.Filled.Check, contentDescription = null) },
                                onClick = {
                                    typeMenuOpen = false
                                    type = null
                                },
                                modifier = Modifier.tagged("records-type-all"),
                            )
                            RecordChatRules.types.forEach { option ->
                                DropdownMenuItem(
                                    text = { Text(RecordChatRules.groupLabel(option)?.let { stringResource(it) } ?: option) },
                                    leadingIcon = { Icon(if (option == type) Icons.Filled.Check else recordIcon(option), contentDescription = null) },
                                    onClick = {
                                        typeMenuOpen = false
                                        type = option
                                    },
                                    modifier = Modifier.tagged("records-type-$option"),
                                )
                            }
                        }
                    }
                },
                navigationIcon = { BackButton(onClick = { nav.back() }) },
            )
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                scope.launch {
                    refreshing = true
                    loadFirst()
                    refreshing = false
                }
            },
            modifier = Modifier.padding(padding).fillMaxSize(),
        ) {
            LazyColumn(Modifier.fillMaxSize().tagged("records-list"), state = listState) {
                item("search") {
                    ChatSearchField(
                        placeholder = stringResource(R.string.weldchat_record_chats_search_placeholder),
                        text = query,
                        onTextChange = { query = it },
                        tag = "records-search",
                        modifier = Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
                    )
                }
                item("filters") {
                    Row(
                        Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = Tokens.Spacing.l),
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                    ) {
                        RecordsFilter.entries.forEach { option ->
                            FilterChip(
                                selected = filter == option,
                                onClick = { filter = option },
                                label = { Text(stringResource(option.label)) },
                                modifier = Modifier.tagged("records-filter-${option.wire}"),
                            )
                        }
                    }
                }
                when {
                    loading && rows.isEmpty() -> item("loading") {
                        Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.xl), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                    }
                    rows.isEmpty() -> item("empty") {
                        Column(
                            Modifier.fillMaxWidth().padding(Tokens.Spacing.xl),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
                        ) {
                            Text(
                                if (failed) stringResource(R.string.weldchat_record_chats_load_failed) else RecordsRules.emptyText(filter, search).text(),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                textAlign = TextAlign.Center,
                            )
                            if (failed) {
                                TextButton(onClick = { scope.launch { loadFirst() } }, modifier = Modifier.tagged("retry")) {
                                    Text(stringResource(CoreR.string.core_common_try_again))
                                }
                            }
                        }
                    }
                    else -> {
                        items(rows, key = { it.id }) { chat ->
                            val start = buildList {
                                add(
                                    SwipeAction(
                                        stringResource(if (chat.isFollowing) R.string.weldchat_record_chats_unfollow else R.string.weldchat_record_chats_follow),
                                        if (chat.isFollowing) Icons.Filled.PersonRemove else Icons.Filled.Add,
                                        if (chat.isFollowing) Color(0xFF6B7280) else MaterialTheme.colorScheme.primary,
                                        "records-swipe-follow-${chat.id}",
                                    ) { toggleFollow(chat) },
                                )
                                if (chat.isFollowing) {
                                    add(
                                        SwipeAction(
                                            stringResource(if (chat.isMuted) R.string.weldchat_record_chats_unmute else R.string.weldchat_record_chats_mute),
                                            if (chat.isMuted) Icons.Filled.Notifications else Icons.Filled.NotificationsOff,
                                            Color(0xFFF59E0B),
                                            "records-swipe-mute-${chat.id}",
                                        ) { toggleMute(chat) },
                                    )
                                }
                            }
                            SwipeActions(start = start, end = emptyList()) {
                                Box(
                                    Modifier
                                        .combinedClickable(
                                            onClick = { nav.openConversation(chat.id, chat.displayName, "entity", chat.entityType) },
                                            onLongClick = { menuTarget = ConversationTarget.Record(chat) },
                                        )
                                        .tagged("record-row-${chat.id}"),
                                ) { RecordsRow(chat, showType = type == null) { toggleFollow(chat) } }
                            }
                        }
                        if (loadingMore) {
                            item("more") {
                                Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.m), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                            }
                        }
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
            onChange = { id, patch ->
                patchRow(id, patch)
                // Home's record chat groups follow.
                val muted = patch.isMuted
                when {
                    patch.isFollowing != null -> store.refreshRecordChats(RecordRefreshKind.ALL)
                    muted != null -> store.patchRecordChat(id, RecordChatPatch(isMuted = muted))
                    patch.hasUnread == false -> store.patchRecordChat(id, RecordChatPatch(markRead = true))
                }
            },
            onDismiss = { menuTarget = null },
        )
    }
}

/**
 * A record chat row: the type's icon, the record's name, the time, the
 * preview (after the type when every type is listed), muted, mentions, and
 * Follow for a chat you don't follow.
 */
@Composable
private fun RecordsRow(chat: RecordChat, showType: Boolean, onFollow: () -> Unit) {
    val highlighted = RecordsRules.isHighlighted(chat)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        Box(
            Modifier.size(36.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(Tokens.Radius.small)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(recordIcon(chat.entityType), contentDescription = null, modifier = Modifier.size(18.dp))
        }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    chat.displayName,
                    fontWeight = if (highlighted) FontWeight.SemiBold else FontWeight.Normal,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                val time = ChatDates.listTime(chat.lastMessageAt).text()
                if (time.isNotEmpty()) {
                    Text(time, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                Text(
                    RecordsRules.subtitle(chat, showType).text(),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (chat.isMuted) {
                    Icon(Icons.Filled.NotificationsOff, contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (chat.unreadMentionCount > 0) CountBadge(chat.unreadMentionCount)
                if (!chat.isFollowing) {
                    OutlinedButton(
                        onClick = onFollow,
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = Tokens.Spacing.s),
                        modifier = Modifier.height(28.dp).tagged("records-follow-${chat.id}"),
                    ) {
                        Text(stringResource(R.string.weldchat_record_chats_follow), style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
    }
}
