package com.weldsuite.weldmail.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.weldsuite.weldmail.MailMessage
import com.weldsuite.weldmail.MailStore
import com.weldsuite.weldmail.R
import com.weldsuite.weldmail.SearchFilters
import com.weldsuite.weldmail.SearchLogic
import com.weldsuite.weldmail.SystemLabel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/** The search filters' chips, in the Expo app's order. */
private enum class FilterKind(val label: Int) {
    LABEL(R.string.weldmail_search_filter_label),
    FROM(R.string.weldmail_search_filter_from),
    TO(R.string.weldmail_search_filter_to),
    ATTACHMENT(R.string.weldmail_search_filter_attachment),
    DATE(R.string.weldmail_search_filter_date),
    UNREAD(R.string.weldmail_search_filter_unread),
}

/** Search across every mailbox, on the server, with filters. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchScreen(store: MailStore, onOpen: (String) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var filters by remember { mutableStateOf(SearchFilters()) }
    var results by remember { mutableStateOf<List<MailMessage>>(emptyList()) }
    var cursor by remember { mutableStateOf<String?>(null) }
    var searching by remember { mutableStateOf(false) }
    var loadingMore by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<FilterKind?>(null) }
    val focus = remember { FocusRequester() }
    val scope = rememberCoroutineScope()
    val active = query.isNotBlank() || filters.isActive
    val shown = remember(results, filters) { SearchLogic.apply(results, filters, store.ownAddresses) }
    LaunchedEffect(shown) { store.visibleIds = shown.map { it.id } }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    LaunchedEffect(query, filters.label, filters.attachment, filters.unread) {
        cursor = null
        if (!active) {
            results = emptyList()
            return@LaunchedEffect
        }
        delay(250)
        searching = true
        try {
            val page = store.repository.messages(
                accountId = null,
                label = filters.label,
                search = query,
                unreadOnly = filters.unread,
                withAttachments = filters.attachment,
            )
            results = page.messages
            cursor = page.cursor
        } catch (_: Exception) {
            // Offline or refused: keep what was found.
        } finally {
            searching = false
        }
    }

    val listState = rememberLazyListState()
    val nearEnd by remember {
        derivedStateOf {
            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            last >= listState.layoutInfo.totalItemsCount - 8
        }
    }
    LaunchedEffect(nearEnd, cursor) {
        val next = cursor ?: return@LaunchedEffect
        if (!nearEnd || loadingMore) return@LaunchedEffect
        loadingMore = true
        try {
            val page = store.repository.messages(
                accountId = null,
                label = filters.label,
                search = query,
                unreadOnly = filters.unread,
                withAttachments = filters.attachment,
                cursor = next,
            )
            results = results + page.messages.filter { message -> results.none { it.id == message.id } }
            cursor = page.cursor
        } catch (_: Exception) {
            // The cursor stays: scrolling down again retries.
        } finally {
            loadingMore = false
        }
    }

    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            placeholder = { Text(stringResource(R.string.weldmail_search_placeholder)) },
            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
            trailingIcon = {
                if (query.isNotEmpty()) {
                    IconButton(onClick = { query = "" }) { Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.weldmail_search_clear)) }
                }
            },
            singleLine = true,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s)
                .focusRequester(focus)
                .tagged("search-input"),
        )
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
            modifier = Modifier.padding(horizontal = Tokens.Spacing.l),
        ) {
            items(FilterKind.entries) { kind ->
                val value = chosenLabel(kind, filters)
                FilterChip(
                    selected = value != null,
                    onClick = { editing = kind },
                    label = { Text(value ?: stringResource(kind.label)) },
                    modifier = Modifier.tagged("search-filter-${kind.name.lowercase()}"),
                )
            }
        }
        when {
            !active -> EmptyState(
                title = stringResource(R.string.weldmail_search_hint),
                icon = { Icon(Icons.Outlined.Search, contentDescription = null, modifier = Modifier.size(40.dp)) },
            )
            searching && results.isEmpty() -> Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            shown.isEmpty() -> EmptyState(
                title = stringResource(R.string.weldmail_search_no_results),
                description = stringResource(R.string.weldmail_search_no_results_hint),
            )
            else -> LazyColumn(state = listState, modifier = Modifier.fillMaxSize().tagged("search-results")) {
                items(shown, key = { it.id }) { message -> ResultRow(message, query) { onOpen(message.id) } }
                if (loadingMore) {
                    item { Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.l), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp)) } }
                }
            }
        }
    }

    editing?.let { kind ->
        ModalBottomSheet(onDismissRequest = { editing = null }) {
            Column(Modifier.navigationBarsPadding().padding(bottom = Tokens.Spacing.l)) {
                Row(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(kind.label), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    if (chosenLabel(kind, filters) != null) {
                        TextButton(onClick = {
                            filters = clear(kind, filters)
                            editing = null
                        }) { Text(stringResource(R.string.weldmail_search_clear_filter)) }
                    }
                }
                options(kind).forEach { (label, change) ->
                    val chosen = chosenLabel(kind, filters) == label
                    ListItem(
                        headlineContent = { Text(label) },
                        trailingContent = { if (chosen) Icon(Icons.Outlined.Check, contentDescription = null) },
                        modifier = Modifier.clickable {
                            scope.launch {
                                filters = change(filters)
                                editing = null
                            }
                        },
                    )
                }
            }
        }
    }
}

/** What a filter is set to, as its chip shows it; null when unset. */
@Composable
private fun chosenLabel(kind: FilterKind, filters: SearchFilters): String? = when (kind) {
    FilterKind.LABEL -> filters.label?.let { slug -> SystemLabel.of(slug)?.let { stringResource(if (it == SystemLabel.ALL) R.string.weldmail_search_all_emails else systemLabelName(it)) } }
    FilterKind.FROM -> filters.fromMe?.let { stringResource(if (it) R.string.weldmail_search_me else R.string.weldmail_search_anyone) }
    FilterKind.TO -> filters.toMe?.let { stringResource(if (it) R.string.weldmail_search_me else R.string.weldmail_search_anyone) }
    FilterKind.ATTACHMENT -> filters.attachment?.let { stringResource(if (it) R.string.weldmail_search_has_attachment else R.string.weldmail_search_no_attachment) }
    FilterKind.DATE -> filters.date?.let { stringResource(dateLabel(it)) }
    FilterKind.UNREAD -> filters.unread?.let { stringResource(if (it) R.string.weldmail_search_unread else R.string.weldmail_search_read) }
}

