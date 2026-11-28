package com.weldsuite.welddesk.ui

import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.SwapVert
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.weldsuite.welddesk.AssigneeFilter
import com.weldsuite.welddesk.Conversation
import com.weldsuite.welddesk.ConversationState
import com.weldsuite.welddesk.DeskChannel
import com.weldsuite.welddesk.DeskLogic
import com.weldsuite.welddesk.DeskLogic.DateGroup
import com.weldsuite.welddesk.DeskLogic.RowBadge
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
import org.weldsuite.ui.RealtimeRefresh
import org.weldsuite.ui.StatusBadge
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.format.TextStyle
import java.util.Locale

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
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            when {
                state.loading && state.items.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(
                        Modifier.size(20.dp).tagged("inbox-loading"),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        strokeWidth = 2.dp,
                    )
                }
                state.error != null && state.items.isEmpty() -> DeskLoadError(stringResource(R.string.welddesk_inbox_load_error), state.error, onRetry = model::retry)
                else -> InboxList(state, model, onOpen)
            }
        }
    }
}

/** Search, then the platform's filter toggles: open or closed and the sort, then whose. */
@Composable
private fun InboxFilters(state: InboxUiState, model: InboxViewModel) {
    Column(
        Modifier.padding(horizontal = Tokens.Spacing.l).padding(bottom = Tokens.Spacing.m),
        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        DeskSearchField(
            value = state.searchText,
            onValueChange = model::setSearch,
            placeholder = stringResource(R.string.welddesk_inbox_search_placeholder),
            clearLabel = stringResource(R.string.welddesk_inbox_search_clear),
            modifier = Modifier.fillMaxWidth(),
            tag = "inbox-search",
            clearTag = "inbox-search-clear",
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            DeskToggle(stringResource(R.string.welddesk_inbox_open), state.query.state == ConversationState.OPEN, "filter-open") {
                model.setState(ConversationState.OPEN)
            }
            DeskToggle(stringResource(R.string.welddesk_inbox_closed), state.query.state == ConversationState.CLOSED, "filter-closed") {
                model.setState(ConversationState.CLOSED)
            }
            Spacer(Modifier.weight(1f))
            val sortLabel = stringResource(sortLabel(state.query.sort))
            val sortHint = stringResource(R.string.welddesk_inbox_sort_hint, sortLabel)
            DeskOutlineChip(
                sortLabel,
                Icons.Outlined.SwapVert,
                modifier = Modifier.semantics { contentDescription = sortHint }.tagged("inbox-sort"),
                onClick = model::cycleSort,
            )
        }
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            AssigneeToggle(state, AssigneeFilter.ALL, R.string.welddesk_inbox_all, "filter-all", model)
            AssigneeToggle(state, AssigneeFilter.MINE, R.string.welddesk_inbox_mine, "filter-mine", model)
            AssigneeToggle(state, AssigneeFilter.UNASSIGNED, R.string.welddesk_inbox_unassigned, "filter-unassigned", model)
        }
    }
}

@Composable
private fun AssigneeToggle(state: InboxUiState, value: AssigneeFilter, label: Int, tag: String, model: InboxViewModel) {
    DeskToggle(stringResource(label), state.query.assignee == value, tag) { model.setAssignee(value) }
}

fun sortLabel(sort: InboxSort): Int = when (sort) {
    InboxSort.NEWEST -> R.string.welddesk_inbox_newest
    InboxSort.OLDEST -> R.string.welddesk_inbox_oldest
    InboxSort.WAITING_LONGEST -> R.string.welddesk_inbox_waiting_longest
}

