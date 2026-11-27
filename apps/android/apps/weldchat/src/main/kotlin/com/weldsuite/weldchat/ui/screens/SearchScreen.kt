package com.weldsuite.weldchat.ui.screens

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Audiotrack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Gif
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.MentionText
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.RecentSearches
import com.weldsuite.weldchat.SearchHitItem
import com.weldsuite.weldchat.SearchTab
import com.weldsuite.weldchat.TeamMember
import com.weldsuite.weldchat.text
import com.weldsuite.weldchat.ui.ChatAvatar
import com.weldsuite.weldchat.ui.ChatNavigator
import com.weldsuite.weldchat.ui.ListHeader
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import org.weldsuite.core.WeldDate
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import org.weldsuite.core.R as CoreR

/**
 * Search: messages across the workspace (and people), with WhatsApp-style
 * tabs that narrow the results to photos, videos, links, GIFs, audio or
 * documents. Recent searches stay on the device.
 */
@Composable
fun SearchScreen(store: ChatStore, nav: ChatNavigator) {
    val context = LocalContext.current
    val preferences = remember { context.getSharedPreferences(RecentSearchStore.PREFERENCES, Context.MODE_PRIVATE) }
    var query by rememberSaveable { mutableStateOf("") }
    var tab by rememberSaveable { mutableStateOf(SearchTab.ALL) }
    var hits by remember { mutableStateOf<List<SearchHitItem>>(emptyList()) }
    var people by remember { mutableStateOf<List<TeamMember>>(emptyList()) }
    var searched by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var recent by remember { mutableStateOf(RecentSearchStore.load(preferences)) }
    val focus = remember { FocusRequester() }
    val names = store.memberNames

    fun setRecent(list: List<String>) {
        recent = list
        RecentSearchStore.save(preferences, list)
    }

    // Typing pauses 400 ms before the search runs; a search that answered goes to the recent searches.
    LaunchedEffect(query, tab) {
        val text = query.trim()
        if (text.isEmpty()) {
            hits = emptyList()
            people = emptyList()
            searched = false
            loading = false
            return@LaunchedEffect
        }
        delay(SearchRules.DEBOUNCE_MS)
        loading = true
        var succeeded = true
        if (tab == SearchTab.PEOPLE) {
            store.loadRosterIfNeeded()
            people = SearchRules.people(store.roster, text)
            hits = emptyList()
            succeeded = store.roster.isNotEmpty()
        } else {
            try {
                hits = store.repository.search(text)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                hits = emptyList()
                succeeded = false
            }
            people = emptyList()
        }
        loading = false
        searched = true
        if (succeeded) setRecent(RecentSearches.adding(text, recent))
    }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    val trimmed = query.trim()
    val results = SearchRules.results(hits, tab)
    val hasResults = if (tab == SearchTab.PEOPLE) people.isNotEmpty() else results.isNotEmpty()
    val showEmpty = searched && !loading && !hasResults && trimmed.isNotEmpty()

    Scaffold(
        topBar = {
            Column(Modifier.statusBarsPadding()) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                ) {
                    ChatSearchField(
                        placeholder = stringResource(R.string.weldchat_search_placeholder),
                        text = query,
                        onTextChange = { query = it },
                        tag = "search-input",
                        modifier = Modifier.weight(1f),
                        focusRequester = focus,
                    )
                    TextButton(onClick = { nav.back() }, modifier = Modifier.tagged("search-cancel")) {
                        Text(stringResource(CoreR.string.core_common_cancel))
                    }
                }
                Row(
                    Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = Tokens.Spacing.l).padding(bottom = Tokens.Spacing.s),
                    horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                ) {
                    SearchTab.entries.forEach { option ->
                        val icon = tabIcon(option)
                        FilterChip(
                            selected = tab == option,
                            onClick = {
                                tab = option
                                searched = false
                            },
                            label = { Text(stringResource(option.label)) },
                            leadingIcon = if (icon != null) {
                                { Icon(icon, contentDescription = null, modifier = Modifier.size(16.dp)) }
                            } else {
                                null
                            },
                            modifier = Modifier.tagged("search-tab-${option.key}"),
                        )
                    }
                }
                HorizontalDivider()
            }
        },
    ) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize().tagged("search-list")) {
            when {
                !searched && trimmed.isEmpty() -> {
                    if (recent.isEmpty()) {
                        item("idle") {
                            EmptyState(
                                stringResource(R.string.weldchat_search_idle_title),
                                stringResource(R.string.weldchat_search_idle_hint),
                                icon = { Icon(Icons.Filled.Search, contentDescription = null, modifier = Modifier.size(40.dp)) },
                            )
                        }
                    } else {
                        item("recent-header") {
                            ListHeader(stringResource(R.string.weldchat_search_recent_searches)) {
                                TextButton(onClick = { setRecent(emptyList()) }, modifier = Modifier.tagged("search-clear-recent")) {
                                    Text(stringResource(R.string.weldchat_search_clear_all))
                                }
                            }
                        }
                        itemsIndexed(recent, key = { _, term -> "recent-$term" }) { index, term ->
                            Row(
                                Modifier.fillMaxWidth().clickable { query = term }.tagged("search-recent-$index").padding(start = Tokens.Spacing.l),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
                            ) {
                                Icon(Icons.Filled.History, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text(term, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                IconButton(onClick = { setRecent(recent.filter { it != term }) }) {
                                    Icon(
                                        Icons.Filled.Close,
                                        contentDescription = stringResource(R.string.weldchat_search_remove_recent, term),
                                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.size(18.dp),
                                    )
                                }
                            }
                        }
                    }
                }
                loading && !hasResults -> item("loading") {
                    Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.xl), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                }
                tab == SearchTab.PEOPLE -> {
                    items(people, key = { "person-${it.userId}" }) { member ->
                        PersonResult(member) { nav.openMember(member.userId) }
                    }
                    if (showEmpty) {
                        item("empty") {
                            EmptyState(
                                stringResource(R.string.weldchat_search_no_people),
                                icon = { Icon(Icons.Filled.People, contentDescription = null, modifier = Modifier.size(40.dp)) },
                            )
                        }
                    }
                }
                else -> {
                    items(results, key = { "hit-${it.id}" }) { hit ->
                        MessageResult(hit, names) { nav.openConversation(hit.channelId, hit.channelName, hit.channelType) }
                    }
                    if (showEmpty) {
                        item("empty") {
                            EmptyState(
                                stringResource(R.string.weldchat_search_no_results),
                                stringResource(R.string.weldchat_search_no_results_hint),
                                icon = { Icon(Icons.Filled.Search, contentDescription = null, modifier = Modifier.size(40.dp)) },
                            )
                        }
                    }
                }
            }
        }
    }
}

