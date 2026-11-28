package com.weldsuite.welddesk.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.SwapVert
import androidx.compose.material3.AssistChip
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.weldsuite.welddesk.AssigneeFilter
import com.weldsuite.welddesk.Conversation
import com.weldsuite.welddesk.ConversationState
import com.weldsuite.welddesk.DeskChannel
import com.weldsuite.welddesk.DeskLogic
import com.weldsuite.welddesk.DeskRepository
import com.weldsuite.welddesk.InboxQuery
import com.weldsuite.welddesk.InboxSort
import com.weldsuite.welddesk.R
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.WeldDate
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.RealtimeRefresh
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/** The hub topics that change the inbox: the entity topics, and the legacy `helpdesk` one. */
val INBOX_TOPICS = listOf("helpdesk", "desk_conversation", "desk_message", "helpdesk_conversation", "helpdesk_conversation_message")

data class InboxUiState(
    val query: InboxQuery = InboxQuery(),
    /** What is in the search field; [InboxQuery.search] follows it after a pause. */
    val searchText: String = "",
    val items: List<Conversation> = emptyList(),
    /** Nothing shown yet for these filters. */
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val loadingMore: Boolean = false,
    /** The next page didn't load; the list offers to try again. */
    val loadMoreFailed: Boolean = false,
    val error: Throwable? = null,
    val hasMore: Boolean = false,
    val cursor: String? = null,
)

/** The agent inbox: filters, search, pages, and a silent reload when something changes. */
class InboxViewModel(private val repository: DeskRepository, private val userId: String?) : ViewModel() {
    private val stateFlow = MutableStateFlow(InboxUiState())
    val state: StateFlow<InboxUiState> = stateFlow.asStateFlow()

    /** Bumped by every load from the first page: an older answer is dropped. */
    private var generation = 0
    private var search: Job? = null

    init {
        load(reset = true)
    }

    fun setState(value: ConversationState) = setQuery(stateFlow.value.query.copy(state = value))

    fun setAssignee(value: AssigneeFilter) = setQuery(stateFlow.value.query.copy(assignee = value))

    fun cycleSort() = setQuery(stateFlow.value.query.copy(sort = stateFlow.value.query.sort.next()))

    fun setSearch(text: String) {
        stateFlow.update { it.copy(searchText = text) }
        search?.cancel()
        search = viewModelScope.launch {
            delay(DeskLogic.SEARCH_DEBOUNCE_MS)
            val trimmed = text.trim()
            if (trimmed != stateFlow.value.query.search) setQuery(stateFlow.value.query.copy(search = trimmed))
        }
    }

    /** Pull to refresh: the first page again, the list stays while it loads. */
    fun refresh() {
        stateFlow.update { it.copy(refreshing = true) }
        load(reset = false)
    }

    /** Something changed (realtime, back from a thread): the first page, quietly. */
    fun reload() = load(reset = false)

    fun retry() = load(reset = true)

    private var appearedBefore = false

    /** The inbox is on screen again (back from a thread): reload quietly, as assignees and states may have changed. */
    fun appeared() {
        if (appearedBefore) reload() else appearedBefore = true
    }

    fun loadMore() {
        val current = stateFlow.value
        val cursor = current.cursor
        if (!current.hasMore || current.loadingMore || current.loading || cursor == null) return
        stateFlow.update { it.copy(loadingMore = true, loadMoreFailed = false) }
        val forGeneration = generation
        viewModelScope.launch {
            val result = runCatching { repository.inbox(DeskLogic.inboxRequest(current.query, userId), cursor) }
            if (forGeneration != generation) return@launch
            result
                .onSuccess { page ->
                    stateFlow.update { state ->
                        val known = state.items.map { it.id }.toSet()
                        state.copy(
                            items = state.items + page.items.filter { it.id !in known },
                            hasMore = page.hasMore,
                            cursor = page.cursor,
                            loadingMore = false,
                        )
                    }
                }
                .onFailure { stateFlow.update { it.copy(loadingMore = false, loadMoreFailed = true) } }
        }
    }

    private fun setQuery(query: InboxQuery) {
        if (query == stateFlow.value.query) return
        stateFlow.update { it.copy(query = query) }
        load(reset = true)
    }