/** The current time, read again every 30 seconds, so SLA countdowns move without a reload. */
@Composable
fun rememberNow(intervalMillis: Long = 30_000): Instant {
    val now by produceState(Instant.now()) {
        while (true) {
            delay(intervalMillis)
            value = Instant.now()
        }
    }
    return now
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
    val now = rememberNow()
    val zone = remember { ZoneId.systemDefault() }
    val groups = remember(state.items, now.epochSecond / 3600) { DeskLogic.groupByDate(state.items, now, zone) }
    PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = model::refresh, modifier = Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize().tagged("conversation-list"), state = listState) {
            if (state.items.isEmpty()) {
                item {
                    val searching = state.query.search.isNotEmpty()
                    DeskEmptyState(
                        icon = if (searching) Icons.Outlined.Search else Icons.Outlined.Inbox,
                        title = stringResource(if (searching) R.string.welddesk_inbox_no_results else R.string.welddesk_inbox_empty),
                        description = stringResource(if (searching) R.string.welddesk_inbox_no_results_hint else R.string.welddesk_inbox_empty_description),
                        modifier = Modifier.tagged("inbox-empty"),
                    )
                }
            }
            groups.forEach { (group, conversations) ->
                if (group != DateGroup.Today) {
                    item(key = "group-$group") { GroupHeader(groupLabel(group), conversations.size) }
                }
                items(conversations, key = { it.id }) { conversation ->
                    ConversationRow(conversation, now, zone) { onOpen(conversation.id) }
                }
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
                        CircularProgressIndicator(Modifier.size(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant, strokeWidth = 2.dp)
                    }
                }
            }
        }
    }
}

/** The phone's language, as the app shows it. */
@Composable
fun appLocale(): Locale = LocalConfiguration.current.locales[0] ?: Locale.getDefault()

/** A date group's header text, in the phone's language. */
@Composable
private fun groupLabel(group: DateGroup): String {
    val locale = appLocale()
    return when (group) {
        DateGroup.Today -> stringResource(org.weldsuite.core.R.string.core_common_today)
        DateGroup.Yesterday -> stringResource(org.weldsuite.core.R.string.core_common_yesterday)
        is DateGroup.Weekday -> group.day.getDisplayName(TextStyle.FULL_STANDALONE, locale).replaceFirstChar { it.titlecase(locale) }
        DateGroup.LastWeek -> stringResource(R.string.welddesk_inbox_last_week)
        is DateGroup.WeeksAgo -> stringResource(R.string.welddesk_inbox_weeks_ago, group.weeks)
        is DateGroup.Month -> DateTimeFormatter.ofPattern(if (group.withYear) "LLLL yyyy" else "LLLL", locale)
            .format(group.month)
            .replaceFirstChar { it.titlecase(locale) }
        is DateGroup.Later -> DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, "MMMMd"), locale).format(group.day)
    }
}

/** A row's date, as the platform's list: the time today, else the day (with the year once it isn't this year's). */
fun listDate(at: Instant, now: Instant, zone: ZoneId, locale: Locale): String {
    val date = at.atZone(zone)
    val today = now.atZone(zone).toLocalDate()
    return when {
        date.toLocalDate() == today -> date.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale))
        date.year == today.year -> date.format(DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, "MMMd"), locale))
        else -> date.format(DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, "MMMdyyyy"), locale))
    }
}