private fun dateLabel(range: SearchLogic.DateRange): Int = when (range) {
    SearchLogic.DateRange.TODAY -> R.string.weldmail_search_today
    SearchLogic.DateRange.YESTERDAY -> R.string.weldmail_search_yesterday
    SearchLogic.DateRange.THIS_WEEK -> R.string.weldmail_search_this_week
    SearchLogic.DateRange.THIS_MONTH -> R.string.weldmail_search_this_month
    SearchLogic.DateRange.THIS_YEAR -> R.string.weldmail_search_this_year
}

private fun clear(kind: FilterKind, filters: SearchFilters): SearchFilters = when (kind) {
    FilterKind.LABEL -> filters.copy(label = null)
    FilterKind.FROM -> filters.copy(fromMe = null)
    FilterKind.TO -> filters.copy(toMe = null)
    FilterKind.ATTACHMENT -> filters.copy(attachment = null)
    FilterKind.DATE -> filters.copy(date = null)
    FilterKind.UNREAD -> filters.copy(unread = null)
}

/** A filter's choices: their label and what choosing one does. */
@Composable
private fun options(kind: FilterKind): List<Pair<String, (SearchFilters) -> SearchFilters>> = when (kind) {
    FilterKind.LABEL -> SearchLogic.LABELS.map { system ->
        stringResource(if (system == SystemLabel.ALL) R.string.weldmail_search_all_emails else systemLabelName(system)) to { f: SearchFilters -> f.copy(label = system.slug) }
    }
    FilterKind.FROM -> listOf(
        stringResource(R.string.weldmail_search_me) to { f: SearchFilters -> f.copy(fromMe = true) },
        stringResource(R.string.weldmail_search_anyone) to { f: SearchFilters -> f.copy(fromMe = false) },
    )
    FilterKind.TO -> listOf(
        stringResource(R.string.weldmail_search_me) to { f: SearchFilters -> f.copy(toMe = true) },
        stringResource(R.string.weldmail_search_anyone) to { f: SearchFilters -> f.copy(toMe = false) },
    )
    FilterKind.ATTACHMENT -> listOf(
        stringResource(R.string.weldmail_search_has_attachment) to { f: SearchFilters -> f.copy(attachment = true) },
        stringResource(R.string.weldmail_search_no_attachment) to { f: SearchFilters -> f.copy(attachment = false) },
    )
    FilterKind.DATE -> SearchLogic.DateRange.entries.map { range -> stringResource(dateLabel(range)) to { f: SearchFilters -> f.copy(date = range) } }
    FilterKind.UNREAD -> listOf(
        stringResource(R.string.weldmail_search_unread) to { f: SearchFilters -> f.copy(unread = true) },
        stringResource(R.string.weldmail_search_read) to { f: SearchFilters -> f.copy(unread = false) },
    )
}

@Composable
private fun ResultRow(message: MailMessage, query: String, onOpen: () -> Unit) {
    val sender = message.senderName ?: stringResource(R.string.weldmail_common_unknown)
    val highlight = MaterialTheme.colorScheme.primary
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onOpen)
            .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m)
            .tagged("search-result"),
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        SenderAvatar(sender)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    highlighted(sender, query, highlight),
                    fontWeight = if (message.isRead) FontWeight.Normal else FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(rowTime(message.listDate), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (message.hasAttachments) Icon(Icons.Outlined.AttachFile, contentDescription = null, modifier = Modifier.size(14.dp))
                if (message.isStarred) Icon(Icons.Filled.Star, contentDescription = null, tint = MailColors.star, modifier = Modifier.size(14.dp))
            }
            Text(
                highlighted(message.subject?.takeIf { it.isNotBlank() } ?: stringResource(R.string.weldmail_common_no_subject), query, highlight),
                fontWeight = if (message.isRead) FontWeight.Normal else FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                highlighted(message.preview.orEmpty(), query, highlight),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
}

/** The text with every match of the query (any case) emphasised. */
private fun highlighted(text: String, query: String, color: Color): AnnotatedString = buildAnnotatedString {
    val ranges = SearchLogic.matches(text, query)
    var at = 0
    for (range in ranges) {
        append(text.substring(at, range.first))
        withStyle(SpanStyle(color = color, fontWeight = FontWeight.Bold)) { append(text.substring(range.first, range.last + 1)) }
        at = range.last + 1
    }
    append(text.substring(at))
}