    private fun load(reset: Boolean) {
        val forGeneration = ++generation
        val query = stateFlow.value.query
        if (reset) stateFlow.update { it.copy(items = emptyList(), loading = true, error = null, hasMore = false, cursor = null) }
        viewModelScope.launch {
            val result = runCatching { repository.inbox(DeskLogic.inboxRequest(query, userId), null) }
            if (forGeneration != generation) return@launch
            result
                .onSuccess { page ->
                    stateFlow.update {
                        it.copy(
                            items = page.items,
                            hasMore = page.hasMore,
                            cursor = page.cursor,
                            loading = false,
                            refreshing = false,
                            loadingMore = false,
                            error = null,
                        )
                    }
                }
                .onFailure { error -> stateFlow.update { it.copy(loading = false, refreshing = false, loadingMore = false, error = error) } }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(env: AppEnvironment, model: InboxViewModel, onOpen: (String) -> Unit) {
    val state by model.state.collectAsStateWithLifecycle()
    RealtimeRefresh(env, INBOX_TOPICS) { model.reload() }
    LaunchedEffect(model) { model.appeared() }

    Scaffold(
        topBar = { TopAppBar(title = { Text(stringResource(R.string.welddesk_inbox_title)) }) },
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            InboxFilters(state, model)
            when {
                state.loading && state.items.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.tagged("inbox-loading"))
                }
                state.error != null && state.items.isEmpty() -> DeskLoadError(stringResource(R.string.welddesk_inbox_load_error), state.error, onRetry = model::retry)
                else -> InboxList(state, model, onOpen)
            }
        }
    }
}

@Composable
private fun InboxFilters(state: InboxUiState, model: InboxViewModel) {
    Column(
        Modifier.padding(horizontal = Tokens.Spacing.l).padding(bottom = Tokens.Spacing.s),
        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        OutlinedTextField(
            value = state.searchText,
            onValueChange = model::setSearch,
            placeholder = { Text(stringResource(R.string.welddesk_inbox_search_placeholder), maxLines = 1, overflow = TextOverflow.Ellipsis) },
            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
            trailingIcon = if (state.searchText.isNotEmpty()) {
                {
                    IconButton(onClick = { model.setSearch("") }, modifier = Modifier.tagged("inbox-search-clear")) {
                        Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.welddesk_inbox_search_clear))
                    }
                }
            } else {
                null
            },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().tagged("inbox-search"),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            FilterChip(
                selected = state.query.state == ConversationState.OPEN,
                onClick = { model.setState(ConversationState.OPEN) },
                label = { Text(stringResource(R.string.welddesk_inbox_open)) },
                modifier = Modifier.tagged("filter-open"),
            )
            FilterChip(
                selected = state.query.state == ConversationState.CLOSED,
                onClick = { model.setState(ConversationState.CLOSED) },
                label = { Text(stringResource(R.string.welddesk_inbox_closed)) },
                modifier = Modifier.tagged("filter-closed"),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s), verticalAlignment = Alignment.CenterVertically) {
            AssigneeChip(state, AssigneeFilter.ALL, R.string.welddesk_inbox_all, "filter-all", model)
            AssigneeChip(state, AssigneeFilter.MINE, R.string.welddesk_inbox_mine, "filter-mine", model)
            AssigneeChip(state, AssigneeFilter.UNASSIGNED, R.string.welddesk_inbox_unassigned, "filter-unassigned", model)
            val sortLabel = stringResource(sortLabel(state.query.sort))
            val sortHint = stringResource(R.string.welddesk_inbox_sort_hint, sortLabel)
            AssistChip(
                onClick = model::cycleSort,
                label = { Text(sortLabel) },
                leadingIcon = { Icon(Icons.Outlined.SwapVert, contentDescription = null, modifier = Modifier.size(18.dp)) },
                modifier = Modifier.semantics { contentDescription = sortHint }.tagged("inbox-sort"),
            )
        }
    }
}

@Composable
private fun AssigneeChip(state: InboxUiState, value: AssigneeFilter, label: Int, tag: String, model: InboxViewModel) {
    FilterChip(
        selected = state.query.assignee == value,
        onClick = { model.setAssignee(value) },
        label = { Text(stringResource(label)) },
        modifier = Modifier.tagged(tag),
    )
}