/**
 * One conversation, as the platform's list item: the customer's avatar (a
 * blue dot beside it while they wait for an answer), their name and the
 * date, the subject, the last message, and the badges.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ConversationRow(conversation: Conversation, now: Instant, zone: ZoneId, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val unread = conversation.isWaiting
    val name = DeskLogic.rowTitle(conversation) ?: stringResource(R.string.welddesk_inbox_no_subject)
    val locale = appLocale()
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).tagged("conversation-${conversation.number}")) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.m, vertical = Tokens.Spacing.m),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(Modifier.padding(top = 3.dp)) {
                InitialAvatar(name, size = 28.dp)
                if (unread) {
                    Box(
                        Modifier
                            .align(Alignment.CenterStart)
                            .offset(x = (-10).dp)
                            .size(6.dp)
                            .background(DeskColors.unread, CircleShape),
                    )
                }
            }
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                    Text(
                        name,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Medium,
                        color = if (unread) colors.onSurface else colors.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    DeskLogic.rowTime(conversation)?.let {
                        Text(listDate(it, now, zone, locale), fontSize = 11.5.sp, lineHeight = 16.sp, color = colors.onSurfaceVariant, maxLines = 1)
                    }
                }
                Text(
                    DeskLogic.rowSubject(conversation),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (unread) FontWeight.Medium else FontWeight.Normal,
                    color = if (unread) colors.onSurface else colors.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 1.dp),
                )
                val preview = DeskLogic.rowSubtitle(conversation)
                if (preview.isNotEmpty()) {
                    Text(
                        preview,
                        fontSize = 13.sp,
                        lineHeight = 18.sp,
                        color = colors.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
                val badges = DeskLogic.rowBadges(conversation, now)
                if (badges.isNotEmpty()) {
                    FlowRow(
                        Modifier.padding(top = Tokens.Spacing.s),
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs),
                        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs),
                    ) {
                        badges.take(DeskLogic.MAX_ROW_BADGES).forEach { badge ->
                            val (text, color) = rowBadge(badge)
                            StatusBadge(text, color)
                        }
                        if (badges.size > DeskLogic.MAX_ROW_BADGES) {
                            Text(
                                "+${badges.size - DeskLogic.MAX_ROW_BADGES}",
                                fontSize = 10.sp,
                                color = colors.onSurfaceVariant,
                                modifier = Modifier.align(Alignment.CenterVertically),
                            )
                        }
                    }
                }
            }
        }
        HorizontalDivider(color = colors.outlineVariant)
    }
}

/** A row badge's text and the platform's colour for it. */
@Composable
private fun rowBadge(badge: RowBadge): Pair<String, Color> = when (badge) {
    is RowBadge.Sla -> slaText(badge.display.label) to slaColor(badge.display.tone)
    is RowBadge.Priority -> priorityName(badge.priority) to if (badge.priority == "urgent") DeskColors.urgent else DeskColors.high
    is RowBadge.Tag -> badge.tag to DeskColors.tag
    is RowBadge.Channel -> channelName(badge.channel, badge.channel.value) to when (badge.channel) {
        DeskChannel.EMAIL -> DeskColors.email
        DeskChannel.PHONE -> DeskColors.phone
        DeskChannel.PORTAL -> DeskColors.portal
        else -> DeskColors.api
    }
    RowBadge.Unassigned -> stringResource(R.string.welddesk_inbox_unassigned_badge) to DeskColors.unassigned
    RowBadge.Waiting -> stringResource(R.string.welddesk_inbox_waiting_badge) to DeskColors.waiting
}

/** The list's colour for an SLA tone. */
fun slaColor(tone: DeskLogic.SlaTone): Color = when (tone) {
    DeskLogic.SlaTone.OK -> DeskColors.slaOk
    DeskLogic.SlaTone.WARNING -> DeskColors.slaWarning
    DeskLogic.SlaTone.BREACHED -> DeskColors.slaBreached
    DeskLogic.SlaTone.MUTED -> DeskColors.slaMuted
}

/** An SLA target's name: first response, next response, resolution. */
@Composable
fun slaMetricName(metric: String): String = when (metric) {
    "first_response" -> stringResource(R.string.welddesk_sla_first_response)
    "next_response" -> stringResource(R.string.welddesk_sla_next_response)
    "resolution" -> stringResource(R.string.welddesk_sla_resolution)
    else -> "SLA"
}

@Composable
fun slaText(label: DeskLogic.SlaLabel): String = when (label) {
    is DeskLogic.SlaLabel.DueIn -> stringResource(R.string.welddesk_sla_due_in, slaMetricName(label.metric), label.time)
    is DeskLogic.SlaLabel.Overdue -> stringResource(R.string.welddesk_sla_overdue, slaMetricName(label.metric), label.time)
    DeskLogic.SlaLabel.Breached -> stringResource(R.string.welddesk_sla_breached)
    DeskLogic.SlaLabel.Paused -> stringResource(R.string.welddesk_sla_paused)
    DeskLogic.SlaLabel.Achieved -> stringResource(R.string.welddesk_sla_achieved)
}

/** urgent, high, medium, low in the platform's words; another value as it is. */
@Composable
fun priorityName(priority: String): String = when (priority) {
    "urgent" -> stringResource(R.string.welddesk_priority_urgent)
    "high" -> stringResource(R.string.welddesk_priority_high)
    "medium" -> stringResource(R.string.welddesk_priority_medium)
    "low" -> stringResource(R.string.welddesk_priority_low)
    else -> priority
}

/** Remembers the inbox's model for the person, across tab switches. */
@Composable
fun rememberInboxModel(repository: DeskRepository, userId: String?): InboxViewModel =
    androidx.lifecycle.viewmodel.compose.viewModel(key = "inbox-$userId") { InboxViewModel(repository, userId) }
