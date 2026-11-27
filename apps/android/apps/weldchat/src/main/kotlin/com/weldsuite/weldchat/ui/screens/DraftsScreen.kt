package com.weldsuite.weldchat.ui.screens

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
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.EditNote
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.ChatDates
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.MentionText
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.text
import com.weldsuite.weldchat.ui.BackButton
import com.weldsuite.weldchat.ui.ChatNavigator
import com.weldsuite.weldchat.ui.SwipeAction
import com.weldsuite.weldchat.ui.SwipeActions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import org.weldsuite.core.LoadState
import org.weldsuite.core.WeldDate
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import org.weldsuite.core.R as CoreR

/**
 * Drafts: the messages started and not sent, newest first. Tap to pick up
 * where you left off (the conversation restores its draft), swipe to delete.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DraftsScreen(store: ChatStore, nav: ChatNavigator) {
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf(LoadState<List<DraftItem>>()) }
    var refreshing by remember { mutableStateOf(false) }
    val names = store.memberNames

    /** The drafts, each with its conversation's name: from Home's lists when it is there, else from the channel itself. */
    suspend fun load() {
        state = state.copy(loading = true)
        state = try {
            val raw = store.repository.listDrafts(null)
            val dms = store.dms
            val channels = store.channels
            val items = coroutineScope {
                raw.mapNotNull { draft ->
                    val channelId = draft.channelId ?: return@mapNotNull null
                    async {
                        val known = SavedRules.knownConversation(channelId, dms, channels)
                            ?: runCatching { store.repository.channel(channelId) }.getOrNull()?.let { KnownConversation(it.name, it.isDm) }
                        DraftItem(draft.id, channelId, known?.name ?: channelId, known?.isDm ?: false, draft.content, draft.updatedAt)
                    }
                }.awaitAll()
            }
            LoadState(data = SavedRules.sortedDrafts(items))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            LoadState(data = state.data, error = error)
        }
    }

    fun delete(draft: DraftItem) {
        state = state.copy(data = state.data?.filter { it.id != draft.id })
        store.env.scope.launch {
            try {
                store.repository.deleteDraft(draft.id)
                store.loadCounts()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                load()
            }
        }
    }

    LaunchedEffect(Unit) { load() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.weldchat_drafts_title)) },
                navigationIcon = { BackButton(onClick = { nav.back() }) },
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
            val drafts = state.data
            when {
                state.isFirstLoad -> CenteredProgress()
                drafts == null -> LoadErrorState(state.error, onRetry = { scope.launch { load() } })
                drafts.isEmpty() -> LazyColumn(Modifier.fillMaxSize()) {
                    item {
                        EmptyState(
                            stringResource(R.string.weldchat_drafts_empty_title),
                            stringResource(R.string.weldchat_drafts_empty_hint),
                            icon = { Icon(Icons.Filled.EditNote, contentDescription = null, modifier = Modifier.size(40.dp)) },
                        )
                    }
                }
                else -> LazyColumn(Modifier.fillMaxSize().tagged("drafts-list")) {
                    items(drafts, key = { it.id }) { draft ->
                        SwipeActions(
                            start = emptyList(),
                            end = listOf(
                                SwipeAction(
                                    stringResource(CoreR.string.core_common_delete),
                                    Icons.Filled.Delete,
                                    MaterialTheme.colorScheme.error,
                                    "draft-delete-${draft.id}",
                                ) { delete(draft) },
                            ),
                        ) {
                            Box(
                                Modifier
                                    .clickable { nav.openConversation(draft.channelId, draft.channelName, if (draft.isDm) "dm" else null) }
                                    .tagged("draft-row-${draft.id}"),
                            ) { DraftRow(draft, names) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DraftRow(draft: DraftItem, names: Map<String, String>) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        RowIcon(Icons.Filled.EditNote)
        Column(Modifier.weight(1f)) {
            Text(
                SavedRules.conversationLabel(draft.channelName, draft.isDm),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                MentionText.plainText(draft.content, names),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        WeldDate.parse(draft.updatedAt)?.let {
            Text(ChatDates.draftTime(it).text(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** A list row's round icon in WeldChat's colour (drafts, saved). */
@Composable
internal fun RowIcon(icon: androidx.compose.ui.graphics.vector.ImageVector) {
    Box(
        Modifier.size(32.dp).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
    }
}