fun sortLabel(sort: InboxSort): Int = when (sort) {
    InboxSort.NEWEST -> R.string.welddesk_inbox_newest
    InboxSort.OLDEST -> R.string.welddesk_inbox_oldest
    InboxSort.WAITING_LONGEST -> R.string.welddesk_inbox_waiting_longest
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun InboxList(state: InboxUiState, model: InboxViewModel, onOpen: (String) -> Unit) {
    val listState = rememberLazyListState()
    // Near the end of what's loaded: the next page.
    LaunchedEffect(listState, state.items.size) {
        snapshotFlow {
            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            last >= listState.layoutInfo.totalItemsCount - 5
        }
            .distinctUntilChanged()
            .collect { nearEnd -> if (nearEnd) model.loadMore() }
    }
    PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = model::refresh, modifier = Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize().tagged("conversation-list"), state = listState) {
            if (state.items.isEmpty()) {
                item {
                    val searching = state.query.search.isNotEmpty()
                    val title = when {
                        searching -> R.string.welddesk_inbox_no_results
                        state.query.state == ConversationState.OPEN -> R.string.welddesk_inbox_empty_open
                        else -> R.string.welddesk_inbox_empty_closed
                    }
                    EmptyState(
                        title = stringResource(title),
                        description = stringResource(if (searching) R.string.welddesk_inbox_no_results_hint else R.string.welddesk_inbox_empty_hint),
                        icon = { Icon(Icons.Outlined.Inbox, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(40.dp)) },
                        modifier = Modifier.tagged("inbox-empty"),
                    )
                }
            }
            items(state.items, key = { it.id }) { conversation ->
                ConversationRow(conversation) { onOpen(conversation.id) }
            }
            if (state.loadMoreFailed) {
                item {
                    TextButton(onClick = model::loadMore, modifier = Modifier.fillMaxWidth().tagged("inbox-load-more")) {
                        Text(stringResource(R.string.welddesk_inbox_load_more_error))
                    }
                }
            }
            if (state.loadingMore) {
                item {
                    Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.l), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(24.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun ConversationRow(conversation: Conversation, onClick: () -> Unit) {
    val brand = Tokens.Brand.welddesk.current()
    val waiting = conversation.isWaiting
    val title = DeskLogic.rowTitle(conversation) ?: stringResource(R.string.welddesk_inbox_no_subject)
    val meta = if (waiting) stringResource(R.string.welddesk_inbox_waiting) else DeskLogic.numberLabel(conversation)
    ListItem(
        overlineContent = {
            Text(
                meta,
                color = if (waiting) brand else MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        headlineContent = {
            Text(
                title,
                fontWeight = if (waiting) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        supportingContent = {
            Text(DeskLogic.rowSubtitle(conversation), maxLines = 1, overflow = TextOverflow.Ellipsis)
        },
        leadingContent = { ChannelTile(conversation.channel) },
        trailingContent = {
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs)) {
                DeskLogic.rowTime(conversation)?.let { Text(WeldDate.short(it), style = MaterialTheme.typography.labelSmall) }
                ChannelBadge(conversation)
                if (waiting) Box(Modifier.size(8.dp).background(brand, CircleShape))
            }
        },
        modifier = Modifier.clickable(onClick = onClick).tagged("conversation-${conversation.number}"),
    )
}

/** The channel's icon on a tinted tile: email in teal, chat and the rest in violet. */
@Composable
fun ChannelTile(channel: DeskChannel) {
    val (icon: ImageVector, color: Color) = if (channel == DeskChannel.EMAIL) {
        Icons.Outlined.Email to Color(0xFF0F766E)
    } else {
        Icons.AutoMirrored.Outlined.Chat to Color(0xFF8B5CF6)
    }
    Box(
        Modifier.size(40.dp).background(color.copy(alpha = 0.12f), RoundedCornerShape(Tokens.Radius.medium)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(20.dp))
    }
}

/** Remembers the inbox's model for the person, across tab switches. */
@Composable
fun rememberInboxModel(repository: DeskRepository, userId: String?): InboxViewModel =
    androidx.lifecycle.viewmodel.compose.viewModel(key = "inbox-$userId") { InboxViewModel(repository, userId) }