private fun tabIcon(tab: SearchTab): ImageVector? = when (tab) {
    SearchTab.ALL -> null
    SearchTab.PEOPLE -> Icons.Filled.People
    SearchTab.PHOTOS -> Icons.Filled.Image
    SearchTab.VIDEOS -> Icons.Filled.Videocam
    SearchTab.LINKS -> Icons.Filled.Link
    SearchTab.GIFS -> Icons.Filled.Gif
    SearchTab.AUDIO -> Icons.Filled.Audiotrack
    SearchTab.DOCS -> Icons.Filled.Description
}

@Composable
private fun PersonResult(member: TeamMember, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .tagged("search-person-${member.userId}")
            .padding(horizontal = Tokens.Spacing.l, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        ChatAvatar(member.displayName, member.picture, 36.dp)
        Column(Modifier.weight(1f)) {
            Text(member.displayName, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val email = member.email
            if (!email.isNullOrEmpty() && member.name != null) {
                Text(email, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun MessageResult(hit: SearchHitItem, names: Map<String, String>, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .tagged("search-result-${hit.id}")
            .padding(horizontal = Tokens.Spacing.l, vertical = 10.dp),
    ) {
        val quiet = MaterialTheme.colorScheme.onSurfaceVariant
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Icon(if (hit.channelType == "dm") Icons.AutoMirrored.Filled.Chat else Icons.Filled.Tag, contentDescription = null, tint = quiet, modifier = Modifier.size(12.dp))
            Text(
                hit.channelName?.takeIf { it.isNotEmpty() } ?: stringResource(R.string.weldchat_search_unknown_channel),
                style = MaterialTheme.typography.labelSmall,
                color = quiet,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            WeldDate.parse(hit.createdAt)?.let { instant ->
                Text(
                    instant.atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("d MMM", Locale.getDefault())),
                    style = MaterialTheme.typography.labelSmall,
                    color = quiet,
                )
            }
        }
        Text(
            hit.authorName ?: stringResource(R.string.weldchat_saved_unknown_author),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        val text = MentionText.plainText(hit.content, names).trim()
        if (text.isNotEmpty()) {
            Text(text, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        SearchRules.attachmentLabel(hit)?.let { label ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(Icons.Filled.AttachFile, contentDescription = null, tint = quiet, modifier = Modifier.size(12.dp))
                Text(label.text(), style = MaterialTheme.typography.labelSmall, color = quiet, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
