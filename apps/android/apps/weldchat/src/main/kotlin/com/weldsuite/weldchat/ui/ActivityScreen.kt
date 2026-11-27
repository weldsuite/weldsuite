package com.weldsuite.weldchat.ui

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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.automirrored.filled.CallMissed
import androidx.compose.material.icons.filled.Drafts
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.ActivityNotification
import com.weldsuite.weldchat.ChatDates
import com.weldsuite.weldchat.ChatLogic
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.MentionText
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.text
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.LoadState
import org.weldsuite.core.WeldDate
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.RealtimeRefresh
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/**
 * Activity: WeldChat's notifications (mentions, thread replies, DMs, missed
 * calls) by day; a tap marks it read and opens the conversation.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ActivityScreen(env: AppEnvironment, store: ChatStore, userId: String, nav: ChatNavigator) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var state by remember { mutableStateOf(LoadState<List<ActivityNotification>>()) }
    var refreshing by remember { mutableStateOf(false) }
    val names = store.memberNames

    suspend fun load() {
        state = state.copy(loading = true)
        state = try {
            val rows = store.repository.listNotifications()
            LoadState(data = rows.filter { ChatLogic.isChatNotification(it.category, it.notificationType) })
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            LoadState(data = state.data, error = error)
        }
        store.loadActivityUnread()
    }

    LaunchedEffect(userId) {
        store.loadRosterIfNeeded()
        load()
    }
    RealtimeRefresh(env, listOf("chat.user.$userId", "notification.$userId")) { load() }

    fun open(item: ActivityNotification) {
        if (!item.isRead) {
            state = state.copy(data = state.data?.map { if (it.id == item.id) it.copy(isRead = true) else it })
            store.updateActivityUnread(store.activityUnread - 1)
            store.env.scope.launch { runCatching { store.repository.markNotificationRead(item.id) } }
        }
        ChatLogic.conversationFromActionUrl(item.actionUrl)?.let { target ->
            nav.openConversation(target.channelId, type = if (target.isDm) "dm" else null)
        }
    }

    val items = state.data.orEmpty()
    // Day groups, in the list's order (newest first).
    val groups = items.mapNotNull { item -> WeldDate.parse(item.createdAt)?.let { ChatDates.activityGroupLabel(ChatDates.activityGroup(it)).resolve(context) to item } }
        .groupBy({ it.first }, { it.second })

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.weldchat_tabs_activity)) },
                actions = {
                    IconButton(
                        onClick = {
                            state = state.copy(data = state.data?.map { it.copy(isRead = true) })
                            store.updateActivityUnread(0)
                            store.env.scope.launch { runCatching { store.repository.markAllNotificationsRead() } }
                        },
                        enabled = items.any { !it.isRead },
                        modifier = Modifier.tagged("activity-mark-all-read"),
                    ) {
                        Icon(Icons.Filled.Drafts, contentDescription = stringResource(R.string.weldchat_activity_mark_all_read))
                    }
                },
            )
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                scope.launch {
                    refreshing = true
                    load()
                    refreshing = false
                }
            },
            modifier = Modifier.padding(padding).fillMaxSize(),
        ) {
            when {
                state.isFirstLoad -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                state.data == null -> LoadErrorState(state.error, onRetry = { scope.launch { load() } })
                groups.isEmpty() -> LazyColumn(Modifier.fillMaxSize()) {
                    item {
                        EmptyState(
                            stringResource(R.string.weldchat_activity_empty_title),
                            stringResource(R.string.weldchat_activity_empty_hint),
                            icon = { Icon(Icons.Filled.AlternateEmail, contentDescription = null, modifier = Modifier.size(40.dp)) },
                        )
                    }
                }
                else -> LazyColumn(Modifier.fillMaxSize().tagged("activity-list")) {
                    groups.forEach { (title, rows) ->
                        item("header-$title") { ListHeader(title) }
                        items(rows, key = { it.id }) { item ->
                            Box(Modifier.clickable { open(item) }.tagged("activity-row-${item.id}")) { ActivityRow(item, names) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ActivityRow(item: ActivityNotification, names: Map<String, String>) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        if (item.actorAvatar != null || item.actorName != null) {
            ChatAvatar(item.actorName, item.actorAvatar, 40.dp)
        } else {
            Box(Modifier.size(40.dp).background(MaterialTheme.colorScheme.primary, CircleShape), contentAlignment = Alignment.Center) {
                Icon(activityIcon(item.notificationType), contentDescription = null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(20.dp))
            }
        }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    item.title,
                    fontWeight = if (item.isRead) FontWeight.Normal else FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                WeldDate.parse(item.createdAt)?.let {
                    Text(ChatDates.activityTime(it).text(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    MentionText.plainText(item.body.orEmpty(), names),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (!item.isRead) UnreadDot()
            }
        }
    }
}

private fun activityIcon(type: String): ImageVector = when (type) {
    "chat_mention" -> Icons.Filled.AlternateEmail
    "chat_thread_reply" -> Icons.Filled.Forum
    "chat_dm" -> Icons.Filled.Email
    "chat_missed_call" -> Icons.AutoMirrored.Filled.CallMissed
    else -> Icons.Filled.Notifications
}
