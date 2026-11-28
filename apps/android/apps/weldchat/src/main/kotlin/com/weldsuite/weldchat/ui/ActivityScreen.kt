package com.weldsuite.weldchat.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallMissed
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.Person
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.ActivityNotification
import com.weldsuite.weldchat.ChatDates
import com.weldsuite.weldchat.ChatLogic
import com.weldsuite.weldchat.ChatLogic.ActivityCategory
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.DmConversation
import com.weldsuite.weldchat.TeamMember
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
 * Activity, as the platform's: what asks for your attention (mentions,
 * replies in your threads, missed calls; a DM's messages show in the DM),
 * grouped by kind; unread rows washed blue with a bar. A tap marks it read
 * and opens the conversation.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ActivityScreen(env: AppEnvironment, store: ChatStore, userId: String, nav: ChatNavigator) {
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf(LoadState<List<ActivityNotification>>()) }
    var refreshing by remember { mutableStateOf(false) }
    val names = store.memberNames

    suspend fun load() {
        state = state.copy(loading = true)
        state = try {
            val rows = store.repository.listActivity()
            LoadState(data = rows.filter { ChatLogic.isActivityItem(it.category, it.notificationType) })
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
            store.env.scope.launch { runCatching { store.repository.markActivityRead(item.id) } }
        }
        val target = ChatLogic.conversationFromActionUrl(item.actionUrl)
        when {
            target != null -> nav.openConversation(target.channelId, type = if (target.isDm) "dm" else null)
            item.channelId != null -> nav.openConversation(item.channelId, item.channelName, if (store.dms.any { it.id == item.channelId }) "dm" else null)
        }
    }

    val items = state.data.orEmpty()
    // The platform's groups, in its order, empty ones left out.
    val groups = ActivityCategory.entries.mapNotNull { category ->
        items.filter { ChatLogic.activityCategory(it.notificationType) == category }.takeIf { it.isNotEmpty() }?.let { category to it }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.weldchat_tabs_activity)) },
                actions = {
                    IconButton(
                        onClick = {
                            state = state.copy(data = state.data?.map { it.copy(isRead = true) })
                            store.updateActivityUnread(0)
                            store.env.scope.launch { runCatching { store.repository.markAllActivityRead() } }
                        },
                        enabled = items.any { !it.isRead },
                        modifier = Modifier.tagged("activity-mark-all-read"),
                    ) {
                        Icon(Icons.Filled.DoneAll, contentDescription = stringResource(R.string.weldchat_activity_mark_all_read))
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
                            icon = { EmptyIcon(Icons.Filled.AlternateEmail) },
                        )
                    }
                }
                else -> LazyColumn(Modifier.fillMaxSize().tagged("activity-list")) {
                    groups.forEach { (category, rows) ->
                        item("header-${category.name}") { ListGroupHeader(stringResource(categoryLabel(category)), rows.size) }
                        items(rows, key = { it.id }) { item ->
                            Column(Modifier.clickable { open(item) }.tagged("activity-row-${item.id}")) {
                                ActivityRow(item, names, store.roster, store.dms)
                                RowDivider()
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun categoryLabel(category: ActivityCategory): Int = when (category) {
    ActivityCategory.MENTIONS -> R.string.weldchat_activity_mentions
    ActivityCategory.REPLIES -> R.string.weldchat_activity_replies
    ActivityCategory.CALLS -> R.string.weldchat_activity_missed_calls
    ActivityCategory.OTHER -> R.string.weldchat_activity_other
}

private fun categoryIcon(category: ActivityCategory): ImageVector = when (category) {
    ActivityCategory.MENTIONS -> Icons.Filled.AlternateEmail
    ActivityCategory.REPLIES -> Icons.AutoMirrored.Filled.Reply
    ActivityCategory.CALLS -> Icons.AutoMirrored.Filled.CallMissed
    ActivityCategory.OTHER -> Icons.Filled.Person
}

/**
 * One activity row, as the platform's: the actor's small avatar with the
 * kind's icon in its corner, the title (mentions as chips; medium while
 * unread), the message under it, and when.
 */
@Composable
private fun ActivityRow(item: ActivityNotification, names: Map<String, String>, roster: List<TeamMember>, dms: List<DmConversation>) {
    val unread = !item.isRead
    // The feed names nobody: the actor from the workspace's people, as the platform does.
    val actor = item.actorId?.let { id -> roster.firstOrNull { it.userId == id } }
    val actorName = item.actorName ?: actor?.displayName
    val actorAvatar = item.actorAvatar ?: actor?.picture
    // "in #channel" after the title; a DM is named after the person, not shown.
    val inChannel = item.channelName?.takeIf { it.isNotBlank() && dms.none { dm -> dm.id == item.channelId } }
    val category = ChatLogic.activityCategory(item.notificationType)
    val bar = if (unread) ChatColors.activityBar else Color.Transparent
    val linkColor = MaterialTheme.colorScheme.primary
    val mentionText = ChatColors.mentionText.current()
    val mentionFill = ChatColors.mentionFill.current()
    // A missed call's body is the push's "Tap to call back": the row itself does that.
    val body = item.body?.takeIf { it.isNotBlank() && category != ActivityCategory.CALLS }
    Row(
        Modifier
            .fillMaxWidth()
            .background(if (unread) ChatColors.activityUnread.current() else Color.Transparent)
            .drawBehind { drawRect(bar, size = size.copy(width = 2.dp.toPx())) }
            .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m),
        verticalAlignment = if (body != null) Alignment.Top else Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.padding(top = if (body != null) 1.dp else 0.dp)) {
            ChatAvatar(actorName ?: "?", actorAvatar, 26.dp)
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .offset(x = 3.dp, y = 3.dp)
                    .size(14.dp)
                    .background(MaterialTheme.colorScheme.background, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(categoryIcon(category), contentDescription = null, tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(10.dp))
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            val muted = MaterialTheme.colorScheme.onSurfaceVariant
            val inLabel = inChannel?.let { stringResource(R.string.weldchat_activity_in_channel, it) }
            Text(
                buildAnnotatedString {
                    append(messageText(item.title, names, linkColor, mentionText, mentionFill))
                    if (inLabel != null) withStyle(SpanStyle(color = muted, fontWeight = FontWeight.Normal)) { append(" $inLabel") }
                },
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (unread) FontWeight.Medium else FontWeight.Normal,
                color = if (unread) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.8f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (body != null) {
                Text(
                    messageText(body, names, linkColor, mentionText, mentionFill),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        WeldDate.parse(item.createdAt)?.let {
            Text(ChatDates.activityTime(it).text(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
