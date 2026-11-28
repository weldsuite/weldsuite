package com.weldsuite.weldchat.ui.screens

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.outlined.BookmarkBorder
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
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.weldsuite.weldchat.ChatBookmark
import com.weldsuite.weldchat.ChatLogic
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.text
import com.weldsuite.weldchat.ui.BackButton
import com.weldsuite.weldchat.ui.ChatAvatar
import com.weldsuite.weldchat.ui.ChatNavigator
import com.weldsuite.weldchat.ui.EmptyIcon
import com.weldsuite.weldchat.ui.RowDivider
import com.weldsuite.weldchat.ui.SwipeAction
import com.weldsuite.weldchat.ui.SwipeActions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.weldsuite.core.LoadState
import org.weldsuite.core.WeldDate
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Saved for later: the messages bookmarked from a conversation's actions.
 * Tap to open the conversation, swipe to remove.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SavedScreen(store: ChatStore, nav: ChatNavigator) {
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf(LoadState<List<ChatBookmark>>()) }
    var refreshing by remember { mutableStateOf(false) }
    val names = store.memberNames
    val dms = store.dms

    suspend fun load() {
        state = state.copy(loading = true)
        state = try {
            LoadState(data = store.repository.listBookmarks(ChatLogic.SAVED_CAP))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            LoadState(data = state.data, error = error)
        }
    }

    fun remove(bookmark: ChatBookmark) {
        state = state.copy(data = state.data?.filter { it.id != bookmark.id })
        store.env.scope.launch {
            try {
                store.repository.deleteBookmark(bookmark.id)
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
                title = { Text(stringResource(R.string.weldchat_saved_title)) },
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
            val bookmarks = state.data
            when {
                state.isFirstLoad -> CenteredProgress()
                bookmarks == null -> LoadErrorState(state.error, onRetry = { scope.launch { load() } })
                bookmarks.isEmpty() -> LazyColumn(Modifier.fillMaxSize()) {
                    item {
                        EmptyState(
                            stringResource(R.string.weldchat_saved_empty_title),
                            stringResource(R.string.weldchat_saved_empty_hint),
                            icon = { EmptyIcon(Icons.Outlined.BookmarkBorder) },
                        )
                    }
                }
                else -> LazyColumn(Modifier.fillMaxSize().tagged("saved-list")) {
                    items(bookmarks, key = { it.id }) { bookmark ->
                        val name = SavedRules.bookmarkConversation(bookmark, dms).text()
                        val isDm = bookmark.channelType == "dm"
                        SwipeActions(
                            start = emptyList(),
                            end = listOf(
                                SwipeAction(
                                    stringResource(R.string.weldchat_saved_remove),
                                    Icons.Filled.Delete,
                                    MaterialTheme.colorScheme.error,
                                    "saved-remove-${bookmark.id}",
                                ) { remove(bookmark) },
                            ),
                        ) {
                            Box(
                                Modifier
                                    .clickable { nav.openConversation(bookmark.channelId, name, bookmark.channelType) }
                                    .tagged("saved-row-${bookmark.id}"),
                            ) {
                                Column {
                                    SavedRow(bookmark, name, isDm, names)
                                    RowDivider()
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SavedRow(bookmark: ChatBookmark, name: String, isDm: Boolean, names: Map<String, String>) {
    // The platform's saved item: the author's avatar and name, the message,
    // the conversation (# or a DM) and when.
    val author = bookmark.messageAuthorName ?: stringResource(R.string.weldchat_saved_unknown_author)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        ChatAvatar(author, bookmark.messageAuthorAvatar, 28.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                Text(
                    author,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                WeldDate.parse(bookmark.createdAt)?.let { instant ->
                    Text(
                        instant.atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("d MMM", Locale.getDefault())),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Text(
                SavedRules.bookmarkText(bookmark, names).text(),
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 18.sp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(
                    if (isDm) Icons.AutoMirrored.Outlined.Chat else Icons.Filled.Tag,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(13.dp),
                )
                Text(name, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            bookmark.note?.takeIf { it.isNotEmpty() }?.let { note ->
                Text(
                    note,
                    style = MaterialTheme.typography.bodySmall,
                    fontStyle = FontStyle.Italic,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
